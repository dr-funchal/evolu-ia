import postgres from "postgres";

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

/**
 * Cria um pool. Para caminhos de usuário use sempre DATABASE_URL (evolu_app) ou
 * WORKER_DATABASE_URL (evolu_worker): papéis sem BYPASSRLS e que não são donos de tabelas.
 */
export function createSql(url: string, opts: { max?: number; appName?: string } = {}): Sql {
  return postgres(url, {
    max: opts.max ?? 10,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: true,
    onnotice: () => undefined,
    connection: { application_name: opts.appName ?? "evolu" },
    types: { bigint: postgres.BigInt },
  });
}
