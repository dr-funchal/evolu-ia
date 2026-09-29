import { createServer, type Server } from "node:http";

/**
 * OpenRouter falso em 127.0.0.1:18765 (vitest.config.ts aponta OPENROUTER_BASE_URL para cá).
 * `reply` decide o texto do chat a partir do corpo do pedido; tudo o que chega fica em `seen`.
 */
export const VALID_KEY = "sk-or-v1-chave-de-teste-valida-0000000abcd";

export interface FakeOpenRouter {
  seen: { path: string; auth: string | null; body: any }[];
  reply: (body: any) => string;
  transcript: string;
  close: () => Promise<void>;
}

export async function startFakeOpenRouter(): Promise<FakeOpenRouter> {
  const models = {
    data: [
      { id: "acme/texto-1", name: "Acme Texto 1", created: 2, context_length: 128000, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, pricing: { prompt: "0.000001", completion: "0.000004" } },
      { id: "acme/cego", name: "Acme Só Texto", created: 1, architecture: { input_modalities: ["text"], output_modalities: ["text"] }, pricing: { prompt: "0.000001", completion: "0.000001" } },
    ],
  };
  const stt = { data: [{ id: "acme/whisper", name: "Acme Whisper", architecture: { input_modalities: ["audio"], output_modalities: ["transcription"] }, pricing: { prompt: "0.0001", completion: "0" } }] };
  const fake: FakeOpenRouter = { seen: [], reply: () => "{}", transcript: "", close: async () => {} };
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = req.url ?? "";
      const body = raw ? JSON.parse(raw) : null;
      fake.seen.push({ path: url, auth: req.headers.authorization ?? null, body });
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      const authed = req.headers.authorization === `Bearer ${VALID_KEY}`;
      if (url === "/api/v1/models") return send(200, models);
      if (url === "/api/v1/models?output_modalities=transcription") return send(200, stt);
      if (url === "/api/v1/key") return authed ? send(200, { data: { limit: 10, limit_remaining: 9.5, usage: 0.5, is_free_tier: false } }) : send(401, {});
      if (!authed) return send(401, {});
      if (url === "/api/v1/chat/completions")
        return send(200, { model: body.model, choices: [{ message: { content: fake.reply(body) } }], usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.0003 } });
      if (url === "/api/v1/audio/transcriptions") return send(200, { text: fake.transcript, usage: { seconds: 12, cost: 0.0012 } });
      send(404, {});
    });
  });
  await new Promise<void>((ok) => server.listen(18765, "127.0.0.1", () => ok()));
  fake.close = () =>
    new Promise<void>((ok) => {
      server.closeAllConnections();
      server.close(() => ok());
    });
  return fake;
}
