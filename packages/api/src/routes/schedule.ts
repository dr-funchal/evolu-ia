import { EndSeries, ScheduleException, ScheduleSeriesInput, SplitSeries, type Repeat } from "@evolu/contracts";
import type { Tx } from "@evolu/database";
import { expand, formatRule, localDayBounds, zonedToUtc, type SeriesSpec, type Weekday } from "@evolu/domain";
import { audit, emitOutbox, requireCap, tenantTx, uuidParam, type Ctx } from "../context";
import { badRequest, conflict, ifMatchVersion, json, notFound, readJson, unprocessable } from "../http";
import { route } from "../router";

/**
 * Escala: séries (regra) → ocorrências calculadas → exceções por início local original.
 * Sem dado de paciente. Montar = schedule.draft no serviço; publicar ou mexer no publicado = schedule.publish.
 */

interface SeriesRow {
  id: string;
  hospital_id: string;
  service_id: string;
  modality: string;
  assignee_user_id: string;
  timezone: string;
  dtstart: string;
  duration_minutes: number;
  rrule: string | null;
  until: string | null;
  notes: string | null;
  status: "draft" | "published" | "cancelled";
  version: number;
}
interface ServiceRow {
  service_id: string;
  hospital_id: string;
  service_name: string;
  hospital_name: string;
  hospital_timezone: string;
  can_draft: boolean;
  can_publish: boolean;
}

const SERIES_COLS = `id, hospital_id, service_id, modality, assignee_user_id, timezone,
  to_char(dtstart_local, 'YYYY-MM-DD"T"HH24:MI') as dtstart, duration_minutes, rrule,
  to_char(until_local, 'YYYY-MM-DD') as until, notes, status, version`;

function ruleOf(r: Repeat): string | null {
  if (r.freq === "none") return null;
  if (r.freq === "daily") return formatRule({ freq: "DAILY", interval: r.interval, byDay: [] });
  return formatRule({ freq: "WEEKLY", interval: r.interval, byDay: r.byDay });
}

function specOf(s: Pick<SeriesRow, "dtstart" | "timezone" | "duration_minutes" | "rrule" | "until">): SeriesSpec {
  return { dtstartLocal: s.dtstart, timezone: s.timezone, durationMinutes: s.duration_minutes, rrule: s.rrule, untilLocal: s.until };
}

function repeatOf(rrule: string | null): Repeat {
  if (!rrule) return { freq: "none" };
  const parts = Object.fromEntries(rrule.split(";").map((p) => p.split("=") as [string, string]));
  const interval = Number(parts.INTERVAL ?? 1);
  if (parts.FREQ === "DAILY") return { freq: "daily", interval };
  return { freq: "weekly", interval, byDay: (parts.BYDAY ?? "").split(",").filter(Boolean) as Weekday[] };
}

async function loadService(tx: Tx, serviceId: string): Promise<ServiceRow> {
  const [s] = await tx<ServiceRow[]>`select * from app.tenant_active_services() where service_id = ${serviceId}`;
  if (!s) throw notFound();
  return s;
}

async function assertAssignable(tx: Tx, serviceId: string, userId: string) {
  const [u] = await tx`select 1 from app.schedule_assignable(${serviceId}) where user_id = ${userId}`;
  if (!u) throw unprocessable("invalid_assignee", "Profissional sem vínculo ativo neste serviço.");
}

async function loadSeries(tx: Tx, id: string): Promise<SeriesRow> {
  const [s] = await tx.unsafe<SeriesRow[]>(`select ${SERIES_COLS} from app.schedule_series where id = $1`, [id]);
  if (!s) throw notFound();
  return s;
}

/** Quem mexe numa série já publicada precisa poder publicar (a RLS também exige). */
async function requireEdit(ctx: Ctx, tx: Tx, s: Pick<SeriesRow, "service_id" | "status" | "id">) {
  await requireCap(ctx, tx, s.service_id, "schedule.draft", { type: "schedule_series", id: s.id });
  if (s.status !== "draft") await requireCap(ctx, tx, s.service_id, "schedule.publish", { type: "schedule_series", id: s.id });
}

function validateSpec(spec: SeriesSpec) {
  try {
    zonedToUtc(spec.dtstartLocal, spec.timezone);
    if (spec.rrule) expand(spec, new Date(0), new Date(1));
  } catch {
    throw unprocessable("invalid_rule", "Regra de repetição inválida.");
  }
}

function inputSpec(body: ScheduleSeriesInput, timezone: string): SeriesSpec {
  const spec = {
    dtstartLocal: `${body.startDate}T${body.startTime}`,
    timezone,
    durationMinutes: body.durationMinutes,
    rrule: ruleOf(body.repeat),
    untilLocal: body.untilDate ?? null,
  };
  validateSpec(spec);
  return spec;
}

function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------

route("GET", "/v1/schedule", async (ctx) => {
  const q = ctx.url.searchParams;
  const from = q.get("from") ?? "";
  const to = q.get("to") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) throw badRequest("invalid_window", "Informe from e to (AAAA-MM-DD).");
  if (addDays(from, 93) < to) throw badRequest("window_too_large", "Janela máxima de 93 dias.");
  const serviceFilter = q.get("serviceId") || null;
  const mine = q.get("mine") === "1";

  return tenantTx(ctx, async (tx) => {
    const [tenant] = await tx<{ timezone: string }[]>`select timezone from app.tenants where id = ${ctx.tenantId}`;
    const tz = tenant!.timezone;
    const winFrom = localDayBounds(from, tz).start;
    const winTo = localDayBounds(to, tz).end;
    const services = await tx<ServiceRow[]>`select * from app.tenant_active_services()`;
    const serviceIds = services.map((s) => s.service_id);

    // Todas as séries visíveis na janela (a RLS esconde rascunhos de quem não monta escala).
    const series = await tx.unsafe<SeriesRow[]>(
      `select ${SERIES_COLS} from app.schedule_series
       where status <> 'cancelled' and service_id = any($1::uuid[])
         and dtstart_local < $2::date + 1 and (until_local is null or until_local >= $3::date - 2)
       order by dtstart_local`,
      [serviceIds, to, from],
    );
    const exceptions = series.length
      ? await tx<{ series_id: string; start: string; kind: string; assignee_user_id: string | null; reason: string | null }[]>`
          select series_id, to_char(original_start_local, 'YYYY-MM-DD"T"HH24:MI') as start, kind, assignee_user_id, reason
          from app.schedule_exceptions where series_id = any(${series.map((s) => s.id)}::uuid[]) and kind <> 'none'`
      : [];
    const exc = new Map(exceptions.map((e) => [`${e.series_id}|${e.start}`, e]));

    const occurrences = series.flatMap((s) =>
      expand(specOf(s), winFrom, winTo).map((o) => {
        const e = exc.get(`${s.id}|${o.originalStartLocal}`);
        return {
          seriesId: s.id,
          serviceId: s.service_id,
          modality: s.modality,
          seriesStatus: s.status,
          timezone: s.timezone,
          originalStart: o.originalStartLocal,
          start: o.start.toISOString(),
          end: o.end.toISOString(),
          assigneeUserId: e?.kind === "reassigned" ? e.assignee_user_id! : s.assignee_user_id,
          scheduledUserId: s.assignee_user_id,
          exception: (e?.kind ?? null) as "cancelled" | "reassigned" | null,
          reason: e?.reason ?? null,
          conflictWith: [] as string[],
        };
      }),
    );

    // Sobreposição do mesmo profissional (qualquer serviço/hospital visível).
    const byUser = new Map<string, typeof occurrences>();
    for (const o of occurrences) if (o.exception !== "cancelled") byUser.set(o.assigneeUserId, [...(byUser.get(o.assigneeUserId) ?? []), o]);
    for (const list of byUser.values()) {
      list.sort((a, b) => a.start.localeCompare(b.start));
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length && list[j]!.start < list[i]!.end; j++) {
          list[i]!.conflictWith.push(list[j]!.serviceId);
          list[j]!.conflictWith.push(list[i]!.serviceId);
        }
    }

    const userIds = [...new Set(occurrences.flatMap((o) => [o.assigneeUserId, o.scheduledUserId]).concat(series.map((s) => s.assignee_user_id)))];
    const users = userIds.length ? await tx<{ id: string; display_name: string }[]>`select id, display_name from app.users where id = any(${userIds}::uuid[])` : [];
    const names = Object.fromEntries(users.map((u) => [u.id, u.display_name]));

    const visible = occurrences
      .filter((o) => (!serviceFilter || o.serviceId === serviceFilter) && (!mine || o.assigneeUserId === ctx.session.userId))
      .sort((a, b) => a.start.localeCompare(b.start));

    return json({
      timezone: tz,
      services: services.map((s) => ({
        id: s.service_id,
        name: s.service_name,
        hospitalId: s.hospital_id,
        hospitalName: s.hospital_name,
        timezone: s.hospital_timezone,
        canDraft: s.can_draft,
        canPublish: s.can_publish,
      })),
      series: series
        .filter((s) => !serviceFilter || s.service_id === serviceFilter)
        .map((s) => ({
          id: s.id,
          serviceId: s.service_id,
          modality: s.modality,
          assigneeUserId: s.assignee_user_id,
          startDate: s.dtstart.slice(0, 10),
          startTime: s.dtstart.slice(11),
          durationMinutes: s.duration_minutes,
          repeat: repeatOf(s.rrule),
          rrule: s.rrule,
          untilDate: s.until,
          notes: s.notes,
          status: s.status,
          version: s.version,
        })),
      occurrences: visible,
      names,
    });
  });
});

route("GET", "/v1/schedule/assignable", async (ctx) => {
  const serviceId = ctx.url.searchParams.get("serviceId") ?? "";
  return tenantTx(ctx, async (tx) => {
    await loadService(tx, serviceId).catch(() => {
      throw notFound();
    });
    await requireCap(ctx, tx, serviceId, "schedule.draft", { type: "service", id: serviceId });
    const rows = await tx<{ user_id: string; display_name: string }[]>`select * from app.schedule_assignable(${serviceId})`;
    return json({ people: rows.map((r) => ({ id: r.user_id, name: r.display_name })) });
  });
});

route("POST", "/v1/schedule/preview", async (ctx) => {
  const body = await readJson(ctx.req, ScheduleSeriesInput);
  return tenantTx(ctx, async (tx) => {
    const svc = await loadService(tx, body.serviceId);
    await requireCap(ctx, tx, svc.service_id, "schedule.draft");
    const spec = inputSpec(body, svc.hospital_timezone);
    const start = zonedToUtc(spec.dtstartLocal, spec.timezone);
    const occ = expand(spec, start, new Date(start.getTime() + 400 * 86_400_000), 12);
    return json({ rrule: spec.rrule, timezone: spec.timezone, occurrences: occ.map((o) => ({ originalStart: o.originalStartLocal, start: o.start, end: o.end })) });
  });
});

async function insertSeries(tx: Tx, ctx: Ctx, body: ScheduleSeriesInput, status: string, splitFrom: string | null): Promise<string> {
  const svc = await loadService(tx, body.serviceId);
  await requireCap(ctx, tx, svc.service_id, "schedule.draft", { type: "service", id: svc.service_id });
  if (status !== "draft") await requireCap(ctx, tx, svc.service_id, "schedule.publish", { type: "service", id: svc.service_id });
  await assertAssignable(tx, svc.service_id, body.assigneeUserId);
  const spec = inputSpec(body, svc.hospital_timezone);
  const [r] = await tx<{ id: string }[]>`
    insert into app.schedule_series (tenant_id, hospital_id, service_id, modality, assignee_user_id, timezone, dtstart_local,
      duration_minutes, rrule, until_local, notes, status, split_from, created_by, published_at, published_by)
    values (${ctx.tenantId}, ${svc.hospital_id}, ${svc.service_id}, ${body.modality}, ${body.assigneeUserId}, ${spec.timezone},
      ${spec.dtstartLocal}::timestamp, ${spec.durationMinutes}, ${spec.rrule}, ${spec.untilLocal}::date, ${body.notes || null}, ${status},
      ${splitFrom}, ${ctx.session.userId}, ${status === "published" ? new Date() : null}, ${status === "published" ? ctx.session.userId : null})
    returning id`;
  return r!.id;
}

route("POST", "/v1/schedule/series", async (ctx) => {
  const body = await readJson(ctx.req, ScheduleSeriesInput);
  return tenantTx(ctx, async (tx) => {
    const id = await insertSeries(tx, ctx, body, "draft", null);
    await audit(tx, ctx, "schedule.series.create", "schedule_series", id);
    return json({ id, version: 1, status: "draft" }, 201);
  });
});

/** Edita a série inteira (inclusive ocorrências passadas). */
route("PATCH", "/v1/schedule/series/:id", async (ctx) => {
  const id = uuidParam(ctx);
  const expected = ifMatchVersion(ctx.req);
  const body = await readJson(ctx.req, ScheduleSeriesInput);
  return tenantTx(ctx, async (tx) => {
    const s = await loadSeries(tx, id);
    await requireEdit(ctx, tx, s);
    if (s.status === "cancelled") throw conflict("cancelled", "Série cancelada.");
    if (s.version !== expected) throw conflict("version_conflict", "A série foi alterada por outra pessoa. Recarregue.", { currentVersion: s.version });
    const svc = await loadService(tx, body.serviceId);
    await requireCap(ctx, tx, svc.service_id, s.status === "draft" ? "schedule.draft" : "schedule.publish", { type: "service", id: svc.service_id });
    await assertAssignable(tx, svc.service_id, body.assigneeUserId);
    const spec = inputSpec(body, svc.hospital_timezone);
    const r = await tx`
      update app.schedule_series set hospital_id = ${svc.hospital_id}, service_id = ${svc.service_id}, modality = ${body.modality},
        assignee_user_id = ${body.assigneeUserId}, timezone = ${spec.timezone}, dtstart_local = ${spec.dtstartLocal}::timestamp,
        duration_minutes = ${spec.durationMinutes}, rrule = ${spec.rrule}, until_local = ${spec.untilLocal}::date, notes = ${body.notes || null},
        version = version + 1, updated_at = now()
      where id = ${id} and version = ${expected}`;
    if (r.count === 0) throw conflict("version_conflict", "A série foi alterada por outra pessoa. Recarregue.");
    await audit(tx, ctx, "schedule.series.update", "schedule_series", id);
    if (s.status === "published") {
      for (const u of new Set([s.assignee_user_id, body.assigneeUserId]))
        await emitOutbox(tx, ctx, "schedule.changed", "schedule_series", id, { serviceId: svc.service_id, assigneeUserId: u });
    }
    return json({ id, version: expected + 1 });
  });
});

/** "Esta e as próximas": encerra a série na véspera e cria a continuação com as mudanças. */
route("POST", "/v1/schedule/series/:id/split", async (ctx) => {
  const id = uuidParam(ctx);
  const expected = ifMatchVersion(ctx.req);
  const body = await readJson(ctx.req, SplitSeries);
  return tenantTx(ctx, async (tx) => {
    const s = await loadSeries(tx, id);
    await requireEdit(ctx, tx, s);
    if (s.status === "cancelled") throw conflict("cancelled", "Série cancelada.");
    if (s.version !== expected) throw conflict("version_conflict", "A série foi alterada por outra pessoa. Recarregue.", { currentVersion: s.version });
    if (body.fromDate <= s.dtstart.slice(0, 10)) throw unprocessable("split_at_start", "A partir do início da série, edite a série inteira.");
    if (s.until && body.fromDate > s.until) throw unprocessable("split_after_end", "A série já terminou antes dessa data.");
    if (body.changes.startDate < body.fromDate) throw unprocessable("split_start", "A continuação precisa começar a partir da data escolhida.");
    await tx`update app.schedule_series set until_local = ${addDays(body.fromDate, -1)}::date, version = version + 1, updated_at = now()
             where id = ${id} and version = ${expected}`;
    const newId = await insertSeries(tx, ctx, body.changes, s.status, id);
    await audit(tx, ctx, "schedule.series.split", "schedule_series", id);
    if (s.status === "published") {
      for (const u of new Set([s.assignee_user_id, body.changes.assigneeUserId]))
        await emitOutbox(tx, ctx, "schedule.changed", "schedule_series", newId, { serviceId: body.changes.serviceId, assigneeUserId: u });
    }
    return json({ id: newId }, 201);
  });
});

route("POST", "/v1/schedule/series/:id/end", async (ctx) => {
  const id = uuidParam(ctx);
  const body = await readJson(ctx.req, EndSeries);
  return tenantTx(ctx, async (tx) => {
    const s = await loadSeries(tx, id);
    await requireEdit(ctx, tx, s);
    if (body.lastDate < s.dtstart.slice(0, 10)) throw unprocessable("end_before_start", "Data anterior ao início da série.");
    await tx`update app.schedule_series set until_local = ${body.lastDate}::date, version = version + 1, updated_at = now() where id = ${id}`;
    await audit(tx, ctx, "schedule.series.end", "schedule_series", id);
    if (s.status === "published")
      await emitOutbox(tx, ctx, "schedule.changed", "schedule_series", id, { serviceId: s.service_id, assigneeUserId: s.assignee_user_id });
    return json({ ok: true });
  });
});

route("POST", "/v1/schedule/series/:id/publish", async (ctx) => {
  const id = uuidParam(ctx);
  return tenantTx(ctx, async (tx) => {
    const s = await loadSeries(tx, id);
    await requireCap(ctx, tx, s.service_id, "schedule.publish", { type: "schedule_series", id });
    if (s.status !== "draft") throw conflict("not_draft", "Só rascunhos podem ser publicados.");
    await tx`update app.schedule_series set status = 'published', published_at = now(), published_by = ${ctx.session.userId},
             version = version + 1, updated_at = now() where id = ${id}`;
    await audit(tx, ctx, "schedule.series.publish", "schedule_series", id);
    const [ex] = await tx<{ ids: string[] }[]>`
      select coalesce(array_agg(distinct assignee_user_id::text), '{}') as ids from app.schedule_exceptions
      where series_id = ${id} and kind = 'reassigned'`;
    for (const u of new Set([s.assignee_user_id, ...(ex?.ids ?? [])]))
      await emitOutbox(tx, ctx, "schedule.published", "schedule_series", id, { serviceId: s.service_id, assigneeUserId: u });
    return json({ ok: true, status: "published" });
  });
});

route("POST", "/v1/schedule/series/:id/cancel", async (ctx) => {
  const id = uuidParam(ctx);
  return tenantTx(ctx, async (tx) => {
    const s = await loadSeries(tx, id);
    await requireEdit(ctx, tx, s);
    await tx`update app.schedule_series set status = 'cancelled', version = version + 1, updated_at = now() where id = ${id}`;
    await audit(tx, ctx, "schedule.series.cancel", "schedule_series", id);
    if (s.status === "published")
      await emitOutbox(tx, ctx, "schedule.changed", "schedule_series", id, { serviceId: s.service_id, assigneeUserId: s.assignee_user_id });
    return json({ ok: true });
  });
});

/** Exceção de uma ocorrência ("somente esta"): cancelar, trocar profissional ou desfazer. */
route("PUT", "/v1/schedule/series/:id/exceptions", async (ctx) => {
  const id = uuidParam(ctx);
  const body = await readJson(ctx.req, ScheduleException);
  return tenantTx(ctx, async (tx) => {
    const s = await loadSeries(tx, id);
    await requireEdit(ctx, tx, s);
    if (s.status === "cancelled") throw conflict("cancelled", "Série cancelada.");
    const at = zonedToUtc(body.originalStart, s.timezone);
    const hit = expand(specOf(s), new Date(at.getTime() - 60_000), new Date(at.getTime() + 60_000)).some(
      (o) => o.originalStartLocal === body.originalStart,
    );
    if (!hit) throw unprocessable("not_an_occurrence", "Essa data não é uma ocorrência da série.");
    if (body.kind === "reassigned") {
      if (body.assigneeUserId === s.assignee_user_id) throw unprocessable("same_assignee", "Escolha outro profissional.");
      await assertAssignable(tx, s.service_id, body.assigneeUserId!);
    }
    const [prev] = await tx<{ assignee_user_id: string | null }[]>`
      select assignee_user_id from app.schedule_exceptions where series_id = ${id} and original_start_local = ${body.originalStart}::timestamp`;
    await tx`
      insert into app.schedule_exceptions (tenant_id, series_id, original_start_local, kind, assignee_user_id, reason, updated_by)
      values (${ctx.tenantId}, ${id}, ${body.originalStart}::timestamp, ${body.kind}, ${body.assigneeUserId ?? null}, ${body.reason || null}, ${ctx.session.userId})
      on conflict (series_id, original_start_local) do update
        set kind = excluded.kind, assignee_user_id = excluded.assignee_user_id, reason = excluded.reason,
            updated_by = excluded.updated_by, updated_at = now()`;
    await tx`update app.schedule_series set version = version + 1, updated_at = now() where id = ${id}`;
    await audit(tx, ctx, `schedule.exception.${body.kind}`, "schedule_series", id);
    if (s.status === "published") {
      for (const u of new Set([s.assignee_user_id, body.assigneeUserId, prev?.assignee_user_id].filter(Boolean) as string[]))
        await emitOutbox(tx, ctx, "schedule.changed", "schedule_series", id, { serviceId: s.service_id, assigneeUserId: u });
    }
    return json({ ok: true });
  });
});

