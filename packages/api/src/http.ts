import type { z } from "zod";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = () => new ApiError(404, "not_found", "Recurso não encontrado.");
export const forbidden = (code = "forbidden", message = "Acesso negado.") => new ApiError(403, code, message);
export const badRequest = (code: string, message: string, details?: unknown) => new ApiError(400, code, message, details);
export const conflict = (code: string, message: string, details?: unknown) => new ApiError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) => new ApiError(422, code, message, details);

const BASE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? Number(v) : v)), {
    status,
    headers: { ...BASE_HEADERS, ...headers },
  });
}

export function errorResponse(e: ApiError, requestId: string): Response {
  return json({ error: { code: e.code, message: e.message, details: e.details, requestId } }, e.status, { "x-request-id": requestId });
}

export async function readJson<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    const text = await req.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw badRequest("invalid_json", "Corpo da requisição não é JSON válido.");
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    // Só caminhos e mensagens: nunca ecoar valores recebidos (podem conter texto clínico).
    throw badRequest(
      "invalid_body",
      "Dados inválidos.",
      r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return r.data;
}

/** Lê If-Match como número de versão (aceita `3`, `"3"` ou `W/"3"`). */
export function ifMatchVersion(req: Request): number {
  const h = req.headers.get("if-match");
  if (!h) throw new ApiError(428, "if_match_required", "Envie o cabeçalho If-Match com a versão que você editou.");
  const n = Number(h.replace(/^W\//, "").replaceAll('"', "").trim());
  if (!Number.isInteger(n) || n < 1) throw badRequest("invalid_if_match", "If-Match inválido.");
  return n;
}

/** Converte erros do PostgreSQL em respostas sem expor detalhes internos. */
export function mapDbError(e: unknown): ApiError | null {
  const err = e as { code?: string; message?: string };
  switch (err?.code) {
    case "42501":
      return forbidden("forbidden", "Operação não permitida para o seu escopo.");
    case "P0001":
      return conflict("invalid_state", err.message ?? "Estado inválido para a operação.");
    case "23505":
      return conflict("duplicate", "Registro duplicado.");
    case "23503":
      return unprocessable("invalid_reference", "Referência inválida ou fora do escopo.");
    case "23514":
      return unprocessable("constraint_violation", "Dados violam uma regra de consistência.");
    case "22P02":
    case "22007":
    case "22008":
      return badRequest("invalid_value", "Valor inválido.");
    default:
      return null;
  }
}
