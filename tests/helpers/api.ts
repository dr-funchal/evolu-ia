import { randomUUID } from "node:crypto";
import { closeAppSql, handleApi, handleAuth } from "@evolu/api";
import { createSql, FX, type Sql } from "@evolu/database";

export { FX };
export const BASE = "http://localhost:3000";

export type Persona = keyof typeof FX.users;

/** Sessão real criada pelo fluxo de login (provedor mock, só em test/development). */
export async function login(as: Persona, opts: { mfa?: boolean } = {}): Promise<string> {
  const res = await handleAuth(new Request(`${BASE}/auth/login?as=${as}${opts.mfa === false ? "&mfa=0" : ""}`));
  if (res.status !== 303) throw new Error(`login falhou: ${res.status}`);
  const cookie = res.headers.get("set-cookie")!;
  return cookie.split(";")[0]!;
}

export interface CallOpts {
  tenant?: string | null;
  body?: unknown;
  ifMatch?: number;
  idem?: string;
  origin?: string | null;
  headers?: Record<string, string>;
  rawBody?: BodyInit;
}

export async function call(cookie: string | null, method: string, path: string, opts: CallOpts = {}) {
  const headers = new Headers(opts.headers);
  if (cookie) headers.set("cookie", cookie);
  if (opts.tenant !== null) headers.set("x-tenant-id", opts.tenant ?? FX.tenantA);
  if (method !== "GET" && opts.origin !== null) headers.set("origin", opts.origin ?? BASE);
  if (opts.ifMatch !== undefined) headers.set("if-match", String(opts.ifMatch));
  if (opts.idem) headers.set("idempotency-key", opts.idem);
  let body: BodyInit | undefined = opts.rawBody;
  if (opts.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(opts.body);
  }
  const res = await handleApi(new Request(`${BASE}/api${path}`, { method, headers, body }));
  const type = res.headers.get("content-type") ?? "";
  const data = type.includes("json") ? await res.json() : await res.text();
  return { status: res.status, data: data as any, headers: res.headers };
}

export const idem = () => `k-${randomUUID()}`;

/** Conexões diretas com os papéis reais (para provar a RLS em SQL, sem passar pela API). */
export function appDb(): Sql {
  return createSql(process.env.DATABASE_URL!, { max: 2, appName: "evolu-test-sql" });
}
export function workerDb(): Sql {
  return createSql(process.env.WORKER_DATABASE_URL!, { max: 2, appName: "evolu-test-worker" });
}
export function ownerDb(): Sql {
  return createSql(process.env.MIGRATION_DATABASE_URL!, { max: 1, appName: "evolu-test-owner" });
}

export async function teardown() {
  await closeAppSql();
}

/** Conteúdo mínimo válido de evolução com exame informado. */
export function sampleContent(problemIds: string[], opts: { exam?: boolean } = {}) {
  const f = (text?: string) => (text ? { state: "informado", text } : { state: "nao_informado" });
  return {
    schema: 1,
    sections: {
      contexto: f("Contexto sintético de teste."),
      antecedentes: f(),
      estado_basal: f(),
      intercorrencias: f(),
      subjetivo: f("Refere melhora (sintético)."),
      exame: opts.exam === false ? { state: "nao_avaliado" } : f("Exame sintético do dia."),
      resultados_revistos: f(),
      comunicacao: f(),
      pendencias: f(),
      destino: f(),
    },
    problems: problemIds.map((problemId) => ({ problemId, avaliacao: f("Avaliação sintética."), plano: f("Plano sintético.") })),
  };
}
