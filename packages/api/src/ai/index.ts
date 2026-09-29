import { env, openSecret } from "@evolu/config";
import type { Tx } from "@evolu/database";
import type { z } from "zod";
import { tenantTx, type Ctx } from "../context";
import { ApiError, forbidden, unprocessable } from "../http";
import { AiError, chat, listModels, transcribe, type ChatMessage, type ChatResult } from "./openrouter";

export { AiError } from "./openrouter";

/**
 * Ponto único para os recursos de IA da equipe. Regras:
 * - IA só propõe: quem chama devolve o texto como sugestão para o médico revisar e confirmar;
 *   nada aqui grava em nota, tarefa ou passagem.
 * - A chamada externa acontece fora de transação (não prende conexão do banco enquanto espera).
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
  if (e instanceof ApiError) return e;
  if (e instanceof AiError) return new ApiError(e.code === "invalid_key" || e.code === "no_credit" ? 422 : 502, `ai_${e.code}`, e.message);
  return new ApiError(502, "ai_provider_error", "Falha ao usar a IA.");
}

/** Executa um pedido de chat da equipe e registra o consumo. */
export async function runChat(
  ctx: Ctx,
  feature: string,
  messages: ChatMessage[],
  opts: { maxTokens?: number; json?: boolean; config?: AiConfig; timeoutMs?: number } = {},
): Promise<ChatResult> {
  const cfg = opts.config ?? (await loadAiConfig(ctx));
  try {
    const r = await chat({
      key: cfg.apiKey,
      model: cfg.model,
      messages,
      zeroRetention: cfg.zeroRetention,
      maxTokens: opts.maxTokens,
      json: opts.json,
      timeoutMs: opts.timeoutMs,
    });
    await tenantTx(ctx, (tx) => recordUsage(tx, ctx, feature, cfg.model, r));
    return r;
  } catch (e) {
    if (e instanceof AiError) await tenantTx(ctx, (tx) => recordUsage(tx, ctx, feature, cfg.model, null));
    throw aiApiError(e);
  }
}

/** Pede JSON ao modelo e valida a forma; resposta fora do formato vira 502 sem ecoar o conteúdo. */
export async function runJson<S extends z.ZodType>(
  ctx: Ctx,
  feature: string,
  messages: ChatMessage[],
  schema: S,
  opts: { maxTokens?: number; config?: AiConfig; timeoutMs?: number } = {},
): Promise<{ data: z.infer<S>; result: ChatResult }> {
  const result = await runChat(ctx, feature, messages, { ...opts, json: true });
  return { data: parseAiJson(result.text, schema), result };
}

export function parseAiJson<S extends z.ZodType>(text: string, schema: S): z.infer<S> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    raw = undefined;
  }
  const r = schema.safeParse(raw);
  if (start < 0 || !r.success) throw new ApiError(502, "ai_bad_output", "A IA devolveu uma resposta fora do formato esperado. Tente de novo.");
  return r.data;
}

/** Formatos aceitos, reconhecidos pela assinatura do arquivo (nunca pelo tipo declarado). */
export function sniffAudio(b: Uint8Array): "webm" | "ogg" | "m4a" | "wav" | "mp3" | null {
  const at = (i: number, ...v: number[]) => v.every((x, j) => b[i + j] === x);
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return "webm";
  if (at(0, 0x4f, 0x67, 0x67, 0x53)) return "ogg";
  if (at(4, 0x66, 0x74, 0x79, 0x70)) return "m4a";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x41, 0x56, 0x45)) return "wav";
  if (at(0, 0x49, 0x44, 0x33) || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0)) return "mp3";
  return null;
}

/**
 * Transcreve com o modelo de transcrição da equipe; sem ele, usa o modelo principal se ele ouvir
 * áudio. O áudio fica só em memória durante a chamada.
 */
export async function runTranscription(ctx: Ctx, feature: string, cfg: AiConfig, audio: Uint8Array, format: string): Promise<string> {
  if (cfg.transcriptionModel) {
    const model = cfg.transcriptionModel;
    try {
      const r = await transcribe({ key: cfg.apiKey, model, audio, format });
      await tenantTx(ctx, (tx) => recordUsage(tx, ctx, feature, model, { costUsd: r.costUsd }));
      return r.text;
    } catch (e) {
      if (e instanceof AiError) await tenantTx(ctx, (tx) => recordUsage(tx, ctx, feature, model, null));
      throw aiApiError(e);
    }
  }
  const hears = await listModels()
    .then((ms) => ms.some((m) => m.id === cfg.model && m.input.includes("audio")))
    .catch(() => false);
  if (!hears) {
    throw unprocessable("ai_no_transcription", "Escolha um modelo de transcrição (ou um modelo principal que ouça áudio) em Administração → Inteligência artificial.");
  }
  const r = await runChat(
    ctx,
    feature,
    [
      { role: "system", content: "Transcreva literalmente o áudio, em português do Brasil. Devolva só a transcrição, sem comentários." },
      { role: "user", content: [{ type: "input_audio", input_audio: { data: Buffer.from(audio).toString("base64"), format } }] },
    ],
    { config: cfg, maxTokens: 8000, timeoutMs: 150_000 },
  );
  return r.text;
}
