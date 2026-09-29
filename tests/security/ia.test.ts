import { createServer, type Server } from "node:http";
import { openSecret, sealSecret } from "@evolu/config";
import { withContext } from "@evolu/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appDb, call, FX, login, ownerDb, teardown } from "../helpers/api";

/**
 * IA por equipe: chave do OpenRouter e modelo na Administração. Tudo contra um OpenRouter falso
 * em 127.0.0.1:18765 (vitest.config.ts); nenhum teste fala com a API real.
 */
const VALID = "sk-or-v1-chave-de-teste-valida-0000000abcd";
const seen: { path: string; auth: string | null; body: any }[] = [];

function fakeOpenRouter(): Promise<Server> {
  const models = {
    data: [
      { id: "acme/texto-1", name: "Acme Texto 1", created: 2, context_length: 128000, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, pricing: { prompt: "0.000001", completion: "0.000004" } },
      { id: "acme/texto-1:batch", name: "Acme Texto 1 (batch)", architecture: { output_modalities: ["text"] }, pricing: { prompt: "0.0000005", completion: "0.000002" } },
      { id: "acme/imagem", name: "Acme Imagem", architecture: { output_modalities: ["image"] }, pricing: { prompt: "0", completion: "0" } },
    ],
  };
  const stt = { data: [{ id: "acme/whisper", name: "Acme Whisper", architecture: { input_modalities: ["audio"], output_modalities: ["transcription"] }, pricing: { prompt: "0.0001", completion: "0" } }] };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = req.url ?? "";
      seen.push({ path: url, auth: req.headers.authorization ?? null, body: raw ? JSON.parse(raw) : null });
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      const authed = req.headers.authorization === `Bearer ${VALID}`;
      if (url === "/api/v1/models") return send(200, models);
      if (url === "/api/v1/models?output_modalities=transcription") return send(200, stt);
      if (url === "/api/v1/key") return authed ? send(200, { data: { limit: 10, limit_remaining: 9.5, usage: 0.5, is_free_tier: false } }) : send(401, { error: { message: "eco do pedido" } });
      if (url === "/api/v1/chat/completions")
        return authed
          ? send(200, { model: "acme/texto-1", choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 12, completion_tokens: 1, cost: 0.000016 } })
          : send(401, {});
      send(404, {});
    });
  });
  return new Promise((ok) => server.listen(18765, "127.0.0.1", () => ok(server)));
}

describe("IA por equipe (OpenRouter)", () => {
  const P: Record<string, string> = {};
  const owner = ownerDb();
  const app = appDb();
  let server: Server;

  beforeAll(async () => {
    server = await fakeOpenRouter();
    for (const p of ["gabriela", "ana", "eduardo"] as const) P[p] = await login(p);
  });
  afterAll(async () => {
    server.close();
    await owner`delete from app.ai_usage`;
    await owner`delete from app.tenant_ai_settings`;
    await owner.end();
    await app.end();
    await teardown();
  });

  it("só o administrador vê e altera; a chave não chega ao OpenRouter se o pedido é negado", async () => {
    const before = seen.length;
    expect((await call(P.ana!, "GET", "/v1/admin/ai")).status).toBe(403);
    expect((await call(P.ana!, "GET", "/v1/admin/ai/models")).status).toBe(403);
    expect((await call(P.ana!, "PUT", "/v1/admin/ai", { body: { apiKey: VALID } })).status).toBe(403);
    expect((await call(P.ana!, "POST", "/v1/admin/ai/test")).status).toBe(403);
    expect(seen.length).toBe(before);
  });

  it("catálogo: preços por 1 M tokens, transcrição por minuto, sem lote nem modelos que não geram texto", async () => {
    const r = await call(P.gabriela!, "GET", "/v1/admin/ai/models");
    expect(r.status).toBe(200);
    const ids = r.data.models.map((m: { id: string }) => m.id);
    expect(ids).toEqual(["acme/texto-1", "acme/whisper"]);
    expect(r.data.models[0].price).toMatchObject({ input: 1, output: 4, perMinute: null });
    expect(r.data.models[1]).toMatchObject({ kind: "transcription", price: { perMinute: 0.006 } });
  });

  it("chave inválida e modelo inexistente são recusados sem gravar nada", async () => {
    const bad = await call(P.gabriela!, "PUT", "/v1/admin/ai", { body: { apiKey: "sk-or-v1-chave-errada-000000000000" } });
    expect(bad.status).toBe(422);
    expect(bad.data.error.code).toBe("ai_invalid_key");
    expect(JSON.stringify(bad.data)).not.toContain("eco do pedido");
    const unknown = await call(P.gabriela!, "PUT", "/v1/admin/ai", { body: { apiKey: VALID, model: "acme/nao-existe" } });
    expect(unknown.data.error.code).toBe("ai_unknown_model");
    expect(await owner`select 1 from app.tenant_ai_settings`).toHaveLength(0);
  });

  it("habilitar exige chave e modelo", async () => {
    const r = await call(P.gabriela!, "PUT", "/v1/admin/ai", { body: { enabled: true } });
    expect(r.data.error.code).toBe("ai_incomplete");
  });

  it("salva cifrada: o banco e a API nunca devolvem a chave", async () => {
    expect((await call(P.gabriela!, "PUT", "/v1/admin/ai", { body: { apiKey: VALID, model: "acme/texto-1", transcriptionModel: "acme/whisper" } })).status).toBe(200);
    const g = await call(P.gabriela!, "GET", "/v1/admin/ai");
    expect(g.data).toMatchObject({ platformEnabled: true, enabled: false, hasKey: true, keyHint: "abcd", model: "acme/texto-1", zeroRetention: true });
    expect(JSON.stringify(g.data)).not.toContain(VALID);
    const [row] = await owner<{ api_key_enc: string }[]>`select api_key_enc from app.tenant_ai_settings where tenant_id = ${FX.tenantA}`;
    expect(row!.api_key_enc).not.toContain(VALID.slice(10));
    expect(openSecret(row!.api_key_enc, FX.tenantA)).toBe(VALID);
    // O texto cifrado está preso à equipe: em outro tenant não abre.
    expect(() => openSecret(row!.api_key_enc, FX.tenantB)).toThrow();
    const [a] = await owner<{ n: number }[]>`select count(*)::int n from app.audit_events where action = 'admin.ai.key.set' and tenant_id = ${FX.tenantA}`;
    expect(a!.n).toBe(1);
    // Desabilitada: não aparece para a equipe.
    expect((await call(P.ana!, "GET", "/v1/context")).data.tenant.modules.ai).toBe(false);
  });

  it("habilitada: aparece no contexto; RLS esconde a configuração de quem não administra e de outra equipe", async () => {
    expect((await call(P.gabriela!, "PUT", "/v1/admin/ai", { body: { enabled: true } })).status).toBe(200);
    expect((await call(P.ana!, "GET", "/v1/context")).data.tenant.modules.ai).toBe(true);
    const asAna = await withContext(app, { userId: FX.users.ana, tenantId: FX.tenantA }, async (tx) => ({
      table: await tx`select * from app.tenant_ai_settings`,
      cfg: await tx`select model from app.ai_config()`,
      usage: await tx`select * from app.ai_usage`,
    }));
    expect(asAna.table).toHaveLength(0);
    expect(asAna.cfg).toHaveLength(1);
    expect(asAna.usage).toHaveLength(0);
    const asEduardo = await withContext(app, { userId: FX.users.eduardo, tenantId: FX.tenantA }, (tx) => tx`select model from app.ai_config()`);
    expect(asEduardo).toHaveLength(0);
    expect((await call(P.eduardo!, "GET", "/v1/context", { tenant: FX.tenantB })).data.tenant.modules.ai).toBe(false);
  });

  it("teste de conexão: roteia só para provedor sem retenção e registra consumo sem conteúdo", async () => {
    const r = await call(P.gabriela!, "POST", "/v1/admin/ai/test");
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ ok: true, reply: "OK", costUsd: 0.000016, credit: { limitRemaining: 9.5 } });
    const req = seen.findLast((s) => s.path === "/api/v1/chat/completions")!;
    expect(req.auth).toBe(`Bearer ${VALID}`);
    expect(req.body).toMatchObject({ model: "acme/texto-1", provider: { zdr: true, data_collection: "deny" } });
    const [u] = await owner`select feature, model, input_tokens, output_tokens, cost_usd::float8 cost, ok from app.ai_usage`;
    expect(u).toMatchObject({ feature: "admin.test", model: "acme/texto-1", input_tokens: 12, output_tokens: 1, cost: 0.000016, ok: true });
    const g = await call(P.gabriela!, "GET", "/v1/admin/ai");
    expect(g.data.usageThisMonth[0]).toMatchObject({ feature: "admin.test", calls: 1, cost: 0.000016 });
  });

  it("sem restrição de retenção o pedido não leva o filtro zdr", async () => {
    await call(P.gabriela!, "PUT", "/v1/admin/ai", { body: { zeroRetention: false } });
    await call(P.gabriela!, "POST", "/v1/admin/ai/test");
    expect(seen.findLast((s) => s.path === "/api/v1/chat/completions")!.body.provider).toBeUndefined();
  });

  it("remover a chave desabilita a IA da equipe", async () => {
    expect((await call(P.gabriela!, "PUT", "/v1/admin/ai", { body: { apiKey: null } })).status).toBe(200);
    const g = await call(P.gabriela!, "GET", "/v1/admin/ai");
    expect(g.data).toMatchObject({ enabled: false, hasKey: false, keyHint: null });
    expect((await call(P.ana!, "GET", "/v1/context")).data.tenant.modules.ai).toBe(false);
    const [a] = await owner`select 1 from app.audit_events where action = 'admin.ai.disable' limit 1`;
    expect(a).toBeDefined();
  });

  it("cifra: mesmo texto gera cifras diferentes e adulteração é detectada", () => {
    const a = sealSecret("segredo", FX.tenantA);
    expect(a).not.toBe(sealSecret("segredo", FX.tenantA));
    const parts = a.split(".");
    parts[3] = Buffer.from("x").toString("base64url");
    expect(() => openSecret(parts.join("."), FX.tenantA)).toThrow();
  });
});
