import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, FX, login, ownerDb, teardown } from "../helpers/api";

/** Escala: rascunho → publicação, papéis (montar ≠ publicar), visibilidade e isolamento entre tenants. */
describe("escala", () => {
  const P: Record<string, string> = {};
  const owner = ownerDb();
  let seriesId = "";
  const OCT = "/v1/schedule?from=2026-10-01&to=2026-10-31";
  const body = {
    serviceId: FX.neuroA1,
    modality: "visita",
    assigneeUserId: FX.users.ana,
    startDate: "2026-10-05",
    startTime: "08:00",
    durationMinutes: 240,
    repeat: { freq: "weekly", interval: 1, byDay: ["MO"] },
  };
  const ofSeries = (r: { data: { occurrences: { seriesId: string }[] } }) => r.data.occurrences.filter((o) => o.seriesId === seriesId);

  beforeAll(async () => {
    for (const p of ["bruno", "ana", "carla", "diana", "eduardo"] as const) P[p] = await login(p);
  });
  afterAll(async () => {
    await owner.end();
    await teardown();
  });

  it("médico assistente não monta escala", async () => {
    expect((await call(P.ana!, "POST", "/v1/schedule/series", { body })).status).toBe(403);
  });

  it("secretária monta rascunho; profissional sem vínculo no serviço é recusado", async () => {
    const bad = await call(P.carla!, "POST", "/v1/schedule/series", { body: { ...body, assigneeUserId: FX.users.diana } });
    expect(bad.status).toBe(422);
    const r = await call(P.carla!, "POST", "/v1/schedule/series", { body });
    expect(r.status).toBe(201);
    seriesId = r.data.id;
    expect(ofSeries(await call(P.carla!, "GET", OCT)).map((o) => (o as unknown as { originalStart: string }).originalStart)).toEqual([
      "2026-10-05T08:00",
      "2026-10-12T08:00",
      "2026-10-19T08:00",
      "2026-10-26T08:00",
    ]);
  });

  it("rascunho é invisível para quem não monta escala", async () => {
    expect(ofSeries(await call(P.ana!, "GET", OCT))).toHaveLength(0);
    expect(ofSeries(await call(P.diana!, "GET", OCT))).toHaveLength(0);
  });

  it("secretária não publica; coordenador publica e o escalado é notificado", async () => {
    expect((await call(P.carla!, "POST", `/v1/schedule/series/${seriesId}/publish`)).status).toBe(403);
    expect((await call(P.bruno!, "POST", `/v1/schedule/series/${seriesId}/publish`)).status).toBe(200);
    const [ev] = await owner`select payload from app.outbox_events where event_type = 'schedule.published' and aggregate_id = ${seriesId}`;
    expect(ev?.payload.assigneeUserId).toBe(FX.users.ana);
  });

  it("escala publicada é visível a todo membro ativo do tenant", async () => {
    expect(ofSeries(await call(P.ana!, "GET", OCT))).toHaveLength(4);
    expect(ofSeries(await call(P.diana!, "GET", OCT))).toHaveLength(4);
    expect(ofSeries(await call(P.ana!, "GET", `${OCT}&mine=1`))).toHaveLength(4);
  });

  it("publicado só é alterado por quem publica; exceção só em ocorrência real", async () => {
    const [v] = await owner`select version from app.schedule_series where id = ${seriesId}`;
    expect((await call(P.carla!, "PATCH", `/v1/schedule/series/${seriesId}`, { body, ifMatch: v!.version })).status).toBe(403);
    const exc = (originalStart: string) => ({ body: { originalStart, kind: "reassigned", assigneeUserId: FX.users.bruno, reason: "troca" } });
    expect((await call(P.carla!, "PUT", `/v1/schedule/series/${seriesId}/exceptions`, exc("2026-10-12T08:00"))).status).toBe(403);
    expect((await call(P.bruno!, "PUT", `/v1/schedule/series/${seriesId}/exceptions`, exc("2026-10-13T08:00"))).status).toBe(422);
    expect((await call(P.bruno!, "PUT", `/v1/schedule/series/${seriesId}/exceptions`, exc("2026-10-12T08:00"))).status).toBe(200);
    const occ = ofSeries(await call(P.ana!, "GET", OCT)) as unknown as { originalStart: string; assigneeUserId: string; exception: string }[];
    expect(occ.find((o) => o.originalStart === "2026-10-12T08:00")).toMatchObject({ assigneeUserId: FX.users.bruno, exception: "reassigned" });
    expect(ofSeries(await call(P.ana!, "GET", `${OCT}&mine=1`))).toHaveLength(3);
  });

  it("dividir 'deste turno em diante' encerra a série na véspera", async () => {
    const [v] = await owner`select version from app.schedule_series where id = ${seriesId}`;
    const r = await call(P.bruno!, "POST", `/v1/schedule/series/${seriesId}/split`, {
      ifMatch: v!.version,
      body: { fromDate: "2026-10-19", changes: { ...body, startDate: "2026-10-19", startTime: "09:00" } },
    });
    expect(r.status).toBe(201);
    const all = (await call(P.ana!, "GET", OCT)).data.occurrences as { originalStart: string; seriesId: string }[];
    const mine = all.filter((o) => o.seriesId === seriesId || o.seriesId === r.data.id).map((o) => o.originalStart);
    expect(mine).toEqual(["2026-10-05T08:00", "2026-10-12T08:00", "2026-10-19T09:00", "2026-10-26T09:00"]);
  });

  it("outro tenant não vê nem altera", async () => {
    expect((await call(P.eduardo!, "GET", OCT)).status).toBe(403);
    const other = await call(P.eduardo!, "GET", OCT, { tenant: FX.tenantB });
    expect(other.status).toBe(200);
    expect(ofSeries(other)).toHaveLength(0);
    expect((await call(P.eduardo!, "POST", `/v1/schedule/series/${seriesId}/cancel`, { tenant: FX.tenantB })).status).toBe(404);
    expect((await call(P.eduardo!, "POST", "/v1/schedule/series", { tenant: FX.tenantB, body })).status).toBe(404);
  });
});
