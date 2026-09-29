import { env, openSecret } from "@evolu/config";
import type { Tx } from "@evolu/database";
import { tenantTx, type Ctx } from "../context";
import { ApiError, forbidden } from "../http";
import { AiError, chat, type ChatMessage, type ChatResult } from "./openrouter";

export { AiError } from "./openrouter";

/**
 * Ponto único para os recursos de IA da equipe. Regras:
 * - IA só propõe: quem chama devolve o texto como sugestão para o médico revisar e confirmar;
 *   nada aqui grava em nota, tarefa ou passagem.
 * - A chamada externa acontece fora de transação (não prende conexão do banco por até 60 s).
 * - O consumo é registrado sem conteúdo (recurso, modelo, tokens, custo).
 */
export function aiPlatformEnabled(): boolean {
  return env().AI_PROVIDER === "openrouter";
}

export interface AiConfig {
  model: string;
  transcriptionModel: string | null;
  zeroRetention: boolean;
  apiKey: string;
}

export async function loadAiConfig(ctx: Ctx): Promise<AiConfig> {
  if (!aiPlatformEnabled()) throw forbidden("ai_disabled", "A IA não está disponível nesta instalação.");
  const [row] = await tenantTx(ctx, (tx) =>
    tx<{ model: string; transcription_model: string | null; zero_retention: boolean; api_key_enc: string }[]>`select * from app.ai_config()`,
  );
  if (!row) throw forbidden("ai_disabled", "A IA não está habilitada nesta equipe (Administração → Inteligência artificial).");
  return {
    model: row.model,
    transcriptionModel: row.transcription_model,
    zeroRetention: row.zero_retention,
    apiKey: openSecret(row.api_key_enc, ctx.tenantId!),
  };
}

export async function recordUsage(tx: Tx, ctx: Ctx, feature: string, model: string, r: Partial<ChatResult> | null) {
  await tx`insert into app.ai_usage (tenant_id, user_id, feature, model, input_tokens, output_tokens, cost_usd, ok)
           values (${ctx.tenantId}, ${ctx.session.userId}, ${feature}, ${model}, ${r?.inputTokens ?? null}, ${r?.outputTokens ?? null},
                   ${r?.costUsd ?? null}, ${r !== null})`;
}

/** Erro do provedor vira resposta da API sem detalhes do conteúdo. */
export function aiApiError(e: unknown): ApiError {
  if (e instanceof AiError) return new ApiError(e.code === "invalid_key" || e.code === "no_credit" ? 422 : 502, `ai_${e.code}`, e.message);
  return new ApiError(502, "ai_provider_error", "Falha ao usar a IA.");
}

/** Executa um pedido de chat da equipe e registra o consumo. */
export async function runChat(
  ctx: Ctx,
  feature: string,
  messages: ChatMessage[],
  opts: { maxTokens?: number; json?: boolean; config?: AiConfig } = {},
): Promise<ChatResult> {
  const cfg = opts.config ?? (await loadAiConfig(ctx));
  try {
    const r = await chat({ key: cfg.apiKey, model: cfg.model, messages, zeroRetention: cfg.zeroRetention, maxTokens: opts.maxTokens, json: opts.json });
    await tenantTx(ctx, (tx) => recordUsage(tx, ctx, feature, cfg.model, r));
    return r;
  } catch (e) {
    if (e instanceof AiError) await tenantTx(ctx, (tx) => recordUsage(tx, ctx, feature, cfg.model, null));
    throw aiApiError(e);
  }
}
