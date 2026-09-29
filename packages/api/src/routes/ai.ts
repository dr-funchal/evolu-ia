import { openSecret, sealSecret } from "@evolu/config";
import { UpdateAiSettings } from "@evolu/contracts";
import type { Tx } from "@evolu/database";
import { aiApiError, aiPlatformEnabled, recordUsage } from "../ai";
import { chat, checkKey, listModels, type ModelInfo } from "../ai/openrouter";
import { audit, requireCap, tenantTx, type Ctx } from "../context";
import { forbidden, json, readJson, unprocessable } from "../http";
import { route } from "../router";

/**
 * Administração → Inteligência artificial (org.manage): chave do OpenRouter, modelos e consumo.
 * A chave é validada no OpenRouter, cifrada e nunca volta ao navegador (só os 4 últimos caracteres).
 */
function adminTx<T>(ctx: Ctx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return tenantTx(ctx, async (tx) => {
    await requireCap(ctx, tx, null, "org.manage");
    return fn(tx);
  });
}

interface SettingsRow {
  enabled: boolean;
  api_key_enc: string | null;
  key_hint: string | null;
  model: string | null;
  transcription_model: string | null;
  zero_retention: boolean;
  updated_at: Date;
}

route("GET", "/v1/admin/ai", async (ctx) => {
  const data = await adminTx(ctx, async (tx) => {
    const [s] = await tx<SettingsRow[]>`select * from app.tenant_ai_settings where tenant_id = ${ctx.tenantId}`;
    const usage = await tx<{ feature: string; model: string; calls: number; failed: number; cost: string | null; input: number; output: number }[]>`
      select feature, model, count(*)::int calls, count(*) filter (where not ok)::int failed, sum(cost_usd)::text cost,
             coalesce(sum(input_tokens), 0)::int input, coalesce(sum(output_tokens), 0)::int output
      from app.ai_usage
      where tenant_id = ${ctx.tenantId} and created_at >= date_trunc('month', now())
      group by feature, model order by feature, model`;
    return { s, usage };
  });
  const s = data.s;
  return json({
    platformEnabled: aiPlatformEnabled(),
    enabled: s?.enabled ?? false,
    hasKey: Boolean(s?.api_key_enc),
    keyHint: s?.key_hint ?? null,
    model: s?.model ?? null,
    transcriptionModel: s?.transcription_model ?? null,
    zeroRetention: s?.zero_retention ?? true,
    updatedAt: s?.updated_at ?? null,
    usageThisMonth: data.usage.map((u) => ({ ...u, cost: u.cost === null ? null : Number(u.cost) })),
  });
});

route("GET", "/v1/admin/ai/models", async (ctx) => {
  await adminTx(ctx, async () => undefined);
  try {
    return json({ models: await listModels() });
  } catch (e) {
    throw aiApiError(e);
  }
});

async function catalogCheck(id: string, kind: ModelInfo["kind"]) {
  let models: ModelInfo[];
  try {
    models = await listModels();
  } catch {
    return; // catálogo fora do ar: o teste de conexão acusa modelo inexistente
  }
  if (!models.some((m) => m.id === id && m.kind === kind))
    throw unprocessable("ai_unknown_model", kind === "chat" ? "Modelo não encontrado no OpenRouter." : "Modelo de transcrição não encontrado no OpenRouter.");
}

route("PUT", "/v1/admin/ai", async (ctx) => {
  if (!aiPlatformEnabled()) throw forbidden("ai_disabled", "A IA não está disponível nesta instalação.");
  const body = await readJson(ctx.req, UpdateAiSettings);
  await adminTx(ctx, async () => undefined); // nega cedo, antes de falar com o OpenRouter
  if (body.apiKey) {
    try {
      await checkKey(body.apiKey);
    } catch (e) {
      throw aiApiError(e);
    }
  }
  if (body.model) await catalogCheck(body.model, "chat");
  if (body.transcriptionModel) await catalogCheck(body.transcriptionModel, "transcription");

  await adminTx(ctx, async (tx) => {
    const [cur] = await tx<SettingsRow[]>`select * from app.tenant_ai_settings where tenant_id = ${ctx.tenantId} for update`;
    const next = {
      enabled: body.enabled ?? cur?.enabled ?? false,
      api_key_enc: body.apiKey === undefined ? (cur?.api_key_enc ?? null) : body.apiKey === null ? null : sealSecret(body.apiKey, ctx.tenantId!),
      key_hint: body.apiKey === undefined ? (cur?.key_hint ?? null) : body.apiKey === null ? null : body.apiKey.slice(-4),
      model: body.model ?? cur?.model ?? null,
      transcription_model: body.transcriptionModel === undefined ? (cur?.transcription_model ?? null) : body.transcriptionModel,
      zero_retention: body.zeroRetention ?? cur?.zero_retention ?? true,
    };
    // Sem chave ou sem modelo não há como ficar habilitado.
    if (!next.api_key_enc || !next.model) {
      if (body.enabled) throw unprocessable("ai_incomplete", "Para habilitar, informe a chave do OpenRouter e escolha o modelo.");
      next.enabled = false;
    }
    await tx`
      insert into app.tenant_ai_settings (tenant_id, enabled, api_key_enc, key_hint, model, transcription_model, zero_retention, updated_by)
      values (${ctx.tenantId}, ${next.enabled}, ${next.api_key_enc}, ${next.key_hint}, ${next.model}, ${next.transcription_model},
              ${next.zero_retention}, ${ctx.session.realUserId})
      on conflict (tenant_id) do update set enabled = excluded.enabled, api_key_enc = excluded.api_key_enc, key_hint = excluded.key_hint,
        model = excluded.model, transcription_model = excluded.transcription_model, zero_retention = excluded.zero_retention,
        updated_by = excluded.updated_by, updated_at = now()`;
    if (body.apiKey !== undefined) await audit(tx, ctx, body.apiKey ? "admin.ai.key.set" : "admin.ai.key.remove", "tenant", ctx.tenantId);
    if (next.enabled !== (cur?.enabled ?? false)) await audit(tx, ctx, next.enabled ? "admin.ai.enable" : "admin.ai.disable", "tenant", ctx.tenantId);
    await audit(tx, ctx, "admin.ai.update", "tenant", ctx.tenantId);
  });
  return json({ ok: true });
});

/** Teste com a configuração salva: valida a chave, mostra o saldo e faz um pedido mínimo ao modelo. */
route("POST", "/v1/admin/ai/test", async (ctx) => {
  if (!aiPlatformEnabled()) throw forbidden("ai_disabled", "A IA não está disponível nesta instalação.");
  const s = await adminTx(ctx, async (tx) => {
    const [row] = await tx<SettingsRow[]>`select * from app.tenant_ai_settings where tenant_id = ${ctx.tenantId}`;
    return row;
  });
  if (!s?.api_key_enc || !s.model) throw unprocessable("ai_incomplete", "Salve a chave e o modelo antes de testar.");
  const key = openSecret(s.api_key_enc, ctx.tenantId!);
  const model = s.model;
  const started = Date.now();
  try {
    const credit = await checkKey(key);
    const r = await chat({
      key,
      model,
      zeroRetention: s.zero_retention,
      maxTokens: 20,
      messages: [{ role: "user", content: "Teste de conexão. Responda apenas: OK" }],
    });
    await tenantTx(ctx, (tx) => recordUsage(tx, ctx, "admin.test", model, r));
    return json({ ok: true, reply: r.text.trim().slice(0, 40), costUsd: r.costUsd, latencyMs: Date.now() - started, credit });
  } catch (e) {
    await tenantTx(ctx, (tx) => recordUsage(tx, ctx, "admin.test", model, null));
    throw aiApiError(e);
  }
});
