import { env, demoFeaturesEnabled } from "@evolu/config";
import { ROLE_LABELS, isRole } from "@evolu/authorization";
import { SetPersona } from "@evolu/contracts";
import { aiPlatformEnabled } from "../ai";
import { audit, tenantTx, userTx } from "../context";
import { forbidden, json, readJson } from "../http";
import { route } from "../router";

route(
  "GET",
  "/v1/me",
  async (ctx) => {
    const [scopes, isPlatformAdmin] = await userTx(ctx, async (tx) => {
      const rows = await tx<{
        tenant_id: string;
        tenant_name: string;
        tenant_timezone: string;
        is_synthetic: boolean;
        role: string;
        hospital_name: string | null;
        service_id: string | null;
        service_name: string | null;
      }[]>`select * from app.my_scopes()`;
      const [p] = await tx<{ ok: boolean }[]>`select app.is_platform_admin() as ok`;
      return [rows, Boolean(p?.ok)] as const;
    });
    const tenants = new Map<string, { id: string; name: string; timezone: string; isSynthetic: boolean; grants: unknown[] }>();
    for (const s of scopes) {
      const t =
        tenants.get(s.tenant_id) ??
        { id: s.tenant_id, name: s.tenant_name, timezone: s.tenant_timezone, isSynthetic: s.is_synthetic, grants: [] };
      t.grants.push({
        role: s.role,
        roleLabel: isRole(s.role) ? ROLE_LABELS[s.role] : s.role,
        hospitalName: s.hospital_name,
        serviceId: s.service_id,
        serviceName: s.service_name,
      });
      tenants.set(s.tenant_id, t);
    }
    const e = env();
    return json({
      user: { id: ctx.session.userId, displayName: ctx.session.displayName },
      realUser: ctx.session.personaActive ? { id: ctx.session.realUserId, displayName: ctx.session.realDisplayName } : null,
      isDemoOperator: ctx.session.isDemoOperator && demoFeaturesEnabled(),
      isPlatformAdmin,
      appMode: e.APP_MODE,
      demo: e.APP_MODE === "demo" || e.APP_MODE === "development",
      aiProvider: e.AI_PROVIDER,
      tenants: [...tenants.values()],
    });
  },
  { tenant: false },
);

route("GET", "/v1/context", async (ctx) => {
  const data = await tenantTx(ctx, async (tx) => {
    const [tenant] = await tx<{ id: string; name: string; timezone: string; is_synthetic: boolean; handoffs_enabled: boolean }[]>`
      select id, name, timezone, is_synthetic, handoffs_enabled from app.tenants where id = ${ctx.tenantId}`;
    const services = await tx<{
      service_id: string;
      hospital_id: string;
      service_name: string;
      hospital_name: string;
      hospital_timezone: string;
      capabilities: string[];
    }[]>`select * from app.my_service_capabilities()`;
    const tenantCaps: string[] = [];
    for (const c of ["org.manage", "audit.read", "finance.read"]) {
      const [r] = await tx<{ ok: boolean }[]>`select app.has_cap_any(${ctx.tenantId}, ${c}) as ok`;
      if (r?.ok) tenantCaps.push(c);
    }
    const [n] = await tx<{ n: number }[]>`select count(*)::int n from app.notification_deliveries where read_at is null`;
    const [ai] = await tx<{ model: string }[]>`select model from app.ai_config()`;
    return { tenant, services, tenantCaps, unreadNotifications: n?.n ?? 0, ai: Boolean(ai) && aiPlatformEnabled() };
  });
  return json({
    tenant: data.tenant && {
      id: data.tenant.id,
      name: data.tenant.name,
      timezone: data.tenant.timezone,
      isSynthetic: data.tenant.is_synthetic,
      modules: { handoffs: data.tenant.handoffs_enabled, ai: data.ai },
    },
    services: data.services.map((s) => ({
      id: s.service_id,
      name: s.service_name,
      hospitalId: s.hospital_id,
      hospitalName: s.hospital_name,
      timezone: s.hospital_timezone,
      capabilities: s.capabilities,
    })),
    tenantCapabilities: data.tenantCaps,
    unreadNotifications: data.unreadNotifications,
  });
});

// ---------------------------------------------------------------------------------------------
// Demonstração: troca de persona sintética (bloqueada em production no servidor e no banco).
// ---------------------------------------------------------------------------------------------
function assertDemo(ctx: { session: { isDemoOperator: boolean } }) {
  if (!demoFeaturesEnabled() || !ctx.session.isDemoOperator) {
    throw forbidden("demo_disabled", "Troca de persona indisponível.");
  }
}

route(
  "GET",
  "/v1/demo/personas",
  async (ctx) => {
    assertDemo(ctx);
    const rows = await userTx(ctx, (tx) =>
      tx<{ user_id: string; display_name: string; tenant_name: string; role: string; scope: string }[]>`select * from app.demo_personas()`,
    );
    const map = new Map<string, { userId: string; displayName: string; grants: string[] }>();
    for (const r of rows) {
      const p = map.get(r.user_id) ?? { userId: r.user_id, displayName: r.display_name, grants: [] };
      p.grants.push(`${isRole(r.role) ? ROLE_LABELS[r.role] : r.role} · ${r.scope} · ${r.tenant_name}`);
      map.set(r.user_id, p);
    }
    return json({ personas: [...map.values()], active: ctx.session.personaActive ? ctx.session.userId : null });
  },
  { tenant: false },
);

route(
  "POST",
  "/v1/demo/persona",
  async (ctx) => {
    assertDemo(ctx);
    const body = await readJson(ctx.req, SetPersona);
    await userTx(ctx, async (tx) => {
      await tx`select app.auth_set_persona(${ctx.session.tokenHash}, ${body.userId})`;
      await audit(tx, { ...ctx, tenantId: null }, "demo.persona.set", "user", body.userId);
    });
    return json({ ok: true });
  },
  { tenant: false },
);
