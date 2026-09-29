import { env, logger } from "@evolu/config";
import { isUuid } from "@evolu/database";
import { appSql, auditDenied, newRequestId, type Ctx } from "./context";
import { ApiError, errorResponse, forbidden, json, mapDbError } from "./http";
import { requireMfa, resolveSession } from "./session";

export type Handler = (ctx: Ctx) => Promise<Response>;
interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  /** Exige X-Tenant-Id (quase todas as rotas de negócio). */
  tenant: boolean;
  action: string;
}

const routes: Route[] = [];

export function route(method: string, path: string, handler: Handler, opts: { tenant?: boolean; action?: string } = {}) {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" + path.replace(/:([a-zA-Z]+)/g, (_m, k: string) => (keys.push(k), "([^/]+)")) + "/?$",
  );
  routes.push({ method, pattern, keys, handler, tenant: opts.tenant ?? true, action: opts.action ?? `${method} ${path}` });
}

// Limite simples por sessão (processo único). Protege contra abuso acidental; não substitui WAF.
const buckets = new Map<string, { n: number; reset: number }>();
function rateLimited(key: string, limit = 600, windowMs = 60_000): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) {
    buckets.set(key, { n: 1, reset: now + windowMs });
    if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
    return false;
  }
  b.n += 1;
  return b.n > limit;
}

function sameOrigin(req: Request): boolean {
  const expected = new URL(env().APP_BASE_URL).origin;
  const origin = req.headers.get("origin");
  if (origin) return origin === expected;
  return req.headers.get("sec-fetch-site") === "same-origin";
}

/**
 * Ponto de entrada da API (independente de framework). O Next.js apenas delega para cá, e os
 * testes chamam esta função diretamente com cookies de sessão reais.
 */
export async function handleApi(req: Request): Promise<Response> {
  const requestId = newRequestId();
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api(?=\/v1\/)/, "");
  const method = req.method.toUpperCase();

  let matched: { r: Route; params: Record<string, string> } | undefined;
  let methodMismatch = false;
  for (const r of routes) {
    const m = r.pattern.exec(path);
    if (!m) continue;
    if (r.method !== method) {
      methodMismatch = true;
      continue;
    }
    matched = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)])) };
    break;
  }
  if (!matched) {
    return errorResponse(
      methodMismatch ? new ApiError(405, "method_not_allowed", "Método não permitido.") : new ApiError(404, "not_found", "Rota inexistente."),
      requestId,
    );
  }

  if (method !== "GET" && method !== "HEAD" && !sameOrigin(req)) {
    return errorResponse(forbidden("csrf", "Origem da requisição não permitida."), requestId);
  }

  const sql = appSql();
  let ctx: Ctx | undefined;
  const started = Date.now();
  try {
    const session = await resolveSession(sql, req);
    if (!session) throw new ApiError(401, "unauthenticated", "Sessão ausente ou expirada.");
    requireMfa(session);
    if (rateLimited(session.sessionId)) throw new ApiError(429, "rate_limited", "Muitas requisições. Aguarde um instante.");
    const tenantHeader = req.headers.get("x-tenant-id");
    if (matched.r.tenant && !isUuid(tenantHeader)) throw forbidden("tenant_required", "Selecione a instituição (tenant).");
    ctx = { req, url, params: matched.params, sql, session, requestId, tenantId: matched.r.tenant ? tenantHeader : null };
    const res = await matched.r.handler(ctx);
    res.headers.set("x-request-id", requestId);
    logger.info({ requestId, route: matched.r.action, status: res.status, ms: Date.now() - started }, "api");
    return res;
  } catch (e) {
    const apiErr = e instanceof ApiError ? e : mapDbError(e);
    if (apiErr) {
      if (ctx && (apiErr.status === 403 || apiErr.status === 404)) {
        const res = (e as { auditResource?: { type: string; id?: string } }).auditResource;
        await auditDenied(ctx, matched.r.action, apiErr.code, res ?? (ctx.params.id ? { type: "route", id: ctx.params.id } : undefined));
      }
      logger.info({ requestId, route: matched.r.action, status: apiErr.status, code: apiErr.code }, "api");
      return errorResponse(apiErr, requestId);
    }
    // Erro inesperado: registrar só tipo/código, nunca a mensagem completa (pode conter dados).
    const err = e as { code?: string; name?: string };
    logger.error({ requestId, route: matched.r.action, errName: err?.name, errCode: err?.code }, "api_error");
    return errorResponse(new ApiError(500, "internal_error", "Erro interno. Informe o código da requisição ao suporte."), requestId);
  }
}

export { json };
