import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storagePath } from "@evolu/config";
import { withContext } from "@evolu/database";
import { processJobsOnce } from "../../apps/worker/src/index";
import { appDb, call, FX, idem, login, ownerDb, sampleContent, teardown, workerDb } from "../helpers/api";

/** SEC-01..SEC-05: isolamento por tenant/serviço na API, no SQL, em arquivos e em jobs. */
describe("isolamento e autorização", () => {
  const P: Record<string, string> = {};
  const app = appDb();
  const worker = workerDb();
  const owner = ownerDb();

  beforeAll(async () => {
    for (const p of ["bruno", "ana", "carla", "fabio", "diana", "eduardo", "gabriela"] as const) P[p] = await login(p);
  });
  afterAll(async () => {
    await owner`update app.role_grants set revoked_at = null, revoked_by = null where user_id = ${FX.users.ana}`;
    await Promise.all([app.end(), worker.end(), owner.end()]);
    await teardown();
  });

  describe("autenticação", () => {
    it("sem sessão → 401", async () => {
      expect((await call(null, "GET", "/v1/me", { tenant: null })).status).toBe(401);
    });
    it("sessão sem segundo fator → 401 mfa_required", async () => {
      const c = await login("ana", { mfa: false });
      const r = await call(c, "GET", "/v1/me", { tenant: null });
      expect(r.status).toBe(401);
      expect(r.data.error.code).toBe("mfa_required");
    });
    it("escrita com Origin externo é rejeitada (CSRF)", async () => {
      const r = await call(P.ana!, "POST", `/v1/episodes/${FX.ep.neuroA1_1}/notes`, { body: {}, origin: "https://atacante.example" });
      expect(r.status).toBe(403);
    });
    it("login simulado não vira operador de demonstração", async () => {
      const r = await call(P.bruno!, "GET", "/v1/me", { tenant: null });
      expect(r.status).toBe(200);
      expect(r.data.isDemoOperator).toBe(false);
      expect((await call(P.bruno!, "GET", "/v1/demo/personas", { tenant: null })).status).toBe(403);
    });
  });

  describe("SEC-01 tenant cruzado", () => {
    it("identidade global sem vínculo no tenant não entra", async () => {
      const r = await call(P.ana!, "GET", `/v1/worklist?serviceId=${FX.neuroB1}`, { tenant: FX.tenantB });
      expect(r.status).toBe(403);
    });
    it("recurso de outro tenant é 404 indistinguível", async () => {
      const cross = await call(P.eduardo!, "GET", `/v1/episodes/${FX.ep.neuroA1_1}`, { tenant: FX.tenantB });
      const missing = await call(P.eduardo!, "GET", "/v1/episodes/00000000-0000-4000-8000-000000000000", { tenant: FX.tenantB });
      expect(cross.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(cross.data.error.code).toBe(missing.data.error.code);
    });
    it("coordenador multi-tenant: tenant ativo decide o que é visível", async () => {
      expect((await call(P.bruno!, "GET", `/v1/episodes/${FX.ep.neuroB1_1}`, { tenant: FX.tenantA })).status).toBe(404);
      expect((await call(P.bruno!, "GET", `/v1/episodes/${FX.ep.neuroB1_1}`, { tenant: FX.tenantB })).status).toBe(200);
    });
    it("X-Tenant-Id inválido é rejeitado", async () => {
      const r = await call(P.ana!, "GET", `/v1/context`, { tenant: "nao-e-uuid" });
      expect(r.status).toBe(403);
      expect(r.data.error.code).toBe("tenant_required");
    });
  });

  describe("SEC-02 serviço sem vínculo", () => {
    it("coordenador não vê o serviço em que não tem vínculo (cardio)", async () => {
      expect((await call(P.bruno!, "GET", `/v1/worklist?serviceId=${FX.cardioA1}`)).status).toBe(403);
      expect((await call(P.bruno!, "GET", `/v1/episodes/${FX.ep.cardioA1_1}`)).status).toBe(404);
    });
    it("assistente restrita não vê outro serviço do mesmo hospital", async () => {
      expect((await call(P.ana!, "GET", `/v1/episodes/${FX.ep.clinA1_1}`)).status).toBe(404);
      expect((await call(P.diana!, "GET", `/v1/episodes/${FX.ep.neuroA1_1}`)).status).toBe(404);
    });
  });

  describe("SEC-03 papéis sem acesso clínico", () => {
    it("secretária vê censo sem conteúdo clínico e não lê notas", async () => {
      const w = await call(P.carla!, "GET", `/v1/worklist?serviceId=${FX.neuroA1}`);
      expect(w.status).toBe(200);
      expect(w.data.items.length).toBeGreaterThan(0);
      for (const it of w.data.items) expect(it.clinical ?? null).toBeNull();
      expect(JSON.stringify(w.data)).not.toContain("déficit motor");
      expect((await call(P.carla!, "POST", `/v1/episodes/${FX.ep.neuroA1_1}/notes`, { body: {} })).status).toBe(403);
    });
    it("financeiro e admin do tenant não acessam dado clínico", async () => {
      // Financeiro: nem cadastro de paciente.
      expect((await call(P.fabio!, "GET", `/v1/worklist?serviceId=${FX.neuroA1}`)).status).toBe(403);
      expect((await call(P.fabio!, "GET", `/v1/episodes/${FX.ep.neuroA1_1}`)).status).toBe(404);
      // Admin do tenant: cadastro mínimo (organização do censo), nunca conteúdo clínico.
      const w = await call(P.gabriela!, "GET", `/v1/worklist?serviceId=${FX.neuroA1}`);
      expect(w.status).toBe(200);
      for (const it of w.data.items) expect(it.clinical ?? null).toBeNull();
      const e = await call(P.gabriela!, "GET", `/v1/episodes/${FX.ep.neuroA1_1}`);
      expect(e.status).toBe(200);
      expect(e.data.clinical).toBeNull();
      expect(JSON.stringify([w.data, e.data])).not.toContain("déficit motor");
      expect((await call(P.gabriela!, "POST", `/v1/episodes/${FX.ep.neuroA1_1}/notes`, { body: {} })).status).toBe(403);
    });
    it("auditoria: admin lê; assistente não", async () => {
      expect((await call(P.gabriela!, "GET", "/v1/audit")).status).toBe(200);
      expect((await call(P.ana!, "GET", "/v1/audit")).status).toBe(403);
    });
    it("eventos de auditoria não carregam conteúdo clínico", async () => {
      const r = await call(P.gabriela!, "GET", "/v1/audit");
      expect(JSON.stringify(r.data)).not.toMatch(/Sintético (Alfa|Bravo)|déficit/);
    });
  });

  describe("SQL direto com o papel da aplicação (RLS)", () => {
    it("sem contexto não há linhas", async () => {
      const [r] = await app`select count(*)::int n from app.patients`;
      expect(r!.n).toBe(0);
    });
    it("contexto do tenant A não enxerga pacientes do tenant B", async () => {
      const rows = await withContext(app, { userId: FX.users.bruno, tenantId: FX.tenantA }, (tx) =>
        tx`select tenant_id from app.patients`);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.tenant_id === FX.tenantA)).toBe(true);
    });
    it("forjar tenant sem vínculo não revela nada", async () => {
      const rows = await withContext(app, { userId: FX.users.ana, tenantId: FX.tenantB }, (tx) =>
        tx`select id from app.service_episodes`);
      expect(rows).toHaveLength(0);
    });
    it("o papel da aplicação não tem BYPASSRLS nem superuser", async () => {
      const [r] = await app`select rolbypassrls, rolsuper from pg_roles where rolname = current_user`;
      expect(r).toEqual({ rolbypassrls: false, rolsuper: false });
    });
    it("SEC-05 contexto não vaza para a próxima transação do pool", async () => {
      await withContext(app, { userId: FX.users.bruno, tenantId: FX.tenantA }, (tx) => tx`select 1`);
      const [r] = await app`select current_setting('app.user_id', true) u, current_setting('app.tenant_id', true) t`;
      expect(r!.u || null).toBeNull();
      expect(r!.t || null).toBeNull();
    });
  });

  describe("arquivos", () => {
    const pdf = new Uint8Array([...Buffer.from("%PDF-1.4\n% sintético\n")]);
    let docId = "";
    it("upload aceita só tipos permitidos por conteúdo", async () => {
      const fake = new FormData();
      fake.set("file", new Blob([Buffer.from("MZ executável")]), "x.pdf");
      expect((await call(P.ana!, "POST", `/v1/episodes/${FX.ep.neuroA1_1}/documents`, { rawBody: fake })).status).toBe(415);

      const form = new FormData();
      form.set("file", new Blob([pdf], { type: "application/pdf" }), "laudo.pdf");
      const r = await call(P.ana!, "POST", `/v1/episodes/${FX.ep.neuroA1_1}/documents`, { rawBody: form });
      expect(r.status).toBe(201);
      docId = r.data.id;
    });
    it("download só para quem tem escopo; outro tenant/serviço recebe 404", async () => {
      const ok = await call(P.ana!, "GET", `/v1/documents/${docId}/content`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-security-policy")).toContain("sandbox");
      expect((await call(P.diana!, "GET", `/v1/documents/${docId}/content`)).status).toBe(404);
      expect((await call(P.eduardo!, "GET", `/v1/documents/${docId}/content`, { tenant: FX.tenantB })).status).toBe(404);
      expect((await call(P.carla!, "GET", `/v1/documents/${docId}/content`)).status).toBe(404);
    });
    it("chave de armazenamento rejeita path traversal", () => {
      expect(() => storagePath("../etc/passwd")).toThrow();
      expect(() => storagePath(`documents/${FX.tenantA}/../../x`)).toThrow();
    });
  });

  describe("SEC-04 jobs revalidam o vínculo", () => {
    it("exportação pedida antes da revogação é cancelada no worker", async () => {
      const n = await call(P.ana!, "POST", `/v1/episodes/${FX.ep.neuroA1_2}/notes`, { body: {} });
      expect(n.status).toBe(201);
      const probs = await call(P.ana!, "GET", `/v1/episodes/${FX.ep.neuroA1_2}`);
      const pids = probs.data.clinical.problems.map((p: any) => p.id);
      await call(P.ana!, "PATCH", `/v1/notes/${n.data.id}`, {
        body: { content: sampleContent(pids), attendedAt: new Date(Date.now() - 60_000).toISOString() },
        ifMatch: 1,
      });
      const f = await call(P.ana!, "POST", `/v1/notes/${n.data.id}/finalize`, { body: {}, ifMatch: 2, idem: idem() });
      expect(f.status).toBe(200);
      const x = await call(P.ana!, "POST", `/v1/notes/${n.data.id}/exports`, { body: {} });
      expect(x.status).toBe(202);

      await owner`update app.role_grants set revoked_at = now() where user_id = ${FX.users.ana}`;
      await processJobsOnce(worker, "test-worker-sec04");
      const [job] = await owner`select status, last_error_code from app.jobs where idempotency_key = ${x.data.id}`;
      expect(job!.status).toBe("cancelled");
      const [exp] = await owner`select status, storage_key from app.note_exports where id = ${x.data.id}`;
      expect(exp!.storage_key).toBeNull();

      // A sessão continua válida, mas o acesso clínico some imediatamente.
      expect((await call(P.ana!, "GET", `/v1/episodes/${FX.ep.neuroA1_2}`)).status).toBe(404);
    });
  });
});
