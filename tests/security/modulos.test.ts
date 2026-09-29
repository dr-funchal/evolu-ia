import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, FX, login, ownerDb, teardown } from "../helpers/api";

/** Módulo Passagens: opcional por equipe; desligado, a capacidade some em API, RLS e contexto. */
describe("módulo de passagens", () => {
  const P: Record<string, string> = {};
  const owner = ownerDb();
  const inbox = `/v1/handoffs?serviceId=${FX.neuroA1}&box=all`;
  const seen = async (who: string) => ((await call(P[who]!, "GET", inbox)).data.handoffs as unknown[]).length;
  let before = 0;
  const caps = async (who: string) =>
    ((await call(P[who]!, "GET", "/v1/context")).data.services as { id: string; capabilities: string[] }[]).find((s) => s.id === FX.neuroA1)!
      .capabilities;

  beforeAll(async () => {
    for (const p of ["gabriela", "ana", "bruno"] as const) P[p] = await login(p);
  });
  afterAll(async () => {
    await owner`update app.tenants set handoffs_enabled = true where id = ${FX.tenantA}`;
    await owner.end();
    await teardown();
  });

  it("equipe nova nasce com passagens desligadas", async () => {
    const [col] = await owner`select column_default from information_schema.columns
                              where table_schema = 'app' and table_name = 'tenants' and column_name = 'handoffs_enabled'`;
    expect(col?.column_default).toBe("false");
  });

  it("só o administrador liga/desliga", async () => {
    expect((await call(P.ana!, "PATCH", "/v1/admin/tenant", { body: { handoffsEnabled: false } })).status).toBe(403);
    expect((await call(P.gabriela!, "GET", "/v1/admin/overview")).data.tenant.modules.handoffs).toBe(true);
  });

  it("desligado: some do contexto e da função de capacidade; a RLS esconde o histórico", async () => {
    before = await seen("bruno");
    expect((await call(P.gabriela!, "PATCH", "/v1/admin/tenant", { body: { handoffsEnabled: false } })).status).toBe(200);
    const ctx = await call(P.ana!, "GET", "/v1/context");
    expect(ctx.data.tenant.modules.handoffs).toBe(false);
    expect(await caps("ana")).not.toContain("handoff.participate");
    expect(await caps("ana")).toContain("clinical.read");
    expect(await seen("bruno")).toBe(0);
    const [ok] = await owner`select app.user_has_cap(${FX.users.ana}, ${FX.tenantA}, ${FX.neuroA1}, 'handoff.participate') as ok`;
    expect(ok?.ok).toBe(false);
    const [a] = await owner`select action from app.audit_events where action = 'admin.module.handoffs.disable' limit 1`;
    expect(a).toBeDefined();
  });

  it("religado: tudo volta", async () => {
    expect((await call(P.gabriela!, "PATCH", "/v1/admin/tenant", { body: { handoffsEnabled: true } })).status).toBe(200);
    expect(await caps("ana")).toContain("handoff.participate");
    expect(await seen("bruno")).toBe(before);
  });
});
