import { randomUUID } from "node:crypto";
import { CreateTask, UpdateTask } from "@evolu/contracts";
import type { Tx } from "@evolu/database";
import { audit, emitOutbox, queryUuid, requireCap, tenantTx, uuidParam, type Ctx } from "../context";
import { conflict, ifMatchVersion, json, notFound, readJson, unprocessable } from "../http";
import { route } from "../router";
import { loadEpisode } from "../scope";

async function assertAssignee(tx: Tx, ctx: Ctx, serviceId: string, userId: string | null | undefined) {
  if (!userId) return;
  const [r] = await tx<{ ok: boolean }[]>`select app.user_has_cap(${userId}, ${ctx.tenantId}, ${serviceId}, 'clinical.write') as ok`;
  if (!r?.ok) throw unprocessable("invalid_assignee", "Responsável sem vínculo clínico ativo neste serviço.");
}

const TASK_COLUMNS = `t.id, t.service_episode_id, t.service_id, t.task_type, t.action, t.completion_criterion, t.contingency, t.status,
  t.status_reason, t.priority, t.due_at, t.due_timezone, t.version, t.problem_id, t.assignee_user_id, t.requested_by, t.source,
  t.created_at, t.completed_at`;

route("POST", "/v1/episodes/:id/tasks", async (ctx) => {
  const episodeId = uuidParam(ctx);
  const body = await readJson(ctx.req, CreateTask);
  return tenantTx(ctx, async (tx) => {
    const ep = await loadEpisode(tx, episodeId);
    await requireCap(ctx, tx, ep.service_id, "clinical.write", { type: "service_episode", id: episodeId });
    if (ep.status === "closed" || ep.status === "cancelled") throw conflict("episode_not_active", "Acompanhamento encerrado.");
    await assertAssignee(tx, ctx, ep.service_id, body.assigneeUserId);
    const id = randomUUID();
    await tx`insert into app.tasks (id, tenant_id, hospital_id, service_id, encounter_id, service_episode_id, problem_id, task_type, action,
               completion_criterion, contingency, requested_by, assignee_user_id, due_at, due_timezone, priority, source, source_note_id)
             values (${id}, ${ctx.tenantId}, ${ep.hospital_id}, ${ep.service_id}, ${ep.encounter_id}, ${episodeId}, ${body.problemId ?? null},
                     ${body.taskType}, ${body.action}, ${body.completionCriterion}, ${body.contingency || null}, ${ctx.session.userId},
                     ${body.assigneeUserId}, ${body.dueAt ?? null}, ${body.dueAt ? body.dueTimezone! : null}, ${body.priority ?? null},
                     ${body.sourceNoteId ? "nota" : "manual"}, ${body.sourceNoteId ?? null})`;
    await tx`insert into app.task_events (tenant_id, service_id, task_id, actor_user_id, event, to_status)
             values (${ctx.tenantId}, ${ep.service_id}, ${id}, ${ctx.session.userId}, 'created', 'open')`;
    await audit(tx, ctx, "task.create", "task", id);
    if (body.assigneeUserId && body.assigneeUserId !== ctx.session.userId) {
      await emitOutbox(tx, ctx, "task.assigned", "task", id, { serviceId: ep.service_id, assigneeUserId: body.assigneeUserId });
    }
    return json({ id, version: 1, status: "open" }, 201);
  });
});

/** Tarefas: do serviço (serviceId) ou as minhas no tenant (scope=mine). RLS limita a clinical.read. */
route("GET", "/v1/tasks", async (ctx) => {
  const serviceId = queryUuid(ctx, "serviceId", false);
  const mine = ctx.url.searchParams.get("scope") === "mine";
  const includeClosed = ctx.url.searchParams.get("closed") === "1";
  return tenantTx(ctx, async (tx) => {
    if (serviceId) await requireCap(ctx, tx, serviceId, "clinical.read", { type: "service", id: serviceId });
    const rows = await tx.unsafe(
      `select ${TASK_COLUMNS}, u.display_name as assignee_name, p.full_name as patient_name, s.name as service_name,
              (t.due_at is not null and t.due_at < now()) as overdue
       from app.tasks t
       join app.service_episodes e on e.id = t.service_episode_id
       join app.encounters en on en.id = e.encounter_id
       join app.patients p on p.id = en.patient_id
       join app.services s on s.id = t.service_id
       left join app.users u on u.id = t.assignee_user_id
       where ($1::uuid is null or t.service_id = $1) and (not $2 or t.assignee_user_id = app.current_user_id())
         and ($3 or t.status in ('proposed', 'open', 'in_progress', 'blocked'))
       order by case t.status when 'blocked' then 0 when 'open' then 1 when 'in_progress' then 2 else 3 end, t.due_at nulls last
       limit 500`,
      [serviceId, mine, includeClosed],
    );
    return json({ tasks: rows });
  });
});

route("PATCH", "/v1/tasks/:id", async (ctx) => {
  const id = uuidParam(ctx);
  const expected = ifMatchVersion(ctx.req);
  const body = await readJson(ctx.req, UpdateTask);
  return tenantTx(ctx, async (tx) => {
    const [t] = await tx<{ service_id: string; status: string; assignee_user_id: string | null; due_at: Date | null; version: number }[]>`
      select service_id, status, assignee_user_id, due_at, version from app.tasks where id = ${id}`;
    if (!t) throw notFound();
    await requireCap(ctx, tx, t.service_id, "clinical.write", { type: "task", id });
    if (t.version !== expected) throw conflict("version_conflict", "A tarefa foi alterada por outra pessoa. Recarregue.", { currentVersion: t.version });
    if (body.assigneeUserId !== undefined) await assertAssignee(tx, ctx, t.service_id, body.assigneeUserId);
    const status = body.status ?? t.status;
    const assignee = body.assigneeUserId === undefined ? t.assignee_user_id : body.assigneeUserId;
    const dueChanged = body.dueAt !== undefined;
    if (dueChanged && body.dueAt && !body.dueTimezone) throw unprocessable("due_timezone_required", "Prazo exige timezone.");
    const rows = await tx`
      update app.tasks set status = ${status},
        status_reason = case when ${body.status ?? null}::text is not null then ${body.statusReason ?? null} else status_reason end,
        assignee_user_id = ${assignee},
        due_at = case when ${dueChanged} then ${body.dueAt ?? null}::timestamptz else due_at end,
        due_timezone = case when ${dueChanged} then ${body.dueAt ? body.dueTimezone! : null} else due_timezone end,
        completed_at = case when ${status} = 'done' then now() else completed_at end,
        version = version + 1
      where id = ${id} and version = ${expected}`;
    if (rows.count === 0) throw conflict("version_conflict", "A tarefa foi alterada por outra pessoa. Recarregue.");
    const ev = (event: string, from: string | null, to: string | null) =>
      tx`insert into app.task_events (tenant_id, service_id, task_id, actor_user_id, event, from_status, to_status)
         values (${ctx.tenantId}, ${t.service_id}, ${id}, ${ctx.session.userId}, ${event}, ${from}, ${to})`;
    if (status !== t.status) await ev("status_changed", t.status, status);
    if (assignee !== t.assignee_user_id) {
      await ev("reassigned", null, null);
      if (assignee && assignee !== ctx.session.userId) {
        await emitOutbox(tx, ctx, "task.assigned", "task", id, { serviceId: t.service_id, assigneeUserId: assignee });
      }
    }
    if (dueChanged) await ev("due_changed", null, null);
    await audit(tx, ctx, "task.update", "task", id);
    return json({ id, version: expected + 1, status });
  });
});
