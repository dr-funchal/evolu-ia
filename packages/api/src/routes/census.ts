import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CreateEncounter, CreateProblem, EpisodeTransition, UpdateProblem } from "@evolu/contracts";
import { localDayBounds, localYmd } from "@evolu/domain";
import type { Tx } from "@evolu/database";
import { audit, capsFor, emitOutbox, hasCap, queryUuid, requireCap, tenantTx, uuidParam, type Ctx } from "../context";
import { badRequest, conflict, forbidden, ifMatchVersion, json, notFound, readJson, unprocessable } from "../http";
import { idempotent } from "../idempotency";
import { route } from "../router";
import { hospitalTimezone, loadEpisode } from "../scope";

const OPEN_STATUSES = ["requested", "accepted", "active"];

function dayParam(ctx: Ctx, tz: string): { ymd: string; start: Date; end: Date } {
  const raw = ctx.url.searchParams.get("date");
  const ymd = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : localYmd(new Date(), tz);
  const { start, end } = localDayBounds(ymd, tz);
  return { ymd, start, end };
}

async function currentLocations(tx: Tx, encounterIds: string[]) {
  if (!encounterIds.length) return new Map<string, string>();
  const rows = await tx<{ encounter_id: string; location_text: string }[]>`
    select distinct on (encounter_id) encounter_id, location_text from app.location_history
    where encounter_id = any(${encounterIds}::uuid[]) and to_at is null order by encounter_id, from_at desc`;
  return new Map(rows.map((r) => [r.encounter_id, r.location_text]));
}

async function careTeam(tx: Tx, episodeIds: string[]) {
  const map = new Map<string, { userId: string; displayName: string }[]>();
  if (!episodeIds.length) return map;
  const rows = await tx<{ service_episode_id: string; user_id: string; display_name: string }[]>`
    select c.service_episode_id, c.user_id, u.display_name from app.care_assignments c join app.users u on u.id = c.user_id
    where c.service_episode_id = any(${episodeIds}::uuid[]) and c.until_at is null order by u.display_name`;
  for (const r of rows) {
    const list = map.get(r.service_episode_id) ?? [];
    list.push({ userId: r.user_id, displayName: r.display_name });
    map.set(r.service_episode_id, list);
  }
  return map;
}

// ---------------------------------------------------------------------------------------------
// Worklist do serviço ("Meu dia"). A projeção muda conforme as capacidades do usuário NO SERVIÇO:
// sem clinical.read não há motivo, problemas, notas nem tarefas — só cadastro e pendência documental.
// ---------------------------------------------------------------------------------------------
route("GET", "/v1/worklist", async (ctx) => {
  const serviceId = queryUuid(ctx, "serviceId")!;
  return tenantTx(ctx, async (tx) => {
    await requireCap(ctx, tx, serviceId, "patient.basic.read", { type: "service", id: serviceId });
    const [svc] = await tx<{ id: string; name: string; hospital_id: string }[]>`
      select id, name, hospital_id from app.services where id = ${serviceId}`;
    if (!svc) throw notFound();
    const tz = await hospitalTimezone(tx, svc.hospital_id);
    const day = dayParam(ctx, tz);
    const caps = await capsFor(tx, ctx.tenantId!, serviceId, [
      "clinical.read",
      "clinical.write",
      "census.manage",
      "note.finalize",
      "documentation.pending.view",
      "document.upload",
      "handoff.participate",
      "coordination.view",
    ]);
    const eps = await tx<{
      id: string;
      status: string;
      priority: string | null;
      requested_at: Date;
      due_at: Date | null;
      encounter_id: string;
      mrn: string | null;
      admitted_at: Date;
      patient_id: string;
      full_name: string;
      birth_date: string | null;
      version: number;
    }[]>`
      select e.id, e.status, e.priority, e.requested_at, e.due_at, e.encounter_id, en.mrn, en.admitted_at,
             p.id as patient_id, p.full_name, to_char(p.birth_date, 'YYYY-MM-DD') as birth_date, e.version
      from app.service_episodes e
      join app.encounters en on en.tenant_id = e.tenant_id and en.id = e.encounter_id
      join app.patients p on p.tenant_id = en.tenant_id and p.id = en.patient_id
      where e.service_id = ${serviceId} and e.status = any(${OPEN_STATUSES}::text[])
      order by case e.status when 'requested' then 0 when 'accepted' then 1 else 2 end,
               case e.priority when 'urgente' then 0 when 'prioritaria' then 1 else 2 end, p.full_name`;
    const ids = eps.map((e) => e.id);
    const locations = await currentLocations(tx, eps.map((e) => e.encounter_id));
    const team = await careTeam(tx, ids);

    let clinical = new Map<string, unknown>();
    if (caps["clinical.read"] && ids.length) {
      const rows = await tx<{
        id: string;
        reason: string | null;
        problems: { id: string; description: string; certainty: string; status: string }[];
        my_draft_id: string | null;
        my_draft_version: number | null;
        final_today: number;
        drafts: number;
        open_tasks: number;
        overdue_tasks: number;
        last_final_at: Date | null;
      }[]>`
        select e.id,
          (select c.reason from app.episode_clinical c where c.service_episode_id = e.id) as reason,
          coalesce((select json_agg(json_build_object('id', pr.id, 'description', pr.description, 'certainty', pr.certainty,
                                                      'status', pr.status) order by pr.created_at)
                    from app.problems pr where pr.service_episode_id = e.id and pr.status in ('ativo', 'em_investigacao')), '[]') as problems,
          (select n.id from app.notes n where n.service_episode_id = e.id and n.status = 'draft'
             and n.author_id = app.current_user_id() order by n.updated_at desc limit 1) as my_draft_id,
          (select n.version from app.notes n where n.service_episode_id = e.id and n.status = 'draft'
             and n.author_id = app.current_user_id() order by n.updated_at desc limit 1) as my_draft_version,
          (select count(*)::int from app.notes n where n.service_episode_id = e.id and n.status = 'final'
             and n.attended_at >= ${day.start} and n.attended_at < ${day.end}) as final_today,
          (select count(*)::int from app.notes n where n.service_episode_id = e.id and n.status = 'draft') as drafts,
          (select count(*)::int from app.tasks t where t.service_episode_id = e.id and t.status in ('open', 'in_progress', 'blocked')) as open_tasks,
          (select count(*)::int from app.tasks t where t.service_episode_id = e.id and t.status in ('open', 'in_progress', 'blocked')
             and t.due_at < now()) as overdue_tasks,
          (select max(n.attended_at) from app.notes n where n.service_episode_id = e.id and n.status = 'final') as last_final_at
        from app.service_episodes e where e.id = any(${ids}::uuid[])`;
      clinical = new Map(
        rows.map((r) => [
          r.id,
          {
            reason: r.reason,
            problems: r.problems,
            myDraft: r.my_draft_id ? { id: r.my_draft_id, version: r.my_draft_version } : null,
            finalToday: r.final_today,
            drafts: r.drafts,
            openTasks: r.open_tasks,
            overdueTasks: r.overdue_tasks,
            lastFinalAt: r.last_final_at,
          },
        ]),
      );
    }

    let pending = new Map<string, { hasFinalNoteInPeriod: boolean; hasDraft: boolean }>();
    if (caps["documentation.pending.view"]) {
      const rows = await tx<{ service_episode_id: string; has_final_note_in_period: boolean; has_draft: boolean }[]>`
        select * from app.pending_documentation(${ctx.tenantId}, ${serviceId}, ${day.start}, ${day.end})`;
      pending = new Map(rows.map((r) => [r.service_episode_id, { hasFinalNoteInPeriod: r.has_final_note_in_period, hasDraft: r.has_draft }]));
    }

    return json({
      service: { id: svc.id, name: svc.name, timezone: tz },
      day: day.ymd,
      capabilities: caps,
      items: eps.map((e) => ({
        episodeId: e.id,
        status: e.status,
        version: e.version,
        priority: e.priority,
        requestedAt: e.requested_at,
        dueAt: e.due_at,
        admittedAt: e.admitted_at,
        mrn: e.mrn,
        location: locations.get(e.encounter_id) ?? null,
        patient: { id: e.patient_id, fullName: e.full_name, birthDate: e.birth_date },
        careTeam: team.get(e.id) ?? [],
        documentation: pending.get(e.id) ?? null,
        clinical: clinical.get(e.id) ?? null,
      })),
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Novo paciente / nova internação / solicitação de acompanhamento.
// ---------------------------------------------------------------------------------------------
route("POST", "/v1/encounters", async (ctx) => {
  const body = await readJson(ctx.req, CreateEncounter);
  return tenantTx(ctx, async (tx) =>
    idempotent(tx, ctx, "encounter.create", body, async () => {
      const [svc] = await tx<{ id: string; hospital_id: string }[]>`
        select id, hospital_id from app.services where id = ${body.serviceId} and hospital_id = ${body.hospitalId}`;
      if (!svc) throw notFound();
      await requireCap(ctx, tx, body.serviceId, "patient.basic.write", { type: "service", id: body.serviceId });
      const manage = await hasCap(tx, ctx.tenantId!, body.serviceId, "census.manage");
      const clinicalWrite = await hasCap(tx, ctx.tenantId!, body.serviceId, "clinical.write");
      if ((body.reason || body.priority) && !clinicalWrite) {
        throw Object.assign(forbidden("clinical_field_forbidden", "Motivo clínico e prioridade são registrados pela equipe médica."), {
          auditResource: { type: "service", id: body.serviceId },
        });
      }
      if (body.bedId) {
        const [bed] = await tx`select 1 from app.beds where id = ${body.bedId} and hospital_id = ${body.hospitalId}`;
        if (!bed) throw unprocessable("invalid_bed", "Leito não pertence a este hospital.");
      }

      let patientId = body.patientId ?? null;
      let encounterId: string | null = null;
      if (!patientId) {
        const p = body.patient!;
        if (!body.confirmNotDuplicate) {
          const dups = await tx<{ patient_id: string; initials: string | null; birth_date: string | null }[]>`
            select patient_id, initials, to_char(birth_date, 'YYYY-MM-DD') birth_date
            from app.possible_duplicate_patients(${ctx.tenantId}, ${p.fullName}, ${p.birthDate ?? null})`;
          if (dups.length) {
            throw conflict(
              "possible_duplicate",
              "Já existe paciente com este nome nesta instituição. Confirme se é a mesma pessoa ou marque que não é duplicado.",
              dups.map((d) => ({ patientId: d.patient_id, initials: d.initials, birthDate: d.birth_date })),
            );
          }
        }
        patientId = randomUUID();
        await tx`insert into app.patients (id, tenant_id, full_name, birth_date, sex, created_by)
                 values (${patientId}, ${ctx.tenantId}, ${p.fullName}, ${p.birthDate ?? null}, ${p.sex ?? null}, ${ctx.session.userId})`;
        for (const i of p.identifiers) {
          await tx`insert into app.patient_identifiers (tenant_id, patient_id, system, value, created_by)
                   values (${ctx.tenantId}, ${patientId}, ${i.system}, ${i.value}, ${ctx.session.userId})`;
        }
      } else {
        // Reaproveita internação ativa visível no mesmo hospital (interconsulta de outro serviço).
        const [en] = await tx<{ id: string }[]>`
          select id from app.encounters where patient_id = ${patientId} and hospital_id = ${body.hospitalId} and status = 'active'
          order by admitted_at desc limit 1`;
        encounterId = en?.id ?? null;
      }

      if (!encounterId) {
        encounterId = randomUUID();
        await tx`insert into app.encounters (id, tenant_id, hospital_id, patient_id, mrn, admitted_at, created_by)
                 values (${encounterId}, ${ctx.tenantId}, ${body.hospitalId}, ${patientId}, ${body.mrn || null}, ${body.admittedAt},
                         ${ctx.session.userId})`;
        if (body.location || body.bedId) {
          await tx`insert into app.location_history (tenant_id, hospital_id, encounter_id, bed_id, location_text, recorded_by)
                   values (${ctx.tenantId}, ${body.hospitalId}, ${encounterId}, ${body.bedId ?? null},
                           ${body.location || "Leito cadastrado"}, ${ctx.session.userId})`;
        }
      }

      const episodeId = randomUUID();
      const status = manage ? "active" : "requested";
      await tx`insert into app.service_episodes (id, tenant_id, hospital_id, service_id, encounter_id, status, priority,
                 priority_set_by, requested_at, due_at, started_at, created_by)
               values (${episodeId}, ${ctx.tenantId}, ${body.hospitalId}, ${body.serviceId}, ${encounterId}, ${status},
                       ${body.priority ?? null}, ${body.priority ? ctx.session.userId : null}, ${body.requestedAt},
                       ${body.dueAt ?? null}, ${status === "active" ? new Date() : null}, ${ctx.session.userId})`;
      if (body.reason) {
        await tx`insert into app.episode_clinical (tenant_id, service_id, service_episode_id, reason, requester_text, updated_by)
                 values (${ctx.tenantId}, ${body.serviceId}, ${episodeId}, ${body.reason}, ${body.requesterText || null}, ${ctx.session.userId})`;
      }
      if (manage && clinicalWrite) {
        await tx`insert into app.care_assignments (tenant_id, service_id, service_episode_id, user_id, assigned_by)
                 values (${ctx.tenantId}, ${body.serviceId}, ${episodeId}, ${ctx.session.userId}, ${ctx.session.userId})`;
      }
      await audit(tx, ctx, "episode.create", "service_episode", episodeId);
      await emitOutbox(tx, ctx, "episode.created", "service_episode", episodeId, { serviceId: body.serviceId, status });
      return { status: 201, body: { patientId, encounterId, episodeId, status } };
    }),
  );
});

// ---------------------------------------------------------------------------------------------
// Acompanhamento (episódio de serviço)
// ---------------------------------------------------------------------------------------------
route("GET", "/v1/episodes/:id", async (ctx) => {
  const id = uuidParam(ctx);
  return tenantTx(ctx, async (tx) => {
    const ep = await loadEpisode(tx, id);
    const caps = await capsFor(tx, ctx.tenantId!, ep.service_id, [
      "clinical.read",
      "clinical.write",
      "census.manage",
      "note.finalize",
      "note.addendum",
      "document.upload",
      "handoff.participate",
    ]);
    const [base] = await tx<Record<string, unknown>[]>`
      select e.status, e.priority, e.requested_at, e.due_at, e.accepted_at, e.started_at, e.ended_at, e.version,
             s.name as service_name, h.name as hospital_name, h.timezone, en.mrn, en.admitted_at,
             p.full_name, to_char(p.birth_date, 'YYYY-MM-DD') birth_date, p.sex
      from app.service_episodes e
      join app.services s on s.id = e.service_id join app.hospitals h on h.id = e.hospital_id
      join app.encounters en on en.id = e.encounter_id join app.patients p on p.id = en.patient_id
      where e.id = ${id}`;
    const identifiers = await tx`select system, value from app.patient_identifiers where patient_id = ${ep.patient_id} order by created_at`;
    const location = (await currentLocations(tx, [ep.encounter_id])).get(ep.encounter_id) ?? null;
    const team = (await careTeam(tx, [id])).get(id) ?? [];

    let clinical: unknown = null;
    if (caps["clinical.read"]) {
      const [c] = await tx`select reason, requester_text from app.episode_clinical where service_episode_id = ${id}`;
      const problems = await tx`
        select id, description, certainty, status, version, last_reviewed_at from app.problems
        where service_episode_id = ${id} order by case status when 'ativo' then 0 when 'em_investigacao' then 1 else 2 end, created_at`;
      const notes = await tx`
        select n.id, n.note_type, n.status, n.attended_at, n.version, n.finalized_at, n.updated_at, n.author_id,
               u.display_name as author_name,
               (select count(*)::int from app.note_addenda a where a.note_id = n.id) as addenda
        from app.notes n join app.users u on u.id = n.author_id
        where n.service_episode_id = ${id} and (n.status = 'final' or n.author_id = app.current_user_id())
        order by coalesce(n.attended_at, n.created_at) desc`;
      const [others] = await tx<{ n: number }[]>`
        select count(*)::int n from app.notes where service_episode_id = ${id} and status = 'draft' and author_id <> app.current_user_id()`;
      const tasks = await tx`
        select t.id, t.task_type, t.action, t.completion_criterion, t.contingency, t.status, t.status_reason, t.priority,
               t.due_at, t.due_timezone, t.version, t.problem_id, t.assignee_user_id, u.display_name as assignee_name, t.source
        from app.tasks t left join app.users u on u.id = t.assignee_user_id
        where t.service_episode_id = ${id}
        order by case t.status when 'blocked' then 0 when 'open' then 1 when 'in_progress' then 2 when 'proposed' then 3 else 4 end,
                 t.due_at nulls last`;
      clinical = { reason: c?.reason ?? null, requesterText: c?.requester_text ?? null, problems, notes, othersDrafts: others?.n ?? 0, tasks };
    }
    const documents = await tx`
      select id, kind, mime_type, size_bytes, status, created_at, uploaded_by = app.current_user_id() as mine
      from app.source_documents where service_episode_id = ${id} order by created_at desc`;
    await audit(tx, ctx, "episode.read", "service_episode", id);
    return json({
      id,
      serviceId: ep.service_id,
      hospitalId: ep.hospital_id,
      patientId: ep.patient_id,
      encounterId: ep.encounter_id,
      ...base,
      identifiers,
      location,
      careTeam: team,
      capabilities: caps,
      clinical,
      documents,
    });
  });
});

const TRANSITIONS: Record<string, { to: string; col: string | null }> = {
  accept: { to: "accepted", col: "accepted_at" },
  activate: { to: "active", col: "started_at" },
  close: { to: "closed", col: "ended_at" },
  cancel: { to: "cancelled", col: null },
};

route("POST", "/v1/episodes/:id/transition", async (ctx) => {
  const id = uuidParam(ctx);
  const body = await readJson(ctx.req, EpisodeTransition);
  const expected = ifMatchVersion(ctx.req);
  if ((body.action === "close" || body.action === "cancel") && !body.justification) {
    throw badRequest("justification_required", "Encerrar ou cancelar exige justificativa.");
  }
  return tenantTx(ctx, async (tx) => {
    const ep = await loadEpisode(tx, id);
    await requireCap(ctx, tx, ep.service_id, "census.manage", { type: "service_episode", id });
    const t = TRANSITIONS[body.action]!;
    const now = new Date();
    const rows = await tx`
      update app.service_episodes set status = ${t.to}, version = version + 1,
        accepted_at = case when ${t.col} = 'accepted_at' then ${now}::timestamptz else accepted_at end,
        started_at = case when ${t.col} = 'started_at' or (${t.to} = 'active' and started_at is null) then ${now}::timestamptz else started_at end,
        ended_at = case when ${t.col} = 'ended_at' then ${now}::timestamptz else ended_at end,
        end_justification = case when ${t.to} = 'closed' then ${body.justification ?? null} else end_justification end,
        cancel_reason = case when ${t.to} = 'cancelled' then ${body.justification ?? null} else cancel_reason end
      where id = ${id} and version = ${expected}`;
    if (rows.count === 0) throw conflict("version_conflict", "O acompanhamento foi alterado por outra pessoa. Recarregue.");
    if (t.to === "closed" || t.to === "cancelled") {
      await tx`update app.care_assignments set until_at = ${now} where service_episode_id = ${id} and until_at is null`;
    }
    await audit(tx, ctx, `episode.${body.action}`, "service_episode", id);
    await emitOutbox(tx, ctx, `episode.${t.to}`, "service_episode", id, { serviceId: ep.service_id });
    return json({ id, status: t.to, version: expected + 1 });
  });
});

const Assignment = z.object({ userId: z.uuid(), action: z.enum(["add", "remove"]).default("add") });
route("POST", "/v1/episodes/:id/assignments", async (ctx) => {
  const id = uuidParam(ctx);
  const body = await readJson(ctx.req, Assignment);
  return tenantTx(ctx, async (tx) => {
    const ep = await loadEpisode(tx, id);
    await requireCap(ctx, tx, ep.service_id, "census.manage", { type: "service_episode", id });
    if (body.action === "remove") {
      await tx`update app.care_assignments set until_at = now() where service_episode_id = ${id} and user_id = ${body.userId} and until_at is null`;
    } else {
      const [exists] = await tx`select 1 from app.care_assignments where service_episode_id = ${id} and user_id = ${body.userId} and until_at is null`;
      if (!exists) {
        // A política exige que o designado tenha clinical.write neste serviço (senão 42501 → 403).
        await tx`insert into app.care_assignments (tenant_id, service_id, service_episode_id, user_id, assigned_by)
                 values (${ctx.tenantId}, ${ep.service_id}, ${id}, ${body.userId}, ${ctx.session.userId})`;
      }
    }
    await audit(tx, ctx, `episode.assignment.${body.action}`, "service_episode", id);
    return json({ ok: true });
  });
});

route("POST", "/v1/episodes/:id/location", async (ctx) => {
  const id = uuidParam(ctx);
  const body = await readJson(ctx.req, z.object({ location: z.string().trim().min(1).max(120), bedId: z.uuid().optional() }));
  return tenantTx(ctx, async (tx) => {
    const ep = await loadEpisode(tx, id);
    await requireCap(ctx, tx, ep.service_id, "patient.basic.write", { type: "service_episode", id });
    const now = new Date();
    await tx`update app.location_history set to_at = ${now} where encounter_id = ${ep.encounter_id} and to_at is null`;
    await tx`insert into app.location_history (tenant_id, hospital_id, encounter_id, bed_id, location_text, from_at, recorded_by)
             values (${ctx.tenantId}, ${ep.hospital_id}, ${ep.encounter_id}, ${body.bedId ?? null}, ${body.location}, ${now}, ${ctx.session.userId})`;
    await audit(tx, ctx, "encounter.location", "encounter", ep.encounter_id);
    return json({ ok: true });
  });
});

const TEAM_CAPS = ["clinical.write", "handoff.participate", "note.finalize"] as const;
route("GET", "/v1/services/:id/team", async (ctx) => {
  const serviceId = uuidParam(ctx);
  const cap = ctx.url.searchParams.get("cap") ?? "clinical.write";
  if (!(TEAM_CAPS as readonly string[]).includes(cap)) throw badRequest("invalid_cap", "Capacidade inválida.");
  return tenantTx(ctx, async (tx) => {
    await requireCap(ctx, tx, serviceId, "patient.basic.read", { type: "service", id: serviceId });
    const rows = await tx<{ user_id: string; display_name: string }[]>`select * from app.service_team(${ctx.tenantId}, ${serviceId}, ${cap})`;
    return json({ members: rows.map((r) => ({ userId: r.user_id, displayName: r.display_name })) });
  });
});

// ---------------------------------------------------------------------------------------------
// Lista de problemas (certeza explícita; nada é inferido automaticamente)
// ---------------------------------------------------------------------------------------------
route("POST", "/v1/episodes/:id/problems", async (ctx) => {
  const id = uuidParam(ctx);
  const body = await readJson(ctx.req, CreateProblem);
  return tenantTx(ctx, async (tx) => {
    const ep = await loadEpisode(tx, id);
    await requireCap(ctx, tx, ep.service_id, "clinical.write", { type: "service_episode", id });
    const problemId = randomUUID();
    await tx`insert into app.problems (id, tenant_id, hospital_id, service_id, encounter_id, service_episode_id, description, certainty,
               created_by, last_reviewed_by, last_reviewed_at)
             values (${problemId}, ${ctx.tenantId}, ${ep.hospital_id}, ${ep.service_id}, ${ep.encounter_id}, ${id}, ${body.description},
                     ${body.certainty}, ${ctx.session.userId}, ${ctx.session.userId}, now())`;
    await audit(tx, ctx, "problem.create", "problem", problemId);
    return json({ id: problemId, version: 1 }, 201);
  });
});

route("PATCH", "/v1/problems/:id", async (ctx) => {
  const id = uuidParam(ctx);
  const body = await readJson(ctx.req, UpdateProblem);
  const expected = ifMatchVersion(ctx.req);
  return tenantTx(ctx, async (tx) => {
    const [p] = await tx<{ service_id: string }[]>`select service_id from app.problems where id = ${id}`;
    if (!p) throw notFound();
    await requireCap(ctx, tx, p.service_id, "clinical.write", { type: "problem", id });
    const reviewed = body.reviewed ?? true;
    const rows = await tx`
      update app.problems set
        description = coalesce(${body.description ?? null}, description),
        certainty = coalesce(${body.certainty ?? null}, certainty),
        status = coalesce(${body.status ?? null}, status),
        last_reviewed_by = case when ${reviewed} then app.current_user_id() else last_reviewed_by end,
        last_reviewed_at = case when ${reviewed} then now() else last_reviewed_at end,
        version = version + 1
      where id = ${id} and version = ${expected}`;
    if (rows.count === 0) throw conflict("version_conflict", "O problema foi alterado por outra pessoa. Recarregue.");
    await audit(tx, ctx, "problem.update", "problem", id);
    return json({ id, version: expected + 1 });
  });
});
