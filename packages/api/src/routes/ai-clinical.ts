import { env, getObject } from "@evolu/config";
import {
  CreateReport,
  NOTE_SECTIONS,
  NoteContent,
  ReviewExtraction,
  SCRIBE_MODES,
  StructureTranscript,
  UpdateReport,
} from "@evolu/contracts";
import { localDayBounds, localYmd } from "@evolu/domain";
import type { Tx } from "@evolu/database";
import { aiApiError, loadAiConfig, runChat, runJson, runTranscription, sniffAudio, type AiConfig } from "../ai";
import { listModels, type ChatPart } from "../ai/openrouter";
import {
  BRIEF_SYSTEM,
  BriefOutput,
  EXTRACTION_SYSTEM,
  ExtractionOutput,
  REVIEW_SYSTEM,
  ReviewOutput,
  ScribeOutput,
  TaskSuggestions,
  draftForReview,
  noteAsText,
  reportSystem,
  scribeMessages,
  taskSuggestionSystem,
} from "../ai/prompts";
import { audit, capsFor, requireCap, tenantTx, uuidParam, type Ctx } from "../context";
import { ApiError, badRequest, conflict, forbidden, ifMatchVersion, json, notFound, readJson, unprocessable } from "../http";
import { route } from "../router";
import { hospitalTimezone, loadEpisode, type EpisodeScope } from "../scope";
import { rejectOversized, storeUploadedDocument } from "./documents";

/**
 * Recursos clínicos de IA (ADR 0014). Tudo aqui devolve PROPOSTA: nada entra na evolução, na lista
 * de tarefas ou em documento emitido sem ação explícita do médico. Chamadas ao provedor acontecem
 * fora de transação; conteúdo clínico não vai para log nem para auditoria (só ação e recurso).
 */

const AUDIO_MAX = 25 * 1024 * 1024;
const MAX_PENDING_SUGGESTIONS = 5;

// ---------------------------------------------------------------------------------------------
// Rascunho de evolução do próprio autor (ditado, escriba e revisão)
// ---------------------------------------------------------------------------------------------
interface DraftForAi {
  id: string;
  service_id: string;
  service_episode_id: string;
  content: NoteContent;
  problems: Map<string, string>;
}

async function loadDraftForAi(ctx: Ctx, id: string): Promise<DraftForAi> {
  return tenantTx(ctx, async (tx) => {
    const [n] = await tx<{ id: string; service_id: string; service_episode_id: string; author_id: string; status: string; content: unknown }[]>`
      select id, service_id, service_episode_id, author_id, status, content from app.notes where id = ${id}`;
    if (!n) throw notFound();
    await requireCap(ctx, tx, n.service_id, "clinical.write", { type: "note", id });
    if (n.status !== "draft") throw conflict("note_finalized", "Nota finalizada é imutável. Registre um adendo.");
    if (n.author_id !== ctx.session.userId) {
      throw Object.assign(forbidden("not_author", "Somente o autor usa a IA no próprio rascunho."), { auditResource: { type: "note", id } });
    }
    const rows = await tx<{ id: string; description: string }[]>`select id, description from app.problems where service_episode_id = ${n.service_episode_id}`;
    return {
      id: n.id,
      service_id: n.service_id,
      service_episode_id: n.service_episode_id,
      content: NoteContent.parse(n.content),
      problems: new Map(rows.map((r) => [r.id, r.description])),
    };
  });
}

function scribeToClient(o: ScribeOutput) {
  return { pontos: o.pontos, antecedentes: o.antecedentes, exames: o.exames, pendenciasCondutas: o.pendencias_condutas, hipoteses: o.hipoteses };
}

async function structure(ctx: Ctx, cfg: AiConfig, transcript: string, mode: "ditado" | "conversa") {
  const { data } = await runJson(ctx, mode === "conversa" ? "note.scribe" : "note.dictation", scribeMessages(transcript, mode), ScribeOutput, {
    config: cfg,
    maxTokens: 2500,
    timeoutMs: 90_000,
  });
  return scribeToClient(data);
}

/**
 * Áudio (ditado do médico ou conversa com o paciente) → transcrição → notas clínicas de leitura
 * rápida. O áudio não é guardado. Conversa exige a autorização verbal do paciente (registrada).
 */
route("POST", "/v1/ai/notes/:id/transcribe", async (ctx) => {
  const id = uuidParam(ctx);
  rejectOversized(ctx, AUDIO_MAX);
  await loadDraftForAi(ctx, id); // autoriza antes de ler o corpo
  const cfg = await loadAiConfig(ctx);
  let form: FormData;
  try {
    form = await ctx.req.formData();
  } catch {
    throw badRequest("invalid_form", "Envie multipart/form-data com o campo 'audio'.");
  }
  const mode = String(form.get("mode") ?? "ditado") as (typeof SCRIBE_MODES)[number];
  if (!SCRIBE_MODES.includes(mode)) throw badRequest("invalid_mode", "Modo inválido.");
  if (mode === "conversa" && form.get("consent") !== "1") {
    throw unprocessable("consent_required", "Confirme que o paciente autorizou verbalmente a gravação da conversa.");
  }
  const file = form.get("audio");
  if (!(file instanceof Blob) || file.size === 0) throw badRequest("audio_required", "Áudio ausente.");
  if (file.size > AUDIO_MAX) throw new ApiError(413, "file_too_large", "Áudio acima de 25 MB. Grave trechos menores.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = sniffAudio(bytes);
  if (!format) throw new ApiError(415, "unsupported_type", "Formato de áudio não reconhecido (use webm, ogg, m4a, mp3 ou wav).");

  await tenantTx(ctx, async (tx) => {
    if (mode === "conversa") await audit(tx, ctx, "ai.scribe.consent", "note", id);
    await audit(tx, ctx, "ai.note.transcribe", "note", id);
  });
  const transcript = (await runTranscription(ctx, "transcription", cfg, bytes, format)).trim();
  if (!transcript) throw unprocessable("empty_transcript", "Nada foi reconhecido no áudio.");
  // A transcrição já custou: se a organização falhar, devolvemos o texto para tentar de novo.
  try {
    return json({ transcript, mode, notes: await structure(ctx, cfg, transcript, mode) });
  } catch (e) {
    const err = aiApiError(e);
    return json({ transcript, mode, notes: null, structureError: { code: err.code, message: err.message } });
  }
});

/** Reorganiza uma transcrição editada (ou texto digitado) em notas clínicas. */
route("POST", "/v1/ai/notes/:id/structure", async (ctx) => {
  const id = uuidParam(ctx);
  const body = await readJson(ctx.req, StructureTranscript);
  await loadDraftForAi(ctx, id);
  const cfg = await loadAiConfig(ctx);
  await tenantTx(ctx, (tx) => audit(tx, ctx, "ai.note.structure", "note", id));
  return json({ notes: await structure(ctx, cfg, body.transcript, body.mode) });
});

/** Revisão do rascunho salvo antes de finalizar. Só aponta; não bloqueia nem altera nada. */
route("POST", "/v1/ai/notes/:id/review", async (ctx) => {
  const id = uuidParam(ctx);
  const n = await loadDraftForAi(ctx, id);
  const cfg = await loadAiConfig(ctx);
  await tenantTx(ctx, (tx) => audit(tx, ctx, "ai.note.review", "note", id));
  const { data } = await runJson(
    ctx,
    "note.review",
    [
      { role: "system", content: REVIEW_SYSTEM },
      { role: "user", content: draftForReview(n.content, n.problems) },
    ],
    ReviewOutput,
    { config: cfg, maxTokens: 1200 },
  );
  const sections = new Set<string>(NOTE_SECTIONS);
  return json({ issues: data.issues.map((i) => ({ ...i, section: i.section && sections.has(i.section) ? i.section : null })) });
});

// ---------------------------------------------------------------------------------------------
// Leitura de documento (OCR): foto/PDF → classificação e destino sugerido → médico confirma
// ---------------------------------------------------------------------------------------------
const EXTRACTION_COLUMNS = `x.id, x.document_id, x.category, x.target, x.title, to_char(x.exam_date, 'YYYY-MM-DD') exam_date, x.summary,
  x.items, x.status, x.created_at, x.reviewed_at, x.version, d.mime_type`;

async function extractDocument(ctx: Ctx, cfg: AiConfig, ep: EpisodeScope, documentId: string, bytes: Uint8Array, mime: string) {
  if (mime !== "application/pdf") {
    const sees = await listModels()
      .then((ms) => {
        const m = ms.find((x) => x.id === cfg.model);
        return !m || m.input.includes("image"); // catálogo sem o modelo: tenta mesmo assim
      })
      .catch(() => true);
    if (!sees) throw unprocessable("ai_no_vision", "O modelo escolhido não lê imagens. Troque em Administração → Inteligência artificial.");
  }
  const b64 = Buffer.from(bytes).toString("base64");
  const part: ChatPart =
    mime === "application/pdf"
      ? { type: "file", file: { filename: "documento.pdf", file_data: `data:application/pdf;base64,${b64}` } }
      : { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } };
  const { data } = await runJson(
    ctx,
    "document.ocr",
    [
      { role: "system", content: EXTRACTION_SYSTEM },
      { role: "user", content: [{ type: "text", text: "Leia o documento anexado." }, part] },
    ],
    ExtractionOutput,
    { config: cfg, maxTokens: 4000, timeoutMs: 120_000 },
  );
  const summary = data.summary || (data.legivel ? "Sem texto relevante reconhecido." : "Documento ilegível.");
  const target = data.legivel ? data.target : "nenhum";
  return tenantTx(ctx, async (tx) => {
    await requireCap(ctx, tx, ep.service_id, "clinical.write", { type: "service_episode", id: ep.id });
    const [cur] = await tx<{ id: string; status: string; version: number }[]>`
      select id, status, version from app.document_extractions where document_id = ${documentId}`;
    if (cur && cur.status !== "proposed") throw conflict("extraction_reviewed", "A leitura deste documento já foi revisada.");
    if (cur) {
      await tx`update app.document_extractions set category = ${data.category}, target = ${target}, title = ${data.title},
                 exam_date = ${data.exam_date}, summary = ${summary}, items = ${tx.json(data.items as never)}, model = ${cfg.model},
                 version = version + 1
               where id = ${cur.id}`;
    } else {
      await tx`insert into app.document_extractions (tenant_id, hospital_id, service_id, encounter_id, service_episode_id, document_id,
                 category, target, title, exam_date, summary, items, model, created_by)
               values (${ctx.tenantId}, ${ep.hospital_id}, ${ep.service_id}, ${ep.encounter_id}, ${ep.id}, ${documentId},
                       ${data.category}, ${target}, ${data.title}, ${data.exam_date}, ${summary}, ${tx.json(data.items as never)},
                       ${cfg.model}, ${ctx.session.userId})`;
    }
    await audit(tx, ctx, "ai.document.extract", "source_document", documentId);
    const [row] = await tx.unsafe(
      `select ${EXTRACTION_COLUMNS} from app.document_extractions x join app.source_documents d on d.id = x.document_id where x.document_id = $1`,
      [documentId],
    );
    return row;
  });
}

route("POST", "/v1/ai/episodes/:id/documents", async (ctx) => {
  const episodeId = uuidParam(ctx);
  rejectOversized(ctx, env().UPLOAD_MAX_BYTES);
  const ep = await tenantTx(ctx, async (tx) => {
    const ep = await loadEpisode(tx, episodeId);
    await requireCap(ctx, tx, ep.service_id, "clinical.write", { type: "service_episode", id: episodeId });
    await requireCap(ctx, tx, ep.service_id, "document.upload", { type: "service_episode", id: episodeId });
    return ep;
  });
  const cfg = await loadAiConfig(ctx);
  const doc = await storeUploadedDocument(ctx, ep, "exame");
  // O arquivo fica guardado mesmo se a leitura falhar: dá para tentar de novo sem reenviar.
  try {
    return json({ documentId: doc.id, extraction: await extractDocument(ctx, cfg, ep, doc.id, doc.bytes, doc.mimeType) }, 201);
  } catch (e) {
    const err = aiApiError(e);
    return json({ documentId: doc.id, extraction: null, extractionError: { code: err.code, message: err.message } }, 201);
  }
});

route("POST", "/v1/ai/documents/:id/extract", async (ctx) => {
  const id = uuidParam(ctx);
  const { ep, doc } = await tenantTx(ctx, async (tx) => {
    const [doc] = await tx<{ service_episode_id: string; storage_key: string; mime_type: string; status: string }[]>`
      select service_episode_id, storage_key, mime_type, status from app.source_documents where id = ${id}`;
    if (!doc || doc.status !== "available") throw notFound();
    const ep = await loadEpisode(tx, doc.service_episode_id);
    await requireCap(ctx, tx, ep.service_id, "clinical.write", { type: "source_document", id });
    return { ep, doc };
  });
  const cfg = await loadAiConfig(ctx);
  const bytes = await getObject(doc.storage_key).catch(() => {
    throw new ApiError(410, "document_missing", "Arquivo indisponível.");
  });
  return json({ documentId: id, extraction: await extractDocument(ctx, cfg, ep, id, new Uint8Array(bytes), doc.mime_type) });
});

route("GET", "/v1/episodes/:id/extractions", async (ctx) => {
  const id = uuidParam(ctx);
  const status = ctx.url.searchParams.get("status");
  return tenantTx(ctx, async (tx) => {
    const ep = await loadEpisode(tx, id);
    await requireCap(ctx, tx, ep.service_id, "clinical.read", { type: "service_episode", id });
    const rows = await tx.unsafe(
      `select ${EXTRACTION_COLUMNS} from app.document_extractions x join app.source_documents d on d.id = x.document_id
       where x.service_episode_id = $1 and ($2::text is null and x.status <> 'discarded' or x.status = $2)
       order by coalesce(x.exam_date, x.created_at::date) desc, x.created_at desc limit 200`,
      [id, status === "confirmed" || status === "proposed" ? status : null],
    );
    return json({ extractions: rows });
  });
});

route("PATCH", "/v1/extractions/:id", async (ctx) => {
  const id = uuidParam(ctx);
  const expected = ifMatchVersion(ctx.req);
  const body = await readJson(ctx.req, ReviewExtraction);
  return tenantTx(ctx, async (tx) => {
    const [x] = await tx<{ service_id: string; status: string; version: number }[]>`
      select service_id, status, version from app.document_extractions where id = ${id}`;
    if (!x) throw notFound();
    await requireCap(ctx, tx, x.service_id, "clinical.write", { type: "document_extraction", id });
    if (x.status !== "proposed") throw conflict("extraction_reviewed", "Esta leitura já foi revisada.");
    if (x.version !== expected) throw conflict("version_conflict", "A leitura foi alterada por outra pessoa. Recarregue.", { currentVersion: x.version });
    const status = body.action === "confirm" ? "confirmed" : "discarded";
    const rows = await tx`
      update app.document_extractions set status = ${status}, reviewed_by = ${ctx.session.userId}, reviewed_at = now(),
        title = coalesce(${body.title ?? null}, title), summary = coalesce(${body.summary ?? null}, summary),
        category = coalesce(${body.category ?? null}, category), target = coalesce(${body.target ?? null}, target),
        exam_date = case when ${body.examDate !== undefined} then ${body.examDate ?? null}::date else exam_date end,
        version = version + 1
      where id = ${id} and version = ${expected}`;
    if (rows.count === 0) throw conflict("version_conflict", "A leitura foi alterada por outra pessoa. Recarregue.");
    await audit(tx, ctx, `extraction.${body.action}`, "document_extraction", id);
    return json({ id, status, version: expected + 1 });
  });
});

// ---------------------------------------------------------------------------------------------
// Relatório da internação (paciente ou cobrança). Cabeçalho e relação de visitas vêm do sistema;
// o corpo é rascunho da IA que o autor edita e emite. Envio é feito pelo médico (PDF / e-mail).
// ---------------------------------------------------------------------------------------------
const fmtDate = (d: Date | string, tz: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: tz, dateStyle: "short" }).format(new Date(d));
const fmtDateTime = (d: Date | string, tz: string) =>
  new Intl.DateTimeFormat("pt-BR", { timeZone: tz, dateStyle: "short", timeStyle: "short" }).format(new Date(d));

async function reportMaterial(tx: Tx, ctx: Ctx, ep: EpisodeScope, purpose: "paciente" | "cobranca") {
  const [b] = await tx<
    {
      full_name: string;
      birth_date: string | null;
      hospital_name: string;
      timezone: string;
      service_name: string;
      admitted_at: Date;
      discharged_at: Date | null;
      since: Date;
      ended_at: Date | null;
      reason: string | null;
    }[]
  >`
    select p.full_name, to_char(p.birth_date, 'DD/MM/YYYY') birth_date, h.name hospital_name, h.timezone, s.name service_name,
           en.admitted_at, en.discharged_at, coalesce(e.started_at, e.accepted_at, e.requested_at) since, e.ended_at,
           c.reason
    from app.service_episodes e
    join app.services s on s.id = e.service_id join app.hospitals h on h.id = e.hospital_id
    join app.encounters en on en.id = e.encounter_id join app.patients p on p.id = en.patient_id
    left join app.episode_clinical c on c.service_episode_id = e.id
    where e.id = ${ep.id}`;
  if (!b) throw notFound();
  const [me] = await tx<{ display_name: string }[]>`select display_name from app.users where id = ${ctx.session.userId}`;
  const notes = await tx<{ attended_at: Date; note_type: string; content: unknown; author: string }[]>`
    select v.attended_at, n.note_type, v.content, u.display_name author
    from app.notes n join app.note_versions v on v.id = n.final_version_id join app.users u on u.id = n.author_id
    where n.service_episode_id = ${ep.id} and n.status = 'final'
    order by v.attended_at`;
  if (notes.length === 0) throw unprocessable("no_final_notes", "Não há evoluções finalizadas para compor o relatório.");
  const problems = await tx<{ id: string; description: string; certainty: string; status: string }[]>`
    select id, description, certainty, status from app.problems where service_episode_id = ${ep.id} order by created_at`;
  const extractions = await tx<{ title: string; exam_date: string | null; summary: string }[]>`
    select title, to_char(exam_date, 'DD/MM/YYYY') exam_date, summary from app.document_extractions
    where service_episode_id = ${ep.id} and status = 'confirmed' order by exam_date nulls last limit 30`;
  const tz = b.timezone;
  const names = new Map(problems.map((p) => [p.id, p.description]));

  // Material para a IA: sem nome, nascimento, hospital ou autores.
  const recent = notes.slice(-25);
  const material = [
    `Finalidade: relatório para ${purpose === "paciente" ? "o paciente/família" : "cobrança de honorários"}.`,
    `Motivo do acompanhamento: ${b.reason ?? "não registrado"}`,
    `Problemas: ${problems.map((p) => `${p.description} (${p.certainty}; ${p.status})`).join("; ") || "nenhum registrado"}`,
    extractions.length ? `Exames/documentos confirmados:\n${extractions.map((x) => `- ${x.exam_date ?? "s/ data"} ${x.title}: ${x.summary.slice(0, 600)}`).join("\n")}` : "",
    `Evoluções finalizadas (${notes.length}${notes.length > recent.length ? `, mostrando as ${recent.length} mais recentes` : ""}):`,
    ...recent.map(
      (n, i) =>
        `--- Visita ${notes.length - recent.length + i + 1} (${fmtDate(n.attended_at, tz)}, ${n.note_type === "interconsulta_inicial" ? "interconsulta inicial" : "evolução"})\n${noteAsText(NoteContent.parse(n.content), names, 2500)}`,
    ),
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 60000);

  const header = [
    purpose === "paciente" ? "RELATÓRIO DE ACOMPANHAMENTO DURANTE A INTERNAÇÃO" : "RELATÓRIO DE ACOMPANHAMENTO — HONORÁRIOS MÉDICOS",
    "",
    `Paciente: ${b.full_name}`,
    b.birth_date ? `Data de nascimento: ${b.birth_date}` : null,
    `Hospital: ${b.hospital_name}`,
    `Serviço: ${b.service_name}`,
    `Internação: desde ${fmtDate(b.admitted_at, tz)}${b.discharged_at ? ` até ${fmtDate(b.discharged_at, tz)}` : ""}`,
    `Acompanhamento pelo serviço: ${fmtDate(b.since, tz)} a ${b.ended_at ? fmtDate(b.ended_at, tz) : "em curso"}`,
    `Médico responsável pelo relatório: ${me?.display_name ?? ""}`,
  ]
    .filter((l) => l !== null)
    .join("\n");
  const visits =
    purpose === "cobranca"
      ? [
          `RELAÇÃO DE ATENDIMENTOS (${notes.length})`,
          ...notes.map((n) => `- ${fmtDateTime(n.attended_at, tz)} — ${n.note_type === "interconsulta_inicial" ? "Interconsulta inicial" : "Visita/evolução"} — ${n.author}`),
        ].join("\n")
      : null;
  return { material, header, visits };
}

route("POST", "/v1/ai/episodes/:id/reports", async (ctx) => {
  const episodeId = uuidParam(ctx);
  const body = await readJson(ctx.req, CreateReport);
  const { ep, m } = await tenantTx(ctx, async (tx) => {
    const ep = await loadEpisode(tx, episodeId);
    await requireCap(ctx, tx, ep.service_id, "clinical.write", { type: "service_episode", id: episodeId });
    return { ep, m: await reportMaterial(tx, ctx, ep, body.purpose) };
  });
  const cfg = await loadAiConfig(ctx);
  const r = await runChat(
    ctx,
    "report.draft",
    [
      { role: "system", content: reportSystem(body.purpose) },
      { role: "user", content: m.material },
    ],
    { config: cfg, maxTokens: 3000, timeoutMs: 150_000 },
  );
  const draft = r.text.replace(/```[a-z]*\n?/gi, "").trim();
  const text = [m.header, draft, m.visits, "Relatório elaborado a partir dos registros da equipe e revisado pelo médico responsável."]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 40000);
  const id = await tenantTx(ctx, async (tx) => {
    await requireCap(ctx, tx, ep.service_id, "clinical.write", { type: "service_episode", id: episodeId });
    const [row] = await tx<{ id: string }[]>`
      insert into app.encounter_reports (tenant_id, hospital_id, service_id, encounter_id, service_episode_id, purpose, body, author_id)
      values (${ctx.tenantId}, ${ep.hospital_id}, ${ep.service_id}, ${ep.encounter_id}, ${ep.id}, ${body.purpose}, ${text}, ${ctx.session.userId})
      returning id`;
    await audit(tx, ctx, "report.draft", "encounter_report", row!.id);
    return row!.id;
  });
  return json({ id, version: 1 }, 201);
});

route("GET", "/v1/episodes/:id/reports", async (ctx) => {
  const id = uuidParam(ctx);
  return tenantTx(ctx, async (tx) => {
    const ep = await loadEpisode(tx, id);
    await requireCap(ctx, tx, ep.service_id, "clinical.read", { type: "service_episode", id });
    const rows = await tx`
      select r.id, r.purpose, r.status, r.created_at, r.updated_at, r.issued_at, r.version, u.display_name author_name,
             r.author_id = app.current_user_id() as mine
      from app.encounter_reports r join app.users u on u.id = r.author_id
      where r.service_episode_id = ${id} order by r.created_at desc`;
    return json({ reports: rows });
  });
});

route("GET", "/v1/reports/:id", async (ctx) => {
  const id = uuidParam(ctx);
  return tenantTx(ctx, async (tx) => {
    const [r] = await tx<
      { id: string; service_id: string; service_episode_id: string; purpose: string; status: string; body: string; author_id: string; author_name: string; version: number; created_at: Date; updated_at: Date; issued_at: Date | null; body_sha256: string | null }[]
    >`
      select r.id, r.service_id, r.service_episode_id, r.purpose, r.status, r.body, r.author_id, u.display_name author_name, r.version,
             r.created_at, r.updated_at, r.issued_at, r.body_sha256
      from app.encounter_reports r join app.users u on u.id = r.author_id where r.id = ${id}`;
    if (!r) throw notFound();
    const caps = await capsFor(tx, ctx.tenantId!, r.service_id, ["clinical.write", "note.finalize"]);
    const editable = r.status === "draft" && r.author_id === ctx.session.userId && caps["clinical.write"];
    await audit(tx, ctx, "report.read", "encounter_report", id);
    return json({
      id: r.id,
      episodeId: r.service_episode_id,
      purpose: r.purpose,
      status: r.status,
      body: r.body,
      version: r.version,
      authorName: r.author_name,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      issuedAt: r.issued_at,
      sha256: r.body_sha256,
      permissions: { edit: editable, issue: editable && caps["note.finalize"] },
    });
  });
});

async function loadOwnDraftReport(tx: Tx, ctx: Ctx, id: string, expected: number, cap: "clinical.write" | "note.finalize") {
  const [r] = await tx<{ service_id: string; status: string; author_id: string; version: number }[]>`
    select service_id, status, author_id, version from app.encounter_reports where id = ${id}`;
  if (!r) throw notFound();
  await requireCap(ctx, tx, r.service_id, cap, { type: "encounter_report", id });
  if (r.status !== "draft") throw conflict("report_issued", "Relatório emitido não pode ser alterado. Gere um novo.");
  if (r.author_id !== ctx.session.userId) {
    throw Object.assign(forbidden("not_author", "Somente o autor altera ou emite o relatório."), { auditResource: { type: "encounter_report", id } });
  }
  if (r.version !== expected) throw conflict("version_conflict", "O relatório foi alterado em outra sessão. Recarregue.", { currentVersion: r.version });
}

route("PATCH", "/v1/reports/:id", async (ctx) => {
  const id = uuidParam(ctx);
  const expected = ifMatchVersion(ctx.req);
  const body = await readJson(ctx.req, UpdateReport);
  return tenantTx(ctx, async (tx) => {
    await loadOwnDraftReport(tx, ctx, id, expected, "clinical.write");
    const rows = await tx`update app.encounter_reports set body = ${body.body}, version = version + 1 where id = ${id} and version = ${expected}`;
    if (rows.count === 0) throw conflict("version_conflict", "O relatório foi alterado em outra sessão. Recarregue.");
    await audit(tx, ctx, "report.update", "encounter_report", id);
    return json({ id, version: expected + 1 });
  });
});

/** Emitir: congela o texto (hash). A partir daqui o relatório pode ser impresso/enviado. */
route("POST", "/v1/reports/:id/issue", async (ctx) => {
  const id = uuidParam(ctx);
  const expected = ifMatchVersion(ctx.req);
  return tenantTx(ctx, async (tx) => {
    await loadOwnDraftReport(tx, ctx, id, expected, "note.finalize");
    const rows = await tx`
      update app.encounter_reports set status = 'issued', issued_at = now(), issued_by = ${ctx.session.userId},
        body_sha256 = encode(sha256(convert_to(body, 'UTF8')), 'hex'), version = version + 1
      where id = ${id} and version = ${expected}`;
    if (rows.count === 0) throw conflict("version_conflict", "O relatório foi alterado em outra sessão. Recarregue.");
    await audit(tx, ctx, "report.issue", "encounter_report", id);
    return json({ id, status: "issued", version: expected + 1 });
  });
});

// ---------------------------------------------------------------------------------------------
// Tarefas sugeridas a partir do caso: nascem 'proposed' (source 'ia'); o médico aprova ou descarta.
// ---------------------------------------------------------------------------------------------
async function pendingSuggestions(tx: Tx, episodeId: string): Promise<number> {
  const [r] = await tx<{ n: number }[]>`
    select count(*)::int n from app.tasks where service_episode_id = ${episodeId} and source = 'ia' and status = 'proposed'`;
  return r?.n ?? 0;
}

route("POST", "/v1/ai/episodes/:id/task-suggestions", async (ctx) => {
  const episodeId = uuidParam(ctx);
  const s = await tenantTx(ctx, async (tx) => {
    const ep = await loadEpisode(tx, episodeId);
    await requireCap(ctx, tx, ep.service_id, "clinical.write", { type: "service_episode", id: episodeId });
    if (ep.status !== "active" && ep.status !== "accepted") throw conflict("episode_not_active", "Acompanhamento não está ativo.");
    const pending = await pendingSuggestions(tx, episodeId);
    if (pending >= MAX_PENDING_SUGGESTIONS) {
      throw conflict("too_many_proposals", "Já há sugestões aguardando aprovação. Aprove ou descarte antes de pedir novas.");
    }
    const [c] = await tx<{ reason: string | null }[]>`select reason from app.episode_clinical where service_episode_id = ${episodeId}`;
    const problems = await tx<{ id: string; description: string; certainty: string }[]>`
      select id, description, certainty from app.problems where service_episode_id = ${episodeId} and status in ('ativo', 'em_investigacao')
      order by created_at`;
    const notes = await tx<{ attended_at: Date; content: unknown }[]>`
      select v.attended_at, v.content from app.notes n join app.note_versions v on v.id = n.final_version_id
      where n.service_episode_id = ${episodeId} and n.status = 'final' order by v.attended_at desc limit 3`;
    const tasks = await tx<{ action: string; status: string }[]>`
      select action, status from app.tasks where service_episode_id = ${episodeId} and status in ('proposed', 'open', 'in_progress', 'blocked')`;
    const extractions = await tx<{ title: string; exam_date: string | null; summary: string }[]>`
      select title, to_char(exam_date, 'DD/MM/YYYY') exam_date, summary from app.document_extractions
      where service_episode_id = ${episodeId} and status = 'confirmed' order by created_at desc limit 10`;
    const tz = await hospitalTimezone(tx, ep.hospital_id);
    const names = new Map(problems.map((p) => [p.id, p.description]));
    const text = [
      `Motivo: ${c?.reason ?? "não registrado"}`,
      `Problemas:\n${problems.map((p, i) => `${i + 1}. ${p.description} (${p.certainty})`).join("\n") || "nenhum"}`,
      `Tarefas já existentes (não repetir):\n${tasks.map((t) => `- [${t.status}] ${t.action}`).join("\n") || "nenhuma"}`,
      extractions.length ? `Exames confirmados:\n${extractions.map((x) => `- ${x.exam_date ?? "s/ data"} ${x.title}: ${x.summary.slice(0, 400)}`).join("\n")}` : "",
      `Últimas evoluções finalizadas:\n${notes.map((n) => `--- ${fmtDate(n.attended_at, tz)}\n${noteAsText(NoteContent.parse(n.content), names, 2500)}`).join("\n") || "nenhuma"}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    return { ep, tz, text, max: MAX_PENDING_SUGGESTIONS - pending, problemIds: problems.map((p) => p.id) };
  });
  const cfg = await loadAiConfig(ctx);
  const { data } = await runJson(
    ctx,
    "tasks.suggest",
    [
      { role: "system", content: taskSuggestionSystem(s.max) },
      { role: "user", content: s.text },
    ],
    TaskSuggestions,
    { config: cfg, maxTokens: 1500 },
  );
  const ids = await tenantTx(ctx, async (tx) => {
    await requireCap(ctx, tx, s.ep.service_id, "clinical.write", { type: "service_episode", id: episodeId });
    const room = MAX_PENDING_SUGGESTIONS - (await pendingSuggestions(tx, episodeId));
    const out: string[] = [];
    for (const t of data.tarefas.slice(0, Math.max(0, Math.min(room, s.max)))) {
      const problemId = t.problem ? (s.problemIds[t.problem - 1] ?? null) : null;
      const dueAt = t.dueInHours ? new Date(Date.now() + t.dueInHours * 3_600_000) : null;
      const [row] = await tx<{ id: string }[]>`
        insert into app.tasks (tenant_id, hospital_id, service_id, encounter_id, service_episode_id, problem_id, task_type, action,
          completion_criterion, requested_by, due_at, due_timezone, priority, status, source)
        values (${ctx.tenantId}, ${s.ep.hospital_id}, ${s.ep.service_id}, ${s.ep.encounter_id}, ${episodeId}, ${problemId}, ${t.taskType},
                ${t.action}, ${t.completionCriterion}, ${ctx.session.userId}, ${dueAt}, ${dueAt ? s.tz : null}, ${t.priority}, 'proposed', 'ia')
        returning id`;
      await tx`insert into app.task_events (tenant_id, service_id, task_id, actor_user_id, event, to_status)
               values (${ctx.tenantId}, ${s.ep.service_id}, ${row!.id}, ${ctx.session.userId}, 'created', 'proposed')`;
      out.push(row!.id);
    }
    await audit(tx, ctx, "ai.tasks.suggest", "service_episode", episodeId);
    return out;
  });
  return json({ created: ids.length, ids }, 201);
});

// ---------------------------------------------------------------------------------------------
// Resumo da coordenação: bem curto, só atenção. Pacientes vão à IA como P1..Pn.
// ---------------------------------------------------------------------------------------------
route("POST", "/v1/ai/services/:id/brief", async (ctx) => {
  const serviceId = uuidParam(ctx);
  const snap = await tenantTx(ctx, async (tx) => {
    await requireCap(ctx, tx, serviceId, "coordination.view", { type: "service", id: serviceId });
    const [svc] = await tx<{ hospital_id: string }[]>`select hospital_id from app.services where id = ${serviceId}`;
    if (!svc) throw notFound();
    const tz = await hospitalTimezone(tx, svc.hospital_id);
    const day = localDayBounds(localYmd(new Date(), tz), tz);
    const rows = await tx<
      {
        id: string;
        full_name: string;
        status: string;
        priority: string | null;
        admitted_at: Date;
        location: string | null;
        problems: string | null;
        last_note_at: Date | null;
        last_content: unknown;
        note_today: boolean;
        overdue: number;
        blocked: number;
        unassigned: number;
        proposed: number;
        has_owner: boolean;
      }[]
    >`
      select e.id, p.full_name, e.status, e.priority, en.admitted_at,
        (select l.location_text from app.location_history l where l.encounter_id = en.id and l.to_at is null order by l.from_at desc limit 1) location,
        (select string_agg(pr.description || ' (' || pr.certainty || ')', '; ' order by pr.created_at) from app.problems pr
          where pr.service_episode_id = e.id and pr.status in ('ativo', 'em_investigacao')) problems,
        ln.attended_at last_note_at, ln.content last_content,
        coalesce(ln.attended_at >= ${day.start} and ln.attended_at < ${day.end}, false) note_today,
        (select count(*)::int from app.tasks t where t.service_episode_id = e.id and t.status in ('open', 'in_progress', 'blocked') and t.due_at < now()) overdue,
        (select count(*)::int from app.tasks t where t.service_episode_id = e.id and t.status = 'blocked') blocked,
        (select count(*)::int from app.tasks t where t.service_episode_id = e.id and t.status in ('open', 'in_progress', 'blocked') and t.assignee_user_id is null) unassigned,
        (select count(*)::int from app.tasks t where t.service_episode_id = e.id and t.status = 'proposed') proposed,
        exists (select 1 from app.care_assignments c where c.service_episode_id = e.id and c.until_at is null) has_owner
      from app.service_episodes e
      join app.encounters en on en.id = e.encounter_id join app.patients p on p.id = en.patient_id
      left join lateral (
        select v.attended_at, v.content from app.notes n join app.note_versions v on v.id = n.final_version_id
        where n.service_episode_id = e.id and n.status = 'final' order by v.attended_at desc limit 1) ln on true
      where e.service_id = ${serviceId} and e.status in ('requested', 'accepted', 'active')
      order by p.full_name limit 60`;
    await audit(tx, ctx, "ai.service.brief", "service", serviceId);
    return { rows };
  });
  if (snap.rows.length === 0) return json({ atencao: [], geral: ["Nenhum paciente em acompanhamento."], generatedAt: new Date() });
  const days = (d: Date) => Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000));
  const lines = snap.rows.map((r, i) => {
    const c = r.last_content ? NoteContent.safeParse(r.last_content) : null;
    const sec = (k: "pendencias" | "destino") => {
      const f = c?.success ? c.data.sections[k] : null;
      return f && (f.state === "informado" || f.state === "historico") && f.text ? f.text.slice(0, 400) : null;
    };
    return [
      `P${i + 1}`,
      `internado há ${days(r.admitted_at)} d`,
      r.status === "active" ? null : `pedido ${r.status === "requested" ? "aguardando aceite" : "aceito, não iniciado"}`,
      r.priority ? `prioridade ${r.priority}` : null,
      `problemas: ${r.problems ?? "nenhum registrado"}`,
      r.note_today ? "evolução hoje: sim" : `evolução hoje: NÃO (última: ${r.last_note_at ? `há ${days(r.last_note_at)} d` : "nunca"})`,
      sec("pendencias") ? `pendências: ${sec("pendencias")}` : null,
      sec("destino") ? `destino: ${sec("destino")}` : null,
      r.overdue || r.blocked || r.unassigned ? `tarefas: ${r.overdue} atrasadas, ${r.blocked} bloqueadas, ${r.unassigned} sem responsável` : null,
      r.proposed ? `${r.proposed} sugestões de tarefa aguardando aprovação` : null,
      r.has_owner ? null : "SEM médico responsável",
    ]
      .filter(Boolean)
      .join(" | ");
  });
  const { data } = await runJson(
    ctx,
    "service.brief",
    [
      { role: "system", content: BRIEF_SYSTEM },
      { role: "user", content: lines.join("\n") },
    ],
    BriefOutput,
    { maxTokens: 1200, timeoutMs: 120_000 },
  );
  const atencao = data.atencao
    .map((a) => {
      const r = snap.rows[Number(a.ref.slice(1)) - 1];
      return r ? { episodeId: r.id, patientName: r.full_name, location: r.location, texto: a.texto } : null;
    })
    .filter(Boolean);
  return json({ atencao, geral: data.geral, generatedAt: new Date() });
});
