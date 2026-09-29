import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleAuth } from "@evolu/api";
import { BASE, call, FX, login, ownerDb, teardown } from "../helpers/api";

/** Login simulado de alguém fora das personas (convidado recém-cadastrado). */
async function loginAs(subject: string): Promise<string> {
  const res = await handleAuth(new Request(`${BASE}/auth/login?as=${subject}`));
  if (res.status !== 303) throw new Error(`login falhou: ${res.status}`);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

/** ADM: administração do tenant (hospitais, serviços, convites) e criação de tenants pela plataforma. */
describe("administração da equipe", () => {
  const P: Record<string, string> = {};
  const owner = ownerDb();
  let hospitalId = "";
  let serviceId = "";

  beforeAll(async () => {
    for (const p of ["gabriela", "ana", "eduardo", "bruno"] as const) P[p] = await login(p);
  });
  afterAll(async () => {
    await owner`delete from app.platform_admins`;
    await owner.end();
    await teardown();
  });

  it("quem não administra recebe 403 e não cria contas", async () => {
    expect((await call(P.ana!, "GET", "/v1/admin/overview")).status).toBe(403);
    const r = await call(P.ana!, "POST", "/v1/admin/members", {
      body: { email: "intruso@teste.invalid", name: "Intruso", grants: [{ role: "resident" }] },
    });
    expect(r.status).toBe(403);
    const [u] = await owner`select 1 from app.user_identities where subject = 'intruso'`;
    expect(u).toBeUndefined();
  });

  it("admin não tem acesso clínico por ser admin", async () => {
    const r = await call(P.gabriela!, "GET", `/v1/episodes/${FX.ep.neuroA1_1}`);
    // Dados cadastrais sim (patient.basic.read da matriz), conteúdo clínico não.
    if (r.status === 200) expect(r.data.clinical ?? null).toBeNull();
    else expect(r.status).toBe(404);
  });

  it("admin cria hospital e serviço", async () => {
    const h = await call(P.gabriela!, "POST", "/v1/admin/hospitals", { body: { name: "Hospital Teste Admin", timezone: "America/Sao_Paulo" } });
    expect(h.status).toBe(201);
    hospitalId = h.data.id;
    const s = await call(P.gabriela!, "POST", "/v1/admin/services", { body: { hospitalId, name: "Neuro Teste", specialty: "neurologia" } });
    expect(s.status).toBe(201);
    serviceId = s.data.id;
    const o = await call(P.gabriela!, "GET", "/v1/admin/overview");
    expect(o.status).toBe(200);
    expect(o.data.services.find((x: { id: string }) => x.id === serviceId)?.specialty).toMatch(/neurologia/i);
  });

  it("convite: o convidado entra e vê só o escopo concedido", async () => {
    const r = await call(P.gabriela!, "POST", "/v1/admin/members", {
      body: { email: "Novata@teste.invalid", name: "Novata Teste", grants: [{ role: "attending_physician", hospitalId, serviceId }] },
    });
    expect(r.status).toBe(201);
    expect(r.data.invite.link).toContain("as=novata");
    const c = await loginAs("novata");
    const ctx = await call(c, "GET", "/v1/context");
    expect(ctx.status).toBe(200);
    expect(ctx.data.services.map((s: { id: string }) => s.id)).toEqual([serviceId]);
    expect((await call(c, "GET", `/v1/episodes/${FX.ep.neuroA1_1}`)).status).toBe(404);
    // Já acessou: não precisa de novo convite.
    expect((await call(P.gabriela!, "POST", `/v1/admin/members/${r.data.userId}/invite`)).status).toBe(409);
  });

  it("serviço desativado some do contexto", async () => {
    await call(P.gabriela!, "PATCH", `/v1/admin/services/${serviceId}`, { body: { active: false } });
    const c = await loginAs("novata");
    expect((await call(c, "GET", "/v1/context")).data.services).toEqual([]);
    await call(P.gabriela!, "PATCH", `/v1/admin/services/${serviceId}`, { body: { active: true } });
  });

  it("tenant cruzado: admin de outro tenant não altera nada", async () => {
    const r = await call(P.eduardo!, "POST", "/v1/admin/hospitals", { body: { name: "X", timezone: "America/Sao_Paulo" }, tenant: FX.tenantA });
    expect(r.status).toBe(403);
    const p = await call(P.gabriela!, "PATCH", `/v1/admin/hospitals/${FX.hospB1}`, { body: { name: "Invadido" } });
    expect(p.status).toBe(404);
    const [h] = await owner<{ name: string }[]>`select name from app.hospitals where id = ${FX.hospB1}`;
    expect(h!.name).not.toBe("Invadido");
  });

  it("serviço não pode ser criado em hospital de outro tenant", async () => {
    const r = await call(P.gabriela!, "POST", "/v1/admin/services", { body: { hospitalId: FX.hospB1, name: "X", specialty: "x" } });
    expect(r.status).toBe(404);
  });

  it("não é possível revogar o último administrador nem suspender a si mesmo", async () => {
    const o = await call(P.gabriela!, "GET", "/v1/admin/overview");
    const self = o.data.members.find((m: { isSelf: boolean }) => m.isSelf);
    const adminGrant = self.grants.find((g: { role: string }) => g.role === "tenant_admin");
    expect((await call(P.gabriela!, "POST", `/v1/admin/grants/${adminGrant.id}/revoke`)).status).toBe(409);
    const s = await call(P.gabriela!, "PATCH", `/v1/admin/members/${self.userId}`, { body: { status: "suspended" } });
    expect(s.status).toBe(403);
  });

  it("papéis de equipe inteira não aceitam escopo de serviço", async () => {
    const o = await call(P.gabriela!, "GET", "/v1/admin/overview");
    const novata = o.data.members.find((m: { email: string }) => m.email === "Novata@teste.invalid" || m.email === "novata@teste.invalid");
    const r = await call(P.gabriela!, "POST", `/v1/admin/members/${novata.userId}/grants`, {
      body: { role: "tenant_admin", hospitalId, serviceId },
    });
    expect(r.status).toBe(400);
  });

  describe("plataforma", () => {
    it("usuário comum não lista nem cria tenants", async () => {
      expect((await call(P.gabriela!, "GET", "/v1/platform/tenants", { tenant: null })).status).toBe(403);
      const r = await call(P.gabriela!, "POST", "/v1/platform/tenants", { tenant: null, body: { name: "X", timezone: "America/Sao_Paulo", admin: null } });
      expect(r.status).toBe(403);
    });

    it("operador cria tenant e vira o primeiro administrador", async () => {
      await owner`insert into app.platform_admins (user_id, note) values (${FX.users.bruno}, 'teste')`;
      const me = await call(P.bruno!, "GET", "/v1/me", { tenant: null });
      expect(me.data.isPlatformAdmin).toBe(true);
      const r = await call(P.bruno!, "POST", "/v1/platform/tenants", {
        tenant: null,
        body: { name: "Equipe Nova Ção", timezone: "America/Recife", admin: null },
      });
      expect(r.status).toBe(201);
      const o = await call(P.bruno!, "GET", "/v1/admin/overview", { tenant: r.data.id });
      expect(o.status).toBe(200);
      expect(o.data.tenant.timezone).toBe("America/Recife");
      // Isolamento: o novo tenant começa vazio e o operador não ganha acesso clínico.
      expect(o.data.hospitals).toEqual([]);
      const ctx = await call(P.bruno!, "GET", "/v1/context", { tenant: r.data.id });
      expect(ctx.data.services).toEqual([]);
      const list = await call(P.bruno!, "GET", "/v1/platform/tenants", { tenant: null });
      expect(list.data.tenants.some((t: { id: string }) => t.id === r.data.id)).toBe(true);
    });

    it("operador cria tenant convidando outra pessoa como administradora", async () => {
      const r = await call(P.bruno!, "POST", "/v1/platform/tenants", {
        tenant: null,
        body: { name: "Equipe Convidada", timezone: "America/Sao_Paulo", admin: { email: "chefia@teste.invalid", name: "Chefia" } },
      });
      expect(r.status).toBe(201);
      const c = await loginAs("chefia");
      expect((await call(c, "GET", "/v1/admin/overview", { tenant: r.data.id })).status).toBe(200);
      // A convidada não administra o tenant A.
      expect((await call(c, "GET", "/v1/admin/overview", { tenant: FX.tenantA })).status).toBe(403);
    });
  });
});
