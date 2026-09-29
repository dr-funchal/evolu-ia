import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sniffAudio } from "../../packages/api/src/ai";
import { startFakeOpenRouter, VALID_KEY, type FakeOpenRouter } from "../helpers/fake-openrouter";
import { appDb, call, FX, idem, login, ownerDb, sampleContent, teardown } from "../helpers/api";
import { sid, withContext } from "@evolu/database";

/**
 * Recursos clínicos de IA (ADR 0014): transcrição em notas clínicas, leitura de documentos,
 * relatório da internação, tarefas sugeridas, resumo da coordenação e revisão da nota.
 * Regra que atravessa tudo: a IA só propõe; o médico confirma.
 */
const EP = FX.ep.neuroA1_3;
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0, 0, 0, 0, 0, 0, 0]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);

const sys = (body: any): string => {
  const m = body.messages?.find((x: any) => x.role === "system");
  return typeof m?.content === "string" ? m.content : "";
};

function replies(body: any): string {
  const s = sys(body);
  if (s.includes("NÃO use formato SOAP"))
    return JSON.stringify({
      pontos: ["Déficit motor estável (sintético)"],
      antecedentes: ["HAS (sintético)"],
      exames: ["TC de crânio sem sangramento (sintético)"],
      pendencias_condutas: ["Aguardar RM (sintético)"],
      hipoteses: [{ descricao: "AVC isquêmico (sintético)", certeza: "hipotese" }],
    });
  if (s.includes("tarefas de continuidade"))
    return JSON.stringify({
      tarefas: [
        { taskType: "obter_laudo", action: "Obter laudo da RM (sintético)", completionCriterion: "Laudo anexado", priority: "alta", dueInHours: 24, problem: 1 },
        { taskType: "reavaliar", action: "Reavaliar força (sintético)", completionCriterion: "Exame registrado", priority: "normal", dueInHours: null, problem: null },
      ],
    });
  if (s.includes("identificados só como P1")) return JSON.stringify({ atencao: [{ ref: "P1", texto: "Sem evolução hoje (sintético)" }, { ref: "P99", texto: "inexistente" }], geral: [] });
  if (s.includes("Revise o rascunho"))
    return JSON.stringify({ issues: [{ severity: "atencao", section: "exame", message: "Exame sem data (sintético)" }, { severity: "info", section: "inventada", message: "x" }] });
  if (s.includes("Escreva o corpo de um relatório")) return "Resumo do acompanhamento (sintético).";
  if (s.includes("Transcreva e classifique"))
    return JSON.stringify({
      legivel: true,
      category: "laboratorio",
      target: "resultados_revistos",
      title: "Hemograma (sintético)",
      exam_date: "2026-09-27",
      summary: "Hb 12,1 g/dL (sintético)",
      items: [{ nome: "Hb", valor: "12,1", unidade: "g/dL", referencia: "12-16", alterado: false }],
    });
  return "{}";
}

describe("recursos clínicos de IA", () => {
  const P: Record<string, string> = {};
  const owner = ownerDb();
  const app = appDb();
  let fake: FakeOpenRouter;
  const s: Record<string, any> = {};

  beforeAll(async () => {
    fake = await startFakeOpenRouter();
    fake.reply = replies;
    for (const p of ["gabriela", "ana", "bruno", "carla", "rafael", "diana", "eduardo"] as const) P[p] = await login(p);
    expect((await call(P.gabriela!, "PUT", "/v1/admin/ai", { body: { apiKey: VALID_KEY, model: "acme/texto-1", transcriptionModel: "acme/whisper" } })).status).toBe(200);
    expect((await call(P.gabriela!, "PUT", "/v1/admin/ai", { body: { enabled: true } })).status).toBe(200);
    s.problemId = sid(`problem:${EP}:0`);
    const n = await call(P.ana!, "POST", `/v1/episodes/${EP}/notes`, { body: {} });
    s.noteId = n.data.id;
  });
  afterAll(async () => {
    await fake.close();
    await owner`delete from app.ai_usage`;
    await owner`delete from app.tenant_ai_settings`;
    await owner.end();
    await app.end();
    await teardown();
  });

  const audioForm = (fields: Record<string, string>, bytes: Uint8Array<ArrayBuffer> = WEBM) => {
    const f = new FormData();
    f.set("audio", new Blob([bytes]), "a.webm");
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };

  it("reconhece áudio pela assinatura, não pelo tipo declarado", () => {
    expect(sniffAudio(WEBM)).toBe("webm");
    expect(sniffAudio(new Uint8Array([0x49, 0x44, 0x33, 4]))).toBe("mp3");
    expect(sniffAudio(new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]))).toBe("m4a");
    expect(sniffAudio(new Uint8Array([0x4d, 0x5a, 0, 0]))).toBeNull();
  });

  describe("transcrição (ditado e conversa)", () => {
    it("ditado vira notas clínicas de leitura rápida; áudio não é guardado; consumo sem conteúdo", async () => {
      fake.transcript = "Paciente sintético com déficit estável, aguardando ressonância.";
      const r = await call(P.ana!, "POST", `/v1/ai/notes/${s.noteId}/transcribe`, { rawBody: audioForm({ mode: "ditado" }) });
      expect(r.status).toBe(200);
      expect(r.data.transcript).toBe(fake.transcript);
      expect(r.data.notes).toMatchObject({ pontos: ["Déficit motor estável (sintético)"], pendenciasCondutas: ["Aguardar RM (sintético)"] });
      expect(r.data.notes.hipoteses[0]).toMatchObject({ certeza: "hipotese" });
      const stt = fake.seen.findLast((x) => x.path === "/api/v1/audio/transcriptions")!;
      expect(stt.body).toMatchObject({ model: "acme/whisper", input_audio: { format: "webm" } });
      const usage = await owner<{ feature: string }[]>`select feature from app.ai_usage order by created_at`;
      expect(usage.map((u) => u.feature)).toEqual(expect.arrayContaining(["transcription", "note.dictation"]));
      const cols = await owner`select column_name from information_schema.columns where table_schema = 'app' and table_name = 'ai_usage'`;
      expect(cols.map((c) => c.column_name)).not.toContain("content");
      // A nota não muda: aplicar é ação do médico.
      const note = await call(P.ana!, "GET", `/v1/notes/${s.noteId}`);
      expect(note.data.version).toBe(1);
    });

    it("conversa exige autorização verbal do paciente, e ela fica auditada", async () => {
      const no = await call(P.ana!, "POST", `/v1/ai/notes/${s.noteId}/transcribe`, { rawBody: audioForm({ mode: "conversa" }) });
      expect(no.status).toBe(422);
      expect(no.data.error.code).toBe("consent_required");
      const ok = await call(P.ana!, "POST", `/v1/ai/notes/${s.noteId}/transcribe`, { rawBody: audioForm({ mode: "conversa", consent: "1" }) });
      expect(ok.status).toBe(200);
      const [a] = await owner`select 1 from app.audit_events where action = 'ai.scribe.consent' and resource_id = ${s.noteId}`;
      expect(a).toBeDefined();
    });

    it("formato desconhecido = 415; outro autor, secretária e outro tenant são negados antes de chamar a IA", async () => {
      expect((await call(P.ana!, "POST", `/v1/ai/notes/${s.noteId}/transcribe`, { rawBody: audioForm({}, new Uint8Array([0x4d, 0x5a, 0, 0])) })).status).toBe(415);
      const before = fake.seen.length;
      expect((await call(P.bruno!, "POST", `/v1/ai/notes/${s.noteId}/transcribe`, { rawBody: audioForm({}) })).status).toBe(403);
      expect((await call(P.carla!, "POST", `/v1/ai/notes/${s.noteId}/structure`, { body: { transcript: "x" } })).status).toBe(404); // sem clinical.read a nota nem é visível
      expect((await call(P.eduardo!, "POST", `/v1/ai/notes/${s.noteId}/structure`, { body: { transcript: "x" }, tenant: FX.tenantB })).status).toBe(404);
      expect(fake.seen.length).toBe(before);
      const [d] = await owner`select 1 from app.audit_events where outcome = 'deny' and resource_id = ${s.noteId}`;
      expect(d).toBeDefined();
    });

    it("reorganizar texto editado e revisar o rascunho (seção inventada é descartada)", async () => {
      const st = await call(P.ana!, "POST", `/v1/ai/notes/${s.noteId}/structure`, { body: { transcript: "Texto editado (sintético).", mode: "ditado" } });
      expect(st.status).toBe(200);
      expect(st.data.notes.antecedentes).toEqual(["HAS (sintético)"]);
      const rv = await call(P.ana!, "POST", `/v1/ai/notes/${s.noteId}/review`, { body: {} });
      expect(rv.status).toBe(200);
      expect(rv.data.issues).toEqual([
        { severity: "atencao", section: "exame", message: "Exame sem data (sintético)" },
        { severity: "info", section: null, message: "x" },
      ]);
    });

    it("sem IA habilitada na equipe, nada é chamado", async () => {
      await call(P.gabriela!, "PUT", "/v1/admin/ai", { body: { enabled: false } });
      const r = await call(P.ana!, "POST", `/v1/ai/notes/${s.noteId}/structure`, { body: { transcript: "x" } });
      expect(r.status).toBeGreaterThanOrEqual(400);
      await call(P.gabriela!, "PUT", "/v1/admin/ai", { body: { enabled: true } });
    });
  });

  describe("leitura de documentos (OCR)", () => {
    it("foto é guardada, lida e fica como proposta; nada vai para a nota", async () => {
      const f = new FormData();
      f.set("file", new Blob([PNG], { type: "image/png" }), "foto.png");
      const r = await call(P.ana!, "POST", `/v1/ai/episodes/${EP}/documents`, { rawBody: f });
      expect(r.status).toBe(201);
      expect(r.data.extraction).toMatchObject({ status: "proposed", category: "laboratorio", title: "Hemograma (sintético)", exam_date: "2026-09-27" });
      s.docId = r.data.documentId;
      s.extraction = r.data.extraction;
      const req = fake.seen.findLast((x) => x.path === "/api/v1/chat/completions")!;
      expect(req.body.messages[1].content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
    });

    it("secretária anexa documentos, mas não usa a leitura clínica", async () => {
      const f = new FormData();
      f.set("file", new Blob([PNG], { type: "image/png" }), "foto.png");
      expect((await call(P.carla!, "POST", `/v1/ai/episodes/${EP}/documents`, { rawBody: f })).status).toBe(403);
      expect((await call(P.carla!, "GET", `/v1/episodes/${EP}/extractions`)).status).toBe(403);
    });

    it("confirmar exige If-Match; após revisada, a leitura é imutável (API e banco)", async () => {
      const x = s.extraction;
      expect((await call(P.ana!, "PATCH", `/v1/extractions/${x.id}`, { body: { action: "confirm" } })).status).toBe(428);
      const ok = await call(P.ana!, "PATCH", `/v1/extractions/${x.id}`, { body: { action: "confirm", examDate: "2026-09-26" }, ifMatch: x.version });
      expect(ok.status).toBe(200);
      const again = await call(P.ana!, "PATCH", `/v1/extractions/${x.id}`, { body: { action: "discard" }, ifMatch: ok.data.version });
      expect(again.status).toBe(409);
      const re = await call(P.ana!, "POST", `/v1/ai/documents/${s.docId}/extract`, { body: {} });
      expect(re.status).toBe(409);
      await expect(
        withContext(app, { userId: FX.users.ana, tenantId: FX.tenantA }, (tx) => tx`update app.document_extractions set summary = 'x', version = version + 1 where id = ${x.id}`),
      ).rejects.toThrow(/revisada/);
      const list = await call(P.ana!, "GET", `/v1/episodes/${EP}/extractions?status=confirmed`);
      expect(list.data.extractions[0]).toMatchObject({ id: x.id, exam_date: "2026-09-26" });
      expect((await call(P.diana!, "GET", `/v1/episodes/${EP}/extractions`)).status).toBe(404); // outro serviço: episódio invisível
    });

    it("modelo sem visão recusa foto com 422 (o arquivo fica guardado)", async () => {
      await call(P.gabriela!, "PUT", "/v1/admin/ai", { body: { model: "acme/cego" } });
      const f = new FormData();
      f.set("file", new Blob([PNG], { type: "image/png" }), "foto2.png");
      const r = await call(P.ana!, "POST", `/v1/ai/episodes/${EP}/documents`, { rawBody: f });
      expect(r.status).toBe(201);
      expect(r.data.extractionError.code).toBe("ai_no_vision");
      await call(P.gabriela!, "PUT", "/v1/admin/ai", { body: { model: "acme/texto-1" } });
    });
  });

  describe("tarefas sugeridas", () => {
    it("nascem propostas (source ia), com problema e prazo; o médico aprova ou descarta", async () => {
      const r = await call(P.ana!, "POST", `/v1/ai/episodes/${EP}/task-suggestions`, { body: {} });
      expect(r.status).toBe(201);
      expect(r.data.created).toBe(2);
      const rows = await owner<{ id: string; status: string; source: string; problem_id: string | null; due_at: Date | null; version: number }[]>`
        select id, status, source, problem_id, due_at, version from app.tasks where id = any(${r.data.ids}) order by action`;
      expect(rows.every((t) => t.status === "proposed" && t.source === "ia")).toBe(true);
      const laudo = rows.find((t) => t.problem_id)!;
      expect(laudo.problem_id).toBe(s.problemId);
      expect(laudo.due_at).not.toBeNull();
      const other = rows.find((t) => t.id !== laudo.id)!;
      expect((await call(P.ana!, "PATCH", `/v1/tasks/${laudo.id}`, { body: { status: "open" }, ifMatch: laudo.version })).status).toBe(200);
      expect((await call(P.ana!, "PATCH", `/v1/tasks/${other.id}`, { body: { status: "cancelled", statusReason: "Sugestão da IA descartada" }, ifMatch: other.version })).status).toBe(200);
    });

    it("o banco recusa tarefa da IA que já nasce aberta", async () => {
      await expect(
        withContext(app, { userId: FX.users.ana, tenantId: FX.tenantA }, async (tx) => {
          const [e] = await tx`select hospital_id, encounter_id from app.service_episodes where id = ${EP}`;
          await tx`insert into app.tasks (tenant_id, hospital_id, service_id, encounter_id, service_episode_id, task_type, action, completion_criterion,
                     requested_by, status, source)
                   values (${FX.tenantA}, ${e!.hospital_id}, ${FX.neuroA1}, ${e!.encounter_id}, ${EP}, 'outro', 'x', 'y', ${FX.users.ana}, 'open', 'ia')`;
        }),
      ).rejects.toThrow();
    });

    it("secretária não pede sugestões; excesso de propostas pendentes = 409", async () => {
      expect((await call(P.carla!, "POST", `/v1/ai/episodes/${EP}/task-suggestions`, { body: {} })).status).toBe(403);
      for (let i = 0; i < 3; i++) await call(P.ana!, "POST", `/v1/ai/episodes/${EP}/task-suggestions`, { body: {} });
      const [n] = await owner<{ n: number }[]>`select count(*)::int n from app.tasks where service_episode_id = ${EP} and source = 'ia' and status = 'proposed'`;
      expect(n!.n).toBeLessThanOrEqual(5);
      const r = await call(P.ana!, "POST", `/v1/ai/episodes/${EP}/task-suggestions`, { body: {} });
      expect(r.status).toBe(409);
    });
  });

  describe("relatório da internação", () => {
    it("exige evolução finalizada", async () => {
      const r = await call(P.ana!, "POST", `/v1/ai/episodes/${EP}/reports`, { body: { purpose: "paciente" } });
      expect(r.status).toBe(422);
    });

    it("rascunho: cabeçalho do sistema, IA não recebe nome do paciente; só o autor vê e edita", async () => {
      const up = await call(P.ana!, "PATCH", `/v1/notes/${s.noteId}`, {
        body: { content: sampleContent([s.problemId]), attendedAt: new Date(Date.now() - 600_000).toISOString() },
        ifMatch: 1,
      });
      expect(up.status).toBe(200);
      const fin = await call(P.ana!, "POST", `/v1/notes/${s.noteId}/finalize`, { body: { warningsJustification: "teste" }, ifMatch: up.data.version, idem: idem() });
      expect(fin.status).toBe(200);

      const r = await call(P.ana!, "POST", `/v1/ai/episodes/${EP}/reports`, { body: { purpose: "cobranca" } });
      expect(r.status).toBe(201);
      s.reportId = r.data.id;
      const sent = fake.seen.findLast((x) => x.path === "/api/v1/chat/completions")!;
      expect(JSON.stringify(sent.body)).not.toContain("Charlie");
      const g = await call(P.ana!, "GET", `/v1/reports/${s.reportId}`);
      expect(g.data.body).toContain("Paciente Sintético Charlie");
      expect(g.data.body).toContain("RELAÇÃO DE ATENDIMENTOS (1)");
      expect(g.data.permissions).toEqual({ edit: true, issue: true });
      expect((await call(P.bruno!, "GET", `/v1/reports/${s.reportId}`)).status).toBe(404);
      expect((await call(P.bruno!, "PATCH", `/v1/reports/${s.reportId}`, { body: { body: "x" }, ifMatch: 1 })).status).toBe(404);
    });

    it("editar e emitir com If-Match; emitido é imutável e visível à equipe", async () => {
      const e = await call(P.ana!, "PATCH", `/v1/reports/${s.reportId}`, { body: { body: "Texto revisado pelo médico (sintético)." }, ifMatch: 1 });
      expect(e.status).toBe(200);
      expect((await call(P.ana!, "POST", `/v1/reports/${s.reportId}/issue`, { ifMatch: 1 })).status).toBe(409);
      const i = await call(P.ana!, "POST", `/v1/reports/${s.reportId}/issue`, { ifMatch: 2 });
      expect(i.status).toBe(200);
      const g = await call(P.bruno!, "GET", `/v1/reports/${s.reportId}`);
      expect(g.status).toBe(200);
      expect(g.data.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(g.data.permissions.edit).toBe(false);
      expect((await call(P.ana!, "PATCH", `/v1/reports/${s.reportId}`, { body: { body: "mudança" }, ifMatch: 3 })).status).toBe(409);
      await expect(
        owner`update app.encounter_reports set body = 'x', version = version + 1 where id = ${s.reportId}`,
      ).rejects.toThrow(/imutável/);
    });

    it("residente redige mas não emite", async () => {
      const r = await call(P.rafael!, "POST", `/v1/ai/episodes/${EP}/reports`, { body: { purpose: "paciente" } });
      expect(r.status).toBe(201);
      const i = await call(P.rafael!, "POST", `/v1/reports/${r.data.id}/issue`, { ifMatch: 1 });
      expect(i.status).toBe(403);
    });
  });

  describe("resumo da coordenação", () => {
    it("só coordenação; pacientes vão como P1..Pn e voltam mapeados; referência inexistente é descartada", async () => {
      expect((await call(P.ana!, "POST", `/v1/ai/services/${FX.neuroA1}/brief`, { body: {} })).status).toBe(403);
      const r = await call(P.bruno!, "POST", `/v1/ai/services/${FX.neuroA1}/brief`, { body: {} });
      expect(r.status).toBe(200);
      expect(r.data.atencao).toHaveLength(1);
      expect(r.data.atencao[0].patientName).toMatch(/Paciente Sintético/);
      const sent = fake.seen.findLast((x) => x.path === "/api/v1/chat/completions")!;
      expect(JSON.stringify(sent.body)).not.toMatch(/Paciente Sintético|SINT-A-/);
    });
  });
});
