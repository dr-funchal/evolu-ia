import type { Sql, Tx } from "./client";

export interface DbContext {
  /** Usuário efetivo (persona em demo, ou o próprio usuário). */
  userId: string;
  /** Usuário autenticado real, quando diferente (operador de demonstração). */
  realUserId?: string | null;
  /** Tenant resolvido e validado pelo servidor para esta requisição. */
  tenantId?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Executa `fn` numa transação com o contexto de autorização definido por set_config(..., true):
 * o escopo é a transação, então nada vaza para a próxima requisição que reutilizar a conexão (SEC-05).
 */
export async function withContext<T>(sql: Sql, ctx: DbContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (const v of [ctx.userId, ctx.realUserId, ctx.tenantId]) {
    if (v != null && !UUID.test(v)) throw new Error("identificador de contexto inválido");
  }
  return (await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${ctx.userId}, true),
                    set_config('app.real_user_id', ${ctx.realUserId ?? ctx.userId}, true),
                    set_config('app.tenant_id', ${ctx.tenantId ?? ""}, true)`;
    return fn(tx);
  })) as T;
}

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}
