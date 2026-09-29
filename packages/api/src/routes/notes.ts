import { createHash, randomUUID } from "node:crypto";
import { getObject } from "@evolu/config";
import { CreateAddendum, CreateNote, FinalizeNote, NoteContent, UpdateNote } from "@evolu/contracts";
import { checkFinalize, emptyNoteContent, prefillFromPrevious } from "@evolu/domain";
import type { Tx } from "@evolu/database";
import { audit, capsFor, emitOutbox, hasCap, requireCap, tenantTx, uuidParam, type Ctx } from "../context";
import { ApiError, conflict, forbidden, ifMatchVersion, json, notFound, readJson, unprocessable } from "../http";
import { idempotent } from "../idempotency";
import { route } from "../router";
import { loadEpisode } from "../scope";

interface NoteRow {
  id: string;
  tenant_id: string;
  hospital_id: string;
  service_id: string;
  encounter_id: string;
  service_episode_id: string;
  author_id: string;
  note_type: string;
  status: "draft" | "final";
  attended_at: Date | null;
  content: NoteContent;
  version: number;
  finalized_at: Date | null;
  finalized_by: string | null;
  final_version_id: string | null;
  updated_at: Date;
}

/** RLS: notas só são visíveis com clinical.read no serviço; fora disso, 404 indistinguível. */
async function loadNote(tx: Tx, id: string): Promise<NoteRow> {
  const [n] = await tx<NoteRow[]>`
    select id, tenant_id, hospital_id, service_id, encounter_id, service_episode_id, author_id, note_type, status, attended_at,
           content, version, finalized_at, finalized_by, final_version_id, updated_at
    from app.notes where id = ${id}`;
  if (!n) throw notFound();
  return n;
}

async function activeProblemIds(tx: Tx, episodeId: string): Promise<string[]> {
  const rows = await tx<{ id: string }[]>`
    select id from app.problems where service_episode_id = ${episodeId} and status in ('ativo', 'em_investigacao') order by created_at`;
  return rows.map((r) => r.id);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------------------------------
// Rascunho de evolução. Nunca copia exame físico anterior; campos herdados ficam marcados como
// "histórico" e bloqueiam a finalização até o médico reconfirmar ou remover.
// ---------------------------------------------------------------------------------------------
route("POST", "/v1/episodes/:id/notes", async (ctx) => {
  const episodeId = uuidParam(ctx);
  const body = await readJson(ctx.req, CreateNote);
  return tenantTx(ctx, async (tx) => {
    const ep = await loadEpisode(tx, episodeId);
    await requireCap(ctx, tx, ep.service_id, "clinical.write", { type: "service_episode", id: episodeId });
    if (ep.status !== "active" && ep.status !== "accepted") {
      throw conflict("episode_not_active", "Acompanhamento não está ativo.");
    }
    const problems = await activeProblemIds(tx, episodeId);
    let content = emptyNoteContent(problems);
    let prefilledFrom: string | null = null;
    if (body.prefillFromLast) {
      const [last] = await tx<{ id: string; content: NoteContent }[]>`
        select v.id, v.content from app.note_versions v join app.notes n on n.id = v.note_id
        where n.service_episode_id = ${episodeId} and n.status = 'final' and v.id = n.final_version_id
        order by v.attended_at desc limit 1`;
      if (last) {
        content = prefillFromPrevious(NoteContent.parse(last.content), last.id, problems);
        prefilledFrom = last.id;
      }
    }
    const id = randomUUID();
    await tx`insert into app.notes (id, tenant_id, hospital_id, service_id, encounter_id, service_episode_id, author_id, note_type,
               content, last_edited_by)
             values (${id}, ${ctx.tenantId}, ${ep.hospital_id}, ${ep.service_id}, ${ep.encounter_id}, ${episodeId}, ${ctx.session.userId},
                     ${body.noteType}, ${tx.json(content as never)}, ${ctx.session.userId})`;
    await audit(tx, ctx, "note.create", "note", id);
    return json({ id, version: 1, prefilledFrom }, 201);
  });
});

route("GET", "/v1/notes/:id", async (ctx) => {
  const id = uuidParam(ctx);
  return tenantTx(ctx, async (tx) => {
    const n = await loadNote(tx, id);
    const caps = await capsFor(tx, ctx.tenantId!, n.service_id, ["clinical.write", "note.finalize", "note.addendum", "coordination.view"]);
    const problems = await tx`
      select id, description, certainty, status from app.problems where service_episode_id = ${n.service_episode_id} order by created_at`;
    const [author] = await tx<{ display_name: string }[]>`select display_name from app.users where id = ${n.author_id}`;
    const versions = await tx`
      select v.id, v.version_no, v.content_sha256, v.attended_at, v.recorded_at, v.warnings, v.warnings_justification
      from app.note_versions v where v.note_id = ${id} order by v.version_no`;
    const addenda = await tx`
      select a.id, a.body, a.reason, a.created_at, u.display_name as author_name
      from app.note_addenda a join app.users u on u.id = a.author_id where a.note_id = ${id} order by a.created_at`;
    const exports = await tx`
      select id, status, created_at, incorporated_at from app.note_exports where note_id = ${id} order by created_at desc`;
    const isAuthor = n.author_id === ctx.session.userId;
    const content = NoteContent.parse(n.content);
    await audit(tx, ctx, "note.read", "note", id);
    return json({
      id: n.id,
      episodeId: n.service_episode_id,
      serviceId: n.service_id,
      noteType: n.note_type,
      status: n.status,
      version: n.version,
      attendedAt: n.attended_at,
      updatedAt: n.updated_at,
      finalizedAt: n.finalized_at,
      finalVersionId: n.final_version_id,
      author: { id: n.author_id, displayName: author?.display_name ?? "" },
      content,
      problems,
      versions,
      addenda,
      exports,
      check: n.status === "draft" ? checkFinalize(content, n.attended_at) : null,
      permissions: {
        edit: n.status === "draft" && isAuthor && caps["clinical.write"],
        finalize: n.status === "draft" && isAuthor && caps["note.finalize"],
        addendum: n.status === "final" && caps["note.addendum"] && (isAuthor || caps["coordination.view"]),
      },
    });
  });
});

async function assertEditable(tx: Tx, ctx: Ctx, n: NoteRow, expected: number) {
  if (n.status === "final") throw conflict("note_finalized", "Nota finalizada é imutável. Registre um adendo.");
  if (n.author_id !== ctx.session.userId) {
    throw Object.assign(forbidden("not_author", "Somente o autor edita o próprio rascunho."), { auditResource: { type: "note", id: n.id } });
  }
  if (n.version !== expected) {
    throw conflict("version_conflict", "O rascunho foi alterado em outra sessão. Recarregue antes de continuar.", {
      currentVersion: n.version,
    });
  }
  void tx;
}

route("PATCH", "/v1/notes/:id", async (ctx) => {
  const id = uuidParam(ctx);
  const expected = ifMatchVersion(ctx.req);
  const body = await readJson(ctx.req, UpdateNote);
  return tenantTx(ctx, async (tx) => {
    const n = await loadNote(tx, id);
    await requireCap(ctx, tx, n.service_id, "clinical.write", { type: "note", id });
    await assertEditable(tx, ctx, n, expected);
    const valid = new Set((await tx<{ id: string }[]>`select id from app.problems where service_episode_id = ${n.service_episode_id}`).map((r) => r.id));
    if (body.content.problems.some((p) => !valid.has(p.problemId))) {
      throw unprocessable("invalid_problem", "Problema não pertence a este acompanhamento.");
    }
    const rows = await tx`
      update app.notes set content = ${tx.json(body.content as never)}, attended_at = ${body.attendedAt},
             last_edited_by = ${ctx.session.userId}, version = version + 1
      where id = ${id} and version = ${expected} and status = 'draft'`;
    if (rows.count === 0) throw conflict("version_conflict", "O rascunho foi alterado em outra sessão. Recarregue.");
    await audit(tx, ctx, "note.update", "note", id);
    const check = checkFinalize(body.content, body.attendedAt ? new Date(body.attendedAt) : null);
    return json({ id, version: expected + 1, check });
  });
});

// ---------------------------------------------------------------------------------------------
// Finalização: If-Match + Idempotency-Key obrigatórios. Versão imutável, auditoria e outbox na
// mesma transação. Conflito de versão ou nota já final → 409.
// ---------------------------------------------------------------------------------------------
route("POST", "/v1/notes/:id/finalize", async (ctx) => {
  const id = uuidParam(ctx);
  const expected = ifMatchVersion(ctx.req);
  const body = await readJson(ctx.req, FinalizeNote);
  return tenantTx(ctx, async (tx) =>
    idempotent(
      tx,
      ctx,
      `note.finalize:${id}`,
      { id, expected, body },
      async () => {
        const n = await loadNote(tx, id);
        if (!(await hasCap(tx, ctx.tenantId!, n.service_id, "note.finalize"))) {
          throw Object.assign(forbidden("missing_capability", "Seu vínculo não permite finalizar evoluções neste serviço."), {
            auditResource: { type: "note", id },
          });
        }
        await assertEditable(tx, ctx, n, expected);
        const content = NoteContent.parse(n.content);
        const check = checkFinalize(content, n.attended_at);
        if (check.blocking.length) throw unprocessable("finalize_blocked", "A evolução tem pendências que impedem a finalização.", check);
        if (check.warnings.length && !body.warningsJustification) {
          throw unprocessable("warnings_need_justification", "Justifique os avisos para finalizar.", check);
        }
        const canonical = JSON.stringify(content);
        const versionId = randomUUID();
        const versionNo = (await tx<{ n: number }[]>`select count(*)::int + 1 as n from app.note_versions where note_id = ${id}`)[0]!.n;
        await tx`insert into app.note_versions (id, tenant_id, service_id, note_id, version_no, content, content_sha256, author_id,
                   attended_at, finalized_by, warnings, warnings_justification)
                 values (${versionId}, ${ctx.tenantId}, ${n.service_id}, ${id}, ${versionNo}, ${tx.json(content as never)},
                         ${sha256(canonical)}, ${n.author_id}, ${n.attended_at}, ${ctx.session.userId},
                         ${tx.json(check.warnings.map((w) => w.code))}, ${check.warnings.length ? body.warningsJustification! : null})`;
        const now = new Date();
        const rows = await tx`
          update app.notes set status = 'final', version = version + 1, finalized_at = ${now}, finalized_by = ${ctx.session.userId},
                 final_version_id = ${versionId}, last_edited_by = ${ctx.session.userId}
          where id = ${id} and version = ${expected} and status = 'draft'`;
        if (rows.count === 0) throw conflict("version_conflict", "A nota foi alterada durante a finalização. Recarregue.");
        await audit(tx, ctx, "note.finalize", "note", id);
        await emitOutbox(tx, ctx, "note.finalized", "note", id, { serviceId: n.service_id, episodeId: n.service_episode_id, versionId });
        return {
          status: 200,
          body: { id, status: "final", version: expected + 1, versionId, versionNo, contentSha256: sha256(canonical), finalizedAt: now },
        };
      },
      { required: true },
    ),
  );
});

route("POST", "/v1/notes/:id/addenda", async (ctx) => {
  const id = uuidParam(ctx);
  const body = await readJson(ctx.req, CreateAddendum);
  return tenantTx(ctx, async (tx) => {
    const n = await loadNote(tx, id);
    await requireCap(ctx, tx, n.service_id, "note.addendum", { type: "note", id });
    if (n.status !== "final") throw conflict("note_not_final", "Rascunho não recebe adendo; edite-o diretamente.");
    if (n.author_id !== ctx.session.userId && !(await hasCap(tx, ctx.tenantId!, n.service_id, "coordination.view"))) {
      throw Object.assign(forbidden("not_author", "Adendo é registrado pelo autor ou pela coordenação do serviço."), {
        auditResource: { type: "note", id },
      });
    }
    const addendumId = randomUUID();
    await tx`insert into app.note_addenda (id, tenant_id, service_id, note_id, note_version_id, author_id, body, reason)
             values (${addendumId}, ${ctx.tenantId}, ${n.service_id}, ${id}, ${n.final_version_id}, ${ctx.session.userId}, ${body.body}, ${body.reason})`;
    await audit(tx, ctx, "note.addendum", "note", id);
    await emitOutbox(tx, ctx, "note.addendum", "note", id, { serviceId: n.service_id, addendumId });
    return json({ id: addendumId }, 201);
  });
});

// ---------------------------------------------------------------------------------------------
// Exportação: job assíncrono no contexto do solicitante. "Preparado" ≠ "incorporado ao prontuário
// oficial" — a incorporação é confirmada manualmente pelo médico.
// ---------------------------------------------------------------------------------------------
route("POST", "/v1/notes/:id/exports", async (ctx) => {
  const id = uuidParam(ctx);
  return tenantTx(ctx, async (tx) => {
    const n = await loadNote(tx, id);
    await requireCap(ctx, tx, n.service_id, "clinical.read", { type: "note", id });
    if (n.status !== "final") throw conflict("note_not_final", "Só evoluções finalizadas podem ser exportadas.");
    const [existing] = await tx<{ id: string; status: string }[]>`
      select id, status from app.note_exports where note_id = ${id} and note_version_id = ${n.final_version_id}
        and requested_by = ${ctx.session.userId} and status <> 'failed' order by created_at desc limit 1`;
    if (existing) return json({ id: existing.id, status: existing.status });
    const exportId = randomUUID();
    const jobId = randomUUID();
    await tx`insert into app.jobs (id, tenant_id, kind, requested_by, resource_type, resource_id, idempotency_key)
             values (${jobId}, ${ctx.tenantId}, 'note.export', ${ctx.session.userId}, 'note_export', ${exportId}, ${exportId})`;
    await tx`insert into app.note_exports (id, tenant_id, service_id, note_id, note_version_id, job_id, requested_by)
             values (${exportId}, ${ctx.tenantId}, ${n.service_id}, ${id}, ${n.final_version_id}, ${jobId}, ${ctx.session.userId})`;
    await audit(tx, ctx, "note.export.request", "note_export", exportId);
    return json({ id: exportId, status: "queued" }, 202);
  });
});

async function loadExport(tx: Tx, id: string) {
  const [x] = await tx<{ id: string; note_id: string; service_id: string; status: string; storage_key: string | null; sha256: string | null }[]>`
    select id, note_id, service_id, status, storage_key, sha256 from app.note_exports where id = ${id}`;
  if (!x) throw notFound();
  return x;
}

route("GET", "/v1/exports/:id", async (ctx) => {
  const id = uuidParam(ctx);
  return tenantTx(ctx, async (tx) => {
    const x = await loadExport(tx, id);
    return json({ id: x.id, noteId: x.note_id, status: x.status, sha256: x.sha256 });
  });
});

route("GET", "/v1/exports/:id/download", async (ctx) => {
  const id = uuidParam(ctx);
  const x = await tenantTx(ctx, async (tx) => {
    const x = await loadExport(tx, id);
    if (!x.storage_key || x.status === "queued" || x.status === "failed") throw conflict("export_not_ready", "Exportação ainda não está pronta.");
    if (x.status === "prepared") await tx`update app.note_exports set status = 'exported' where id = ${id}`;
    await audit(tx, ctx, "note.export.download", "note_export", id);
    return x;
  });
  let data: Buffer;
  try {
    data = await getObject(x.storage_key!);
  } catch {
    throw new ApiError(410, "export_missing", "Arquivo de exportação indisponível. Solicite novamente.");
  }
  return new Response(new Uint8Array(data), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="evolucao-${x.note_id.slice(0, 8)}.txt"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
});

route("POST", "/v1/exports/:id/incorporated", async (ctx) => {
  const id = uuidParam(ctx);
  return tenantTx(ctx, async (tx) => {
    const x = await loadExport(tx, id);
    if (x.status !== "exported" && x.status !== "prepared") throw conflict("invalid_state", "Exportação não pode ser confirmada neste estado.");
    await tx`update app.note_exports set status = 'incorporated', incorporated_confirmed_by = ${ctx.session.userId}, incorporated_at = now()
             where id = ${id}`;
    await audit(tx, ctx, "note.export.incorporated", "note_export", id);
    return json({ id, status: "incorporated" });
  });
});
