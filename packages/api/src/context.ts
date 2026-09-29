import { randomUUID } from "node:crypto";
import { env } from "@evolu/config";
import type { Capability } from "@evolu/authorization";
import { createSql, isUuid, withContext, type Sql, type Tx } from "@evolu/database";
import { forbidden, notFound } from "./http";
import type { Session } from "./session";

let pool: Sql | undefined;
/** Pool da aplicação: papel evolu_app (sem BYPASSRLS, não é dono). */
export function appSql(): Sql {
  const url = env().DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL não definido");
  pool ??= createSql(url, { appName: "evolu-web" });
  return pool;
}
export async function closeAppSql() {
  await pool?.end();
  pool = undefined;
}

export interface Ctx {
  req: Request;
  url: URL;
  params: Record<string, string>;
  sql: Sql;
  session: Session;
  requestId: string;
  tenantId: string | null;
}

export function newRequestId() {
  return randomUUID();
}

/** Transação com contexto do usuário, sem tenant (ex.: /v1/me). */
export function userTx<T>(ctx: Ctx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withContext(ctx.sql, { userId: ctx.session.userId, realUserId: ctx.session.realUserId }, fn);
}

/**
 * Transação no tenant informado pelo cliente (X-Tenant-Id), validado no servidor: o usuário
 * efetivo precisa ter vínculo ativo. Toda consulta dentro dela está sujeita à RLS.
 */
export function tenantTx<T>(ctx: Ctx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tenantId = ctx.tenantId;
  if (!tenantId) throw forbidden("tenant_required", "Selecione a instituição (tenant).");
  return withContext(ctx.sql, { userId: ctx.session.userId, realUserId: ctx.session.realUserId, tenantId }, async (tx) => {
    const [m] = await tx<{ ok: boolean }[]>`select app.is_active_member(${tenantId}) as ok`;
    if (!m?.ok) throw forbidden("tenant_forbidden", "Sem vínculo ativo com esta instituição.");
    return fn(tx);
  });
}

export async function hasCap(tx: Tx, tenantId: string, serviceId: string | null, cap: Capability): Promise<boolean> {
  const [r] = await tx<{ ok: boolean }[]>`select app.has_cap(${tenantId}, ${serviceId}, ${cap}) as ok`;
  return Boolean(r?.ok);
}

export async function capsFor(tx: Tx, tenantId: string, serviceId: string, caps: readonly Capability[]) {
  const out = {} as Record<Capability, boolean>;
  for (const c of caps) out[c] = await hasCap(tx, tenantId, serviceId, c);
  return out;
}

export async function requireCap(ctx: Ctx, tx: Tx, serviceId: string | null, cap: Capability, resource?: { type: string; id?: string }) {
  if (!(await hasCap(tx, ctx.tenantId!, serviceId, cap))) {
    throw Object.assign(forbidden("missing_capability", "Seu vínculo não permite esta ação neste serviço."), {
      auditAction: `deny:${cap}`,
      auditResource: resource,
    });
  }
}

export function uuidParam(ctx: Ctx, name = "id"): string {
  const v = ctx.params[name];
  if (!isUuid(v)) throw notFound();
  return v;
}

export function queryUuid(ctx: Ctx, name: string, required = true): string | null {
  const v = ctx.url.searchParams.get(name);
  if (v == null || v === "") {
    if (required) throw notFound();
    return null;
  }
  if (!isUuid(v)) throw notFound();
  return v;
}

/** Auditoria sem conteúdo clínico: ação, recurso, resultado, código. */
export async function audit(
  tx: Tx,
  ctx: Ctx,
  action: string,
  resourceType: string | null,
  resourceId: string | null,
  outcome: "allow" | "deny" | "error" = "allow",
  reasonCode: string | null = null,
) {
  await tx`insert into app.audit_events (tenant_id, actor_user_id, real_user_id, action, resource_type, resource_id, outcome, reason_code, request_id)
           values (${ctx.tenantId}, ${ctx.session.userId}, ${ctx.session.realUserId}, ${action}, ${resourceType}, ${resourceId},
                   ${outcome}, ${reasonCode}, ${ctx.requestId})`;
}

/** Registra negação numa transação própria (a principal foi revertida). */
export async function auditDenied(ctx: Ctx, action: string, reasonCode: string, resource?: { type: string; id?: string }) {
  try {
    await withContext(ctx.sql, { userId: ctx.session.userId, realUserId: ctx.session.realUserId, tenantId: ctx.tenantId }, async (tx) => {
      let tenant = ctx.tenantId;
      if (tenant) {
        const [m] = await tx<{ ok: boolean }[]>`select app.is_active_member(${tenant}) as ok`;
        if (!m?.ok) tenant = null;
      }
      await tx`insert into app.audit_events (tenant_id, actor_user_id, real_user_id, action, resource_type, resource_id, outcome, reason_code, request_id)
               values (${tenant}, ${ctx.session.userId}, ${ctx.session.realUserId}, ${action}, ${resource?.type ?? null},
                       ${resource?.id && isUuid(resource.id) ? resource.id : null}, 'deny', ${reasonCode}, ${ctx.requestId})`;
    });
  } catch {
    // Falha de auditoria de negação não deve transformar 403 em 500; o log estruturado registra o código.
  }
}

export async function emitOutbox(
  tx: Tx,
  ctx: Ctx,
  eventType: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, string | number | null>,
) {
  await tx`insert into app.outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, actor_user_id, payload)
           values (${ctx.tenantId}, ${eventType}, ${aggregateType}, ${aggregateId}, ${ctx.session.userId}, ${tx.json(payload)})`;
}
