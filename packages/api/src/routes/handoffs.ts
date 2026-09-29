import { randomUUID } from "node:crypto";
import { AcknowledgeHandoff, CreateHandoff } from "@evolu/contracts";
import { audit, emitOutbox, queryUuid, requireCap, tenantTx, uuidParam } from "../context";
import { conflict, forbidden, ifMatchVersion, json, notFound, readJson, unprocessable } from "../http";
import { route } from "../router";
import { loadEpisode } from "../scope";

const OPEN_TASK = ["proposed", "open", "in_progress", "blocked"];

// ---------------------------------------------------------------------------------------------
// Passagem de caso estruturada (I-PASS). O snapshot congela o que foi transmitido; o aceite do
// receptor transfere a responsabilidade das tarefas pendentes marcadas.
// ---------------------------------------------------------------------------------------------
route("POST", "/v1/handoffs", async (ctx) => {
  const body = await readJson(ctx.req, CreateHandoff);
  return tenantTx(ctx, async (tx) => {
    await requireCap(ctx, tx, body.serviceId, "handoff.participate", { type: "service", id: body.serviceId });
    await requireCap(ctx, tx, body.serviceId, "clinical.read", { type: "service", id: body.serviceId });
    if (body.receiverId === ctx.session.userId) throw unprocessable("invalid_receiver", "Escolha outro médico para receber a passagem.");
    const [rcv] = await tx<{ ok: boolean }[]>`
      select app.user_has_cap(${body.receiverId}, ${ctx.tenantId}, ${body.serviceId}, 'handoff.participate') as ok`;
    if (!rcv?.ok) throw unprocessable("invalid_receiver", "Receptor sem vínculo ativo para passagem neste serviço.");
    const [svc] = await tx<{ hospital_id: string; name: string }[]>`select hospital_id, name from app.services where id = ${body.serviceId}`;
    if (!svc) throw notFound();

    const patients = [];
    const seen = new Set<string>();
    for (const p of body.patients) {
      if (seen.has(p.episodeId)) throw unprocessable("duplicate_patient", "Paciente repetido na passagem.");
      seen.add(p.episodeId);
      const ep = await loadEpisode(tx, p.episodeId);
      if (ep.service_id !== body.serviceId || ep.status !== "active") {
        throw unprocessable("invalid_episode", "Paciente não está ativo neste serviço.");
      }
      const [info] = await tx<{ full_name: string; location: string | null }[]>`
        select p.full_name,
               (select l.location_text from app.location_history l where l.encounter_id = ${ep.encounter_id} and l.to_at is null
                order by l.from_at desc limit 1) as location
        from app.patients p where p.id = ${ep.patient_id}`;
      const problems = await tx<{ description: string; certainty: string }[]>`
        select description, certainty from app.problems where service_episode_id = ${p.episodeId}
          and status in ('ativo', 'em_investigacao') order by created_at`;
      const tasks = await tx<{ id: string; action: string; due_at: Date | null; status: string }[]>`
        select id, action, due_at, status from app.tasks where service_episode_id = ${p.episodeId}
          and status = any(${OPEN_TASK}::text[]) order by due_at nulls last`;
      patients.push({
        episodeId: p.episodeId,
        patientName: info?.full_name ?? "",
        location: info?.location ?? null,
        illnessSeverity: p.illnessSeverity,
        summary: p.summary,
        situationAwareness: p.situationAwareness ?? null,
        problems,
        pendingTasks: tasks,
      });
    }
    if (body.taskIds.length) {
      const ok = await tx<{ id: string }[]>`
        select id from app.tasks where id = any(${body.taskIds}::uuid[]) and service_id = ${body.serviceId}
          and status = any(${OPEN_TASK}::text[]) and service_episode_id = any(${[...seen]}::uuid[])`;
      if (ok.length !== new Set(body.taskIds).size) throw unprocessable("invalid_task", "Tarefa fora da passagem ou já encerrada.");
    }
    const id = randomUUID();
    const snapshot = { schema: 1, serviceName: svc.name, sentAt: new Date().toISOString(), patients };
    await tx`insert into app.handoffs (id, tenant_id, hospital_id, service_id, sender_id, receiver_id, snapshot)
             values (${id}, ${ctx.tenantId}, ${svc.hospital_id}, ${body.serviceId}, ${ctx.session.userId}, ${body.receiverId},
                     ${tx.json(snapshot as never)})`;
    for (const taskId of new Set(body.taskIds)) {
      await tx`insert into app.handoff_tasks (tenant_id, service_id, handoff_id, task_id) values (${ctx.tenantId}, ${body.serviceId}, ${id}, ${taskId})`;
    }
    await audit(tx, ctx, "handoff.send", "handoff", id);
    await emitOutbox(tx, ctx, "handoff.sent", "handoff", id, { serviceId: body.serviceId, receiverId: body.receiverId });
    return json({ id, status: "sent", version: 1 }, 201);
  });
});

route("GET", "/v1/handoffs", async (ctx) => {
  const serviceId = queryUuid(ctx, "serviceId", false);
  const box = ctx.url.searchParams.get("box") ?? "all";
  return tenantTx(ctx, async (tx) => {
    const rows = await tx`
      select h.id, h.service_id, s.name as service_name, h.status, h.sent_at, h.responded_at, h.version,
             h.sender_id, us.display_name as sender_name, h.receiver_id, ur.display_name as receiver_name,
             jsonb_array_length(h.snapshot->'patients') as patient_count
      from app.handoffs h join app.services s on s.id = h.service_id
      join app.users us on us.id = h.sender_id join app.users ur on ur.id = h.receiver_id
      where (${serviceId}::uuid is null or h.service_id = ${serviceId})
        and (${box} = 'all' or (${box} = 'inbox' and h.receiver_id = app.current_user_id())
             or (${box} = 'sent' and h.sender_id = app.current_user_id()))
      order by h.sent_at desc limit 200`;
    return json({ handoffs: rows });
  });
});

route("GET", "/v1/handoffs/:id", async (ctx) => {
  const id = uuidParam(ctx);
  return tenantTx(ctx, async (tx) => {
    const [h] = await tx`
      select h.id, h.service_id, h.status, h.snapshot, h.sent_at, h.responded_at, h.version, h.sender_id, h.receiver_id,
             us.display_name as sender_name, ur.display_name as receiver_name
      from app.handoffs h join app.users us on us.id = h.sender_id join app.users ur on ur.id = h.receiver_id where h.id = ${id}`;
    if (!h) throw notFound();
    const tasks = await tx`
      select t.id, t.action, t.status, t.due_at, t.assignee_user_id from app.handoff_tasks ht join app.tasks t on t.id = ht.task_id
      where ht.handoff_id = ${id}`;
    const acks = await tx`
      select a.decision, a.questions, a.at, u.display_name from app.handoff_acknowledgments a join app.users u on u.id = a.user_id
      where a.handoff_id = ${id} order by a.at`;
    await audit(tx, ctx, "handoff.read", "handoff", id);
    return json({ ...h, tasks, acknowledgments: acks, isReceiver: h.receiver_id === ctx.session.userId });
  });
});

route("POST", "/v1/handoffs/:id/acknowledge", async (ctx) => {
  const id = uuidParam(ctx);
  const expected = ifMatchVersion(ctx.req);
  const body = await readJson(ctx.req, AcknowledgeHandoff);
  return tenantTx(ctx, async (tx) => {
    const [h] = await tx<{ service_id: string; status: string; receiver_id: string; sender_id: string; version: number }[]>`
      select service_id, status, receiver_id, sender_id, version from app.handoffs where id = ${id}`;
    if (!h) throw notFound();
    if (h.receiver_id !== ctx.session.userId) {
      throw Object.assign(forbidden("not_receiver", "Só o receptor confirma a passagem."), { auditResource: { type: "handoff", id } });
    }
    if (h.status !== "sent" && h.status !== "questioned") throw conflict("invalid_state", "Passagem já confirmada ou cancelada.");
    if (h.version !== expected) throw conflict("version_conflict", "A passagem mudou. Recarregue.");
    const newStatus = body.decision === "accepted" ? "acknowledged" : "questioned";
    const rows = await tx`
      update app.handoffs set status = ${newStatus}, responded_at = now(), version = version + 1 where id = ${id} and version = ${expected}`;
    if (rows.count === 0) throw conflict("version_conflict", "A passagem mudou. Recarregue.");
    await tx`insert into app.handoff_acknowledgments (tenant_id, service_id, handoff_id, user_id, decision, questions)
             values (${ctx.tenantId}, ${h.service_id}, ${id}, ${ctx.session.userId}, ${body.decision}, ${body.questions ?? null})`;
    let transferred = 0;
    if (body.decision === "accepted") {
      const tasks = await tx<{ id: string }[]>`
        select t.id from app.handoff_tasks ht join app.tasks t on t.id = ht.task_id
        where ht.handoff_id = ${id} and ht.transfer_ownership and t.status = any(${OPEN_TASK}::text[])`;
      for (const t of tasks) {
        await tx`update app.tasks set assignee_user_id = ${ctx.session.userId}, version = version + 1 where id = ${t.id}`;
        await tx`insert into app.task_events (tenant_id, service_id, task_id, actor_user_id, event)
                 values (${ctx.tenantId}, ${h.service_id}, ${t.id}, ${ctx.session.userId}, 'handoff_transferred')`;
        transferred += 1;
      }
    }
    await audit(tx, ctx, `handoff.${body.decision}`, "handoff", id);
    await emitOutbox(tx, ctx, "handoff.acknowledged", "handoff", id, { serviceId: h.service_id, senderId: h.sender_id, decision: body.decision });
    return json({ id, status: newStatus, version: expected + 1, transferredTasks: transferred });
  });
});
