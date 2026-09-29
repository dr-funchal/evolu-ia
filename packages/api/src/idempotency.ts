import { createHash } from "node:crypto";
import type { Tx } from "@evolu/database";
import type { Ctx } from "./context";
import { badRequest, conflict, json } from "./http";

/**
 * Idempotency-Key com escopo tenant + usuário + operação. Guarda hash da requisição para impedir
 * reutilização da chave com conteúdo diferente e devolve a resposta original em repetições.
 * Deve ser chamada dentro da mesma transação do comando.
 */
export async function idempotent(
  tx: Tx,
  ctx: Ctx,
  operation: string,
  requestFingerprint: unknown,
  run: () => Promise<{ status: number; body: unknown }>,
  opts: { required?: boolean } = {},
): Promise<Response> {
  const key = ctx.req.headers.get("idempotency-key");
  if (!key) {
    if (opts.required) throw badRequest("idempotency_key_required", "Envie o cabeçalho Idempotency-Key.");
    const r = await run();
    return json(r.body, r.status);
  }
  if (key.length < 8 || key.length > 200) throw badRequest("invalid_idempotency_key", "Idempotency-Key inválida.");
  const hash = createHash("sha256").update(JSON.stringify(requestFingerprint)).digest("hex");
  // Serializa requisições concorrentes com a mesma chave.
  await tx`select pg_advisory_xact_lock(hashtextextended(${`${ctx.tenantId}:${ctx.session.userId}:${operation}:${key}`}, 0))`;
  const [prev] = await tx<{ request_hash: string; response_status: number | null; response_body: unknown }[]>`
    select request_hash, response_status, response_body from app.idempotency_keys
    where tenant_id = ${ctx.tenantId} and user_id = ${ctx.session.userId} and operation = ${operation} and key = ${key}`;
  if (prev) {
    if (prev.request_hash !== hash) throw conflict("idempotency_key_reused", "Idempotency-Key já usada com outro conteúdo.");
    if (prev.response_status != null) return json(prev.response_body, prev.response_status, { "idempotent-replay": "true" });
  }
  const r = await run();
  await tx`insert into app.idempotency_keys (tenant_id, user_id, operation, key, request_hash, response_status, response_body)
           values (${ctx.tenantId}, ${ctx.session.userId}, ${operation}, ${key}, ${hash}, ${r.status}, ${tx.json(r.body as never)})
           on conflict (tenant_id, user_id, operation, key) do update
             set response_status = excluded.response_status, response_body = excluded.response_body`;
  return json(r.body, r.status);
}
