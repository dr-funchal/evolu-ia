import { env } from "@evolu/config";

/**
 * Cliente mínimo do OpenRouter (API compatível com OpenAI). Sem SDK: três chamadas bastam.
 * Nada daqui é logado: nem a chave, nem o texto enviado ou recebido.
 */

const TIMEOUT_MS = 60_000;

export class AiError extends Error {
  constructor(
    public code: "invalid_key" | "no_credit" | "model_unavailable" | "rate_limited" | "provider_error" | "timeout",
    message: string,
  ) {
    super(message);
  }
}

async function call(path: string, init: RequestInit & { key?: string; timeoutMs?: number } = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  if (init.key) headers.set("authorization", `Bearer ${init.key}`);
  headers.set("http-referer", env().APP_BASE_URL);
  headers.set("x-title", "Evolu-IA");
  if (init.body) headers.set("content-type", "application/json");
  let res: Response;
  try {
    res = await fetch(`${env().OPENROUTER_BASE_URL}${path}`, { ...init, headers, signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS) });
  } catch (e) {
    if ((e as Error).name === "TimeoutError") throw new AiError("timeout", "O OpenRouter não respondeu a tempo.");
    throw new AiError("provider_error", "Não foi possível falar com o OpenRouter.");
  }
  if (res.ok) return res.json();
  // Mensagens do provedor podem ecoar parte do pedido: não repassamos o corpo, só o status.
  if (res.status === 401) throw new AiError("invalid_key", "Chave do OpenRouter inválida ou revogada.");
  if (res.status === 402) throw new AiError("no_credit", "Sem crédito na conta do OpenRouter.");
  if (res.status === 404) throw new AiError("model_unavailable", "Modelo indisponível (ou sem provedor que atenda às restrições escolhidas).");
  if (res.status === 429) throw new AiError("rate_limited", "Limite de uso do OpenRouter atingido; tente em instantes.");
  throw new AiError("provider_error", `O OpenRouter respondeu com erro (${res.status}).`);
}

// --- Catálogo de modelos -----------------------------------------------------------------------

export interface ModelInfo {
  id: string;
  name: string;
  kind: "chat" | "transcription";
  contextLength: number | null;
  input: string[];
  /**
   * US$ por 1 milhão de tokens; null = variável. Transcrição tipo Whisper é cobrada por segundo de
   * áudio: aí vem em perMinute (US$/min) e input/output ficam null.
   */
  price: { input: number | null; output: number | null; audio: number | null; image: number | null; perMinute: number | null };
  free: boolean;
  created: number;
}

interface RawModel {
  id: string;
  name: string;
  created?: number;
  context_length?: number | null;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  pricing?: Record<string, unknown>;
}

const perMillion = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 10_000) / 10_000 : null;
};

function toModel(m: RawModel, kind: ModelInfo["kind"]): ModelInfo {
  const p = m.pricing ?? {};
  const byDuration = kind === "transcription" && Number(p.completion) === 0;
  const price = byDuration
    ? { input: null, output: null, audio: null, image: null, perMinute: Math.round(Number(p.prompt) * 60 * 10_000) / 10_000 }
    : { input: perMillion(p.prompt), output: perMillion(p.completion), audio: perMillion(p.audio), image: perMillion(p.image), perMinute: null };
  return {
    id: m.id,
    name: m.name,
    kind,
    contextLength: m.context_length ?? null,
    input: m.architecture?.input_modalities ?? ["text"],
    price,
    free: m.id.endsWith(":free") || (price.input === 0 && price.output === 0) || price.perMinute === 0,
    created: m.created ?? 0,
  };
}

let cache: { at: number; models: ModelInfo[] } | undefined;
const CACHE_MS = 60 * 60 * 1000;

/** Catálogo público (sem chave), em cache por 1 h. Modelos em lote (":batch") exigem outra API e ficam fora. */
export async function listModels(): Promise<ModelInfo[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.models;
  const [chat, stt] = (await Promise.all([call("/models"), call("/models?output_modalities=transcription")])) as { data: RawModel[] }[];
  const models = [
    ...chat!.data
      .filter((m) => !m.id.endsWith(":batch") && (m.architecture?.output_modalities ?? ["text"]).includes("text"))
      .map((m) => toModel(m, "chat")),
    ...stt!.data.map((m) => toModel(m, "transcription")),
  ];
  cache = { at: Date.now(), models };
  return models;
}

export function clearModelCache() {
  cache = undefined;
}

// --- Chave ---------------------------------------------------------------------------------------

export interface KeyInfo {
  limit: number | null;
  limitRemaining: number | null;
  usage: number | null;
  isFreeTier: boolean;
}

/** Valida a chave sem gastar crédito (GET /key). */
export async function checkKey(key: string): Promise<KeyInfo> {
  const r = (await call("/key", { key })) as { data?: Record<string, unknown> };
  const d = r.data ?? {};
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  return { limit: num(d.limit), limitRemaining: num(d.limit_remaining), usage: num(d.usage), isFreeTier: d.is_free_tier === true };
}

// --- Chat ----------------------------------------------------------------------------------------

export type ChatPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } }
  | { type: "file"; file: { filename: string; file_data: string } };
export type ChatContent = string | ChatPart[];
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: ChatContent;
}
export interface ChatResult {
  text: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export async function chat(opts: {
  key: string;
  model: string;
  messages: ChatMessage[];
  zeroRetention: boolean;
  maxTokens?: number;
  json?: boolean;
  timeoutMs?: number;
}): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    max_tokens: opts.maxTokens ?? 1500,
    usage: { include: true },
  };
  if (opts.zeroRetention) body.provider = { zdr: true, data_collection: "deny" };
  if (opts.json) body.response_format = { type: "json_object" };
  const r = (await call("/chat/completions", { method: "POST", key: opts.key, body: JSON.stringify(body), timeoutMs: opts.timeoutMs })) as {
    model?: string;
    choices?: { message?: { content?: string | null } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  };
  const text = r.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new AiError("provider_error", "O modelo não devolveu texto.");
  return {
    text,
    model: r.model ?? opts.model,
    inputTokens: r.usage?.prompt_tokens ?? null,
    outputTokens: r.usage?.completion_tokens ?? null,
    costUsd: r.usage?.cost ?? null,
  };
}

// --- Transcrição ---------------------------------------------------------------------------------

export interface TranscriptionResult {
  text: string;
  seconds: number | null;
  costUsd: number | null;
}

/**
 * POST /audio/transcriptions com o áudio em base64. O áudio não é guardado em lugar nenhum: sai da
 * memória para o provedor e é descartado. Esse endpoint ainda não aceita o filtro de retenção zero.
 */
export async function transcribe(opts: { key: string; model: string; audio: Uint8Array; format: string }): Promise<TranscriptionResult> {
  const r = (await call("/audio/transcriptions", {
    method: "POST",
    key: opts.key,
    timeoutMs: 90_000,
    body: JSON.stringify({
      model: opts.model,
      input_audio: { data: Buffer.from(opts.audio).toString("base64"), format: opts.format },
      language: "pt",
      temperature: 0,
    }),
  })) as { text?: string; usage?: { seconds?: number; cost?: number } };
  if (typeof r.text !== "string") throw new AiError("provider_error", "A transcrição não devolveu texto.");
  return { text: r.text, seconds: r.usage?.seconds ?? null, costUsd: r.usage?.cost ?? null };
}
