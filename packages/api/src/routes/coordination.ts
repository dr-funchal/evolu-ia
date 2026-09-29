import { localDayBounds, localYmd } from "@evolu/domain";
import { audit, queryUuid, requireCap, tenantTx, uuidParam } from "../context";
import { json } from "../http";
import { route } from "../router";
import { hospitalTimezone } from "../scope";

async function serviceDay(tx: Parameters<Parameters<typeof tenantTx>[1]>[0], serviceId: string, raw: string | null) {
  const [s] = await tx<{ hospital_id: string }[]>`select hospital_id from app.services where id = ${serviceId}`;
  const tz = s ? await hospitalTimezone(tx, s.hospital_id) : "America/Sao_Paulo";
  const ymd = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : localYmd(new Date(), tz);
  return { ymd, tz, ...localDayBounds(ymd, tz) };
}

/** Pendência documental SEM conteúdo clínico (secretária): quem ainda não tem evolução final no dia. */
route("GET", "/v1/documentation/pending", async (ctx) => {
  const serviceId = queryUuid(ctx, "serviceId")!;
  return tenantTx(ctx, async (tx) => {
    await requireCap(ctx, tx, serviceId, "documentation.pending.view", { type: "service", id: serviceId });
    const day = await serviceDay(tx, serviceId, ctx.url.searchParams.get("date"));
    const rows = await tx`
      select d.service_episode_id as episode_id, d.has_final_note_in_period, d.has_draft, p.full_name,
             (select l.location_text from app.location_history l where l.encounter_id = en.id and l.to_at is null
              order by l.from_at desc limit 1) as location
      from app.pending_documentation(${ctx.tenantId}, ${serviceId}, ${day.start}, ${day.end}) d
      join app.service_episodes e on e.id = d.service_episode_id
      join app.encounters en on en.id = e.encounter_id
      join app.patients p on p.id = en.patient_id
      order by d.has_final_note_in_period, p.full_name`;
    return json({ day: day.ymd, timezone: day.tz, items: rows });
  });
});

/** Painel de exceções da coordenação: o que está atrasado ou sem dono. Contagens + ponteiros. */
route("GET", "/v1/coordination/exceptions", async (ctx) => {
  const serviceId = queryUuid(ctx, "serviceId")!;
  return tenantTx(ctx, async (tx) => {
    await requireCap(ctx, tx, serviceId, "coordination.view", { type: "service", id: serviceId });
    const day = await serviceDay(tx, serviceId, ctx.url.searchParams.get("date"));
    const overdueRequests = await tx`
      select e.id as episode_id, p.full_name, e.requested_at, e.due_at, e.priority
      from app.service_episodes e join app.encounters en on en.id = e.encounter_id join app.patients p on p.id = en.patient_id
      where e.service_id = ${serviceId} and e.status in ('requested', 'accepted') and (e.due_at < now() or e.requested_at < now() - interval '24 hours')
      order by e.due_at nulls last`;
    const withoutNote = await tx`
      select e.id as episode_id, p.full_name
      from app.service_episodes e join app.encounters en on en.id = e.encounter_id join app.patients p on p.id = en.patient_id
      where e.service_id = ${serviceId} and e.status = 'active'
        and not exists (select 1 from app.notes n where n.service_episode_id = e.id and n.status = 'final'
                        and n.attended_at >= ${day.start} and n.attended_at < ${day.end})
      order by p.full_name`;
    const withoutOwner = await tx`
      select e.id as episode_id, p.full_name
      from app.service_episodes e join app.encounters en on en.id = e.encounter_id join app.patients p on p.id = en.patient_id
      where e.service_id = ${serviceId} and e.status = 'active'
        and not exists (select 1 from app.care_assignments c where c.service_episode_id = e.id and c.until_at is null)`;
    const tasks = await tx`
      select t.id, t.service_episode_id as episode_id, t.status, t.due_at, t.assignee_user_id, u.display_name as assignee_name,
             (t.assignee_user_id is null) as unassigned
      from app.tasks t left join app.users u on u.id = t.assignee_user_id
      where t.service_id = ${serviceId} and t.status in ('open', 'in_progress', 'blocked')
        and (t.due_at < now() or t.status = 'blocked' or t.assignee_user_id is null)
      order by t.due_at nulls last limit 200`;
    const handoffs = await tx`
      select h.id, h.sent_at, h.status, ur.display_name as receiver_name
      from app.handoffs h join app.users ur on ur.id = h.receiver_id
      where h.service_id = ${serviceId} and h.status in ('sent', 'questioned') and h.sent_at < now() - interval '1 hour'
      order by h.sent_at`;
    const staleDrafts = await tx`
      select n.id, n.service_episode_id as episode_id, n.updated_at, u.display_name as author_name
      from app.notes n join app.users u on u.id = n.author_id
      where n.service_id = ${serviceId} and n.status = 'draft' and n.updated_at < now() - interval '12 hours'`;
    await audit(tx, ctx, "coordination.view", "service", serviceId);
    return json({ day: day.ymd, overdueRequests, withoutNote, withoutOwner, tasks, handoffs, staleDrafts });
  });
});

route("GET", "/v1/notifications", async (ctx) =>
  tenantTx(ctx, async (tx) => {
    const rows = await tx`
      select id, kind, generic_text, link_path, status, created_at, read_at from app.notification_deliveries
      where recipient_user_id = app.current_user_id() order by created_at desc limit 100`;
    return json({ notifications: rows });
  }),
);

route("POST", "/v1/notifications/:id/read", async (ctx) => {
  const id = uuidParam(ctx);
  return tenantTx(ctx, async (tx) => {
    await tx`update app.notification_deliveries set read_at = coalesce(read_at, now()), status = 'read' where id = ${id}`;
    return json({ ok: true });
  });
});

route("GET", "/v1/audit", async (ctx) =>
  tenantTx(ctx, async (tx) => {
    await requireCap(ctx, tx, null, "audit.read", { type: "tenant", id: ctx.tenantId! });
    const rows = await tx`
      select a.id, a.at, a.action, a.resource_type, a.resource_id, a.outcome, a.reason_code, a.request_id,
             u.display_name as actor_name, r.display_name as real_user_name
      from app.audit_events a left join app.users u on u.id = a.actor_user_id left join app.users r on r.id = a.real_user_id
      where a.tenant_id = ${ctx.tenantId} order by a.at desc limit 300`;
    return json({ events: rows });
  }),
);
