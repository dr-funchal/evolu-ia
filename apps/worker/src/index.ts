import { createHash } from "node:crypto";
import { putObject } from "@evolu/config";
import { NoteContent } from "@evolu/contracts";
import { withContext, type Sql, type Tx } from "@evolu/database";
import { formatLocal, renderNoteText } from "@evolu/domain";

/**
 * Worker: consome o outbox (notificações genéricas) e executa jobs duráveis. Roda com o papel
 * evolu_worker (sem BYPASSRLS). Jobs sobre dados clínicos executam NO CONTEXTO DO SOLICITANTE:
 * se o acesso dele foi revogado depois do pedido, o job é cancelado (access_revoked).
 */

interface OutboxRow {
  id: string;
  tenant_id: string;
  event_type: string;
  aggregate_id: string;
  payload: Record<string, string | null>;
  attempts: number;
}

/** Texto sempre genérico: sem nome de paciente, diagnóstico ou conteúdo clínico. */
const NOTIFY: Record<string, { to: string; cap: string; text: string; link: (r: OutboxRow) => string }> = {
  "task.assigned": { to: "assigneeUserId", cap: "clinical.read", text: "Uma tarefa foi atribuída a você.", link: () => "/tarefas" },
  "handoff.sent": {
    to: "receiverId",
    cap: "handoff.participate",
    text: "Você recebeu uma passagem de caso.",
    link: (r) => `/passagens/${r.aggregate_id}`,
  },
  "schedule.published": { to: "assigneeUserId", cap: "patient.basic.read", text: "Uma escala com você foi publicada.", link: () => "/escala" },
  "schedule.changed": { to: "assigneeUserId", cap: "patient.basic.read", text: "Houve mudança numa escala sua.", link: () => "/escala" },
  "handoff.acknowledged": {
    to: "senderId",
    cap: "handoff.participate",
    text: "Sua passagem de caso foi respondida.",
    link: (r) => `/passagens/${r.aggregate_id}`,
  },
};

export async function processOutboxOnce(sql: Sql, batch = 50): Promise<number> {
  return sql.begin(async (tx) => {
    const rows = await tx<OutboxRow[]>`
      select id::text as id, tenant_id, event_type, aggregate_id, payload, attempts from app.outbox_events
      where processed_at is null and available_at <= now() and (locked_until is null or locked_until < now())
      order by id limit ${batch} for update skip locked`;
    for (const r of rows) {
      try {
        const rule = NOTIFY[r.event_type];
        const recipient = rule ? r.payload[rule.to] : null;
        const serviceId = r.payload.serviceId ?? null;
        if (rule && recipient) {
          // Revalida o destinatário no momento da entrega (vínculo pode ter sido revogado).
          const [ok] = await tx<{ ok: boolean }[]>`select app.user_has_cap(${recipient}, ${r.tenant_id}, ${serviceId}, ${rule.cap}) as ok`;
          if (ok?.ok) {
            await tx`insert into app.notification_deliveries (tenant_id, recipient_user_id, source_event_id, kind, generic_text, link_path, status, delivered_at)
                     values (${r.tenant_id}, ${recipient}, ${r.id}::bigint, ${r.event_type}, ${rule.text}, ${rule.link(r)}, 'delivered', now())
                     on conflict (source_event_id, recipient_user_id) do nothing`;
          }
        }
        await tx`update app.outbox_events set processed_at = now(), attempts = attempts + 1 where id = ${r.id}::bigint`;
      } catch (e) {
        const code = (e as { code?: string }).code ?? "error";
        await tx`update app.outbox_events set attempts = attempts + 1, last_error_code = ${code},
                   available_at = now() + make_interval(secs => least(3600, 10 * power(2, ${r.attempts})))
                 where id = ${r.id}::bigint`;
      }
    }
    return rows.length;
  });
}

interface JobRow {
  id: string;
  tenant_id: string;
  kind: string;
  requested_by: string;
  resource_id: string | null;
  attempts: number;
  max_attempts: number;
}

class JobCancelled extends Error {
  constructor(public code: string) {
    super(code);
  }
}

async function claimJob(sql: Sql, workerId: string): Promise<JobRow | undefined> {
  return sql.begin(async (tx) => {
    const [j] = await tx<JobRow[]>`
      select id, tenant_id, kind, requested_by, resource_id, attempts, max_attempts from app.jobs
      where status = 'queued' and run_after <= now() and (locked_until is null or locked_until < now())
      order by run_after limit 1 for update skip locked`;
    if (!j) return undefined;
    await tx`update app.jobs set status = 'running', attempts = attempts + 1, locked_until = now() + interval '5 minutes',
               locked_by = ${workerId} where id = ${j.id}`;
    return j;
  });
}

async function runNoteExport(tx: Tx, job: JobRow): Promise<Record<string, string>> {
  const [x] = await tx<{ id: string; note_id: string; note_version_id: string; service_id: string; status: string }[]>`
    select id, note_id, note_version_id, service_id, status from app.note_exports where id = ${job.resource_id}`;
  // RLS no contexto do solicitante: sem clinical.read (ou sem vínculo), a exportação some.
  if (!x) throw new JobCancelled("access_revoked");
  if (x.status !== "queued") return { exportId: x.id, skipped: "already_processed" };
  const [v] = await tx<{ content: unknown; version_no: number; attended_at: Date; recorded_at: Date; author_id: string; service_episode_id: string; hospital_id: string }[]>`
    select v.content, v.version_no, v.attended_at, v.recorded_at, v.author_id, n.service_episode_id, n.hospital_id
    from app.note_versions v join app.notes n on n.id = v.note_id where v.id = ${x.note_version_id}`;
  if (!v) throw new JobCancelled("access_revoked");
  const [meta] = await tx<{ full_name: string; author: string; tz: string }[]>`
    select p.full_name, u.display_name as author, h.timezone as tz
    from app.service_episodes e join app.encounters en on en.id = e.encounter_id join app.patients p on p.id = en.patient_id
    join app.users u on u.id = ${v.author_id} join app.hospitals h on h.id = e.hospital_id
    where e.id = ${v.service_episode_id}`;
  if (!meta) throw new JobCancelled("access_revoked");
  const problems = await tx<{ id: string; description: string }[]>`
    select id, description from app.problems where service_episode_id = ${v.service_episode_id}`;
  const addenda = await tx<{ author: string; created_at: Date; reason: string; body: string }[]>`
    select u.display_name as author, a.created_at, a.reason, a.body from app.note_addenda a join app.users u on u.id = a.author_id
    where a.note_id = ${x.note_id} order by a.created_at`;
  const text = renderNoteText(NoteContent.parse(v.content), {
    patientName: meta.full_name,
    authorName: meta.author,
    attendedAt: formatLocal(v.attended_at, meta.tz),
    recordedAt: formatLocal(v.recorded_at, meta.tz),
    versionNo: v.version_no,
    problems: new Map(problems.map((p) => [p.id, p.description])),
    addenda: addenda.map((a) => ({ authorName: a.author, createdAt: formatLocal(a.created_at, meta.tz), reason: a.reason, body: a.body })),
  });
  const key = `exports/${job.tenant_id}/${x.id}.txt`;
  await putObject(key, text);
  const sha = createHash("sha256").update(text).digest("hex");
  await tx`update app.note_exports set status = 'prepared', storage_key = ${key}, sha256 = ${sha} where id = ${x.id}`;
  return { exportId: x.id };
}

const HANDLERS: Record<string, (tx: Tx, job: JobRow) => Promise<Record<string, string>>> = {
  "note.export": runNoteExport,
};

export async function processJobsOnce(sql: Sql, workerId = `worker-${process.pid}`, max = 20): Promise<number> {
  let n = 0;
  for (; n < max; n++) {
    const job = await claimJob(sql, workerId);
    if (!job) break;
    const handler = HANDLERS[job.kind];
    try {
      if (!handler) throw new JobCancelled("unknown_kind");
      const result = await withContext(sql, { userId: job.requested_by, tenantId: job.tenant_id }, async (tx) => {
        const [m] = await tx<{ ok: boolean }[]>`select app.is_active_member(${job.tenant_id}) as ok`;
        if (!m?.ok) throw new JobCancelled("access_revoked");
        return handler(tx, job);
      });
      await sql`update app.jobs set status = 'succeeded', result = ${sql.json(result)}, finished_at = now(), locked_until = null where id = ${job.id}`;
      await sql`insert into app.audit_events (tenant_id, actor_user_id, action, resource_type, resource_id, outcome)
                values (${job.tenant_id}, ${job.requested_by}, ${`job.${job.kind}`}, 'job', ${job.id}, 'allow')`;
    } catch (e) {
      if (e instanceof JobCancelled) {
        await sql`update app.jobs set status = 'cancelled', last_error_code = ${e.code}, finished_at = now(), locked_until = null where id = ${job.id}`;
        await sql`insert into app.audit_events (tenant_id, actor_user_id, action, resource_type, resource_id, outcome, reason_code)
                  values (${job.tenant_id}, ${job.requested_by}, ${`job.${job.kind}`}, 'job', ${job.id}, 'deny', ${e.code})`;
      } else {
        const code = (e as { code?: string }).code ?? (e as Error).name ?? "error";
        const final = job.attempts + 1 >= job.max_attempts;
        await sql`update app.jobs set status = ${final ? "failed" : "queued"}, last_error_code = ${String(code).slice(0, 60)},
                   run_after = now() + make_interval(secs => least(3600, 15 * power(2, ${job.attempts}))), locked_until = null,
                   finished_at = case when ${final} then now() else null end
                 where id = ${job.id}`;
      }
    }
  }
  return n;
}
