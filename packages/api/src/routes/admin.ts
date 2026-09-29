import { randomBytes } from "node:crypto";
import { ROLE_LABELS, isRole } from "@evolu/authorization";
import {
  AddGrant,
  CreateHospital,
  CreateService,
  CreateTenant,
  InviteMember,
  UpdateHospital,
  UpdateMembership,
  UpdateService,
  UpdateTenant,
  type GrantInput,
} from "@evolu/contracts";
import type { Tx } from "@evolu/database";
import { audit, requireCap, tenantTx, userTx, uuidParam, type Ctx } from "../context";
import { directory, type Invite } from "../directory";
import { conflict, forbidden, json, notFound, readJson } from "../http";
import { route } from "../router";

/**
 * Administração do tenant (org.manage): instituição, hospitais, serviços e membros.
 * Toda escrita passa pela RLS com o papel evolu_app; convites usam funções estreitas do banco.
 * Auditoria registra só ação e identificadores — nunca e-mail ou nome.
 */
function adminTx<T>(ctx: Ctx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return tenantTx(ctx, async (tx) => {
    await requireCap(ctx, tx, null, "org.manage");
    return fn(tx);
  });
}

interface MemberRow {
  user_id: string;
  display_name: string;
  email: string | null;
  membership_id: string;
  status: string;
  invited_at: Date | null;
  first_login_at: Date | null;
  last_login_at: Date | null;
  issuer: string | null;
  subject: string | null;
}

route("GET", "/v1/admin/overview", async (ctx) => {
  const data = await adminTx(ctx, async (tx) => {
    const [tenant] = await tx<{ id: string; name: string; timezone: string }[]>`select id, name, timezone from app.tenants where id = ${ctx.tenantId}`;
    const hospitals = await tx<{ id: string; name: string; timezone: string; active: boolean }[]>`
      select id, name, timezone, active from app.hospitals where tenant_id = ${ctx.tenantId} order by name`;
    const services = await tx<{ id: string; name: string; active: boolean; hospital_id: string; specialty: string }[]>`
      select s.id, s.name, s.active, s.hospital_id, sp.name as specialty
      from app.services s join app.specialties sp on sp.tenant_id = s.tenant_id and sp.id = s.specialty_id
      where s.tenant_id = ${ctx.tenantId} order by s.name`;
    const specialties = await tx<{ name: string }[]>`select name from app.specialties where tenant_id = ${ctx.tenantId} order by name`;
    const members = await tx<MemberRow[]>`select * from app.tenant_members(${ctx.tenantId})`;
    const grants = await tx<{ id: string; user_id: string; role: string; hospital_id: string | null; service_id: string | null; valid_until: Date | null }[]>`
      select id, user_id, role, hospital_id, service_id, valid_until from app.role_grants
      where tenant_id = ${ctx.tenantId} and revoked_at is null order by created_at`;
    return { tenant, hospitals, services, specialties, members, grants };
  });
  return json({
    tenant: data.tenant,
    hospitals: data.hospitals,
    services: data.services.map((s) => ({ id: s.id, name: s.name, active: s.active, hospitalId: s.hospital_id, specialty: s.specialty })),
    specialties: data.specialties.map((s) => s.name),
    roles: Object.entries(ROLE_LABELS).map(([id, label]) => ({ id, label })),
    members: data.members.map((m) => ({
      userId: m.user_id,
      displayName: m.display_name,
      email: m.email,
      membershipId: m.membership_id,
      status: m.status,
      invitedAt: m.invited_at,
      firstLoginAt: m.first_login_at ?? m.last_login_at,
      isSelf: m.user_id === ctx.session.realUserId,
      grants: data.grants
        .filter((g) => g.user_id === m.user_id)
        .map((g) => ({
          id: g.id,
          role: g.role,
          roleLabel: isRole(g.role) ? ROLE_LABELS[g.role] : g.role,
          hospitalId: g.hospital_id,
          serviceId: g.service_id,
          validUntil: g.valid_until,
        })),
    })),
  });
});

route("PATCH", "/v1/admin/tenant", async (ctx) => {
  const body = await readJson(ctx.req, UpdateTenant);
  await adminTx(ctx, async (tx) => {
    await tx`update app.tenants set name = coalesce(${body.name ?? null}, name), timezone = coalesce(${body.timezone ?? null}, timezone)
             where id = ${ctx.tenantId}`;
    await audit(tx, ctx, "admin.tenant.update", "tenant", ctx.tenantId);
  });
  return json({ ok: true });
});

route("POST", "/v1/admin/hospitals", async (ctx) => {
  const body = await readJson(ctx.req, CreateHospital);
  const id = await adminTx(ctx, async (tx) => {
    const [h] = await tx<{ id: string }[]>`insert into app.hospitals (tenant_id, name, timezone) values (${ctx.tenantId}, ${body.name}, ${body.timezone}) returning id`;
    await audit(tx, ctx, "admin.hospital.create", "hospital", h!.id);
    return h!.id;
  });
  return json({ id }, 201);
});

route("PATCH", "/v1/admin/hospitals/:id", async (ctx) => {
  const id = uuidParam(ctx);
  const body = await readJson(ctx.req, UpdateHospital);
  await adminTx(ctx, async (tx) => {
    const r = await tx`update app.hospitals set name = coalesce(${body.name ?? null}, name), timezone = coalesce(${body.timezone ?? null}, timezone),
                         active = coalesce(${body.active ?? null}, active)
                       where tenant_id = ${ctx.tenantId} and id = ${id}`;
    if (r.count === 0) throw notFound();
    await audit(tx, ctx, "admin.hospital.update", "hospital", id);
  });
  return json({ ok: true });
});

route("POST", "/v1/admin/services", async (ctx) => {
  const body = await readJson(ctx.req, CreateService);
  const id = await adminTx(ctx, async (tx) => {
    const [h] = await tx`select 1 from app.hospitals where tenant_id = ${ctx.tenantId} and id = ${body.hospitalId}`;
    if (!h) throw notFound();
    let [sp] = await tx<{ id: string }[]>`select id from app.specialties where tenant_id = ${ctx.tenantId} and lower(name) = lower(${body.specialty})`;
    if (!sp) [sp] = await tx<{ id: string }[]>`insert into app.specialties (tenant_id, name) values (${ctx.tenantId}, ${body.specialty}) returning id`;
    const [s] = await tx<{ id: string }[]>`
      insert into app.services (tenant_id, hospital_id, specialty_id, name) values (${ctx.tenantId}, ${body.hospitalId}, ${sp!.id}, ${body.name}) returning id`;
    await audit(tx, ctx, "admin.service.create", "service", s!.id);
    return s!.id;
  });
  return json({ id }, 201);
});

route("PATCH", "/v1/admin/services/:id", async (ctx) => {
  const id = uuidParam(ctx);
  const body = await readJson(ctx.req, UpdateService);
  await adminTx(ctx, async (tx) => {
    const r = await tx`update app.services set name = coalesce(${body.name ?? null}, name), active = coalesce(${body.active ?? null}, active)
                       where tenant_id = ${ctx.tenantId} and id = ${id}`;
    if (r.count === 0) throw notFound();
    await audit(tx, ctx, "admin.service.update", "service", id);
  });
  return json({ ok: true });
});

async function insertGrant(tx: Tx, ctx: Ctx, userId: string, membershipId: string, g: GrantInput): Promise<string> {
  const hospitalId = g.hospitalId ?? null;
  const serviceId = g.serviceId ?? null;
  const [dup] = await tx`select 1 from app.role_grants where tenant_id = ${ctx.tenantId} and user_id = ${userId} and role = ${g.role}
                           and hospital_id is not distinct from ${hospitalId} and service_id is not distinct from ${serviceId}
                           and revoked_at is null`;
  if (dup) return "";
  const [r] = await tx<{ id: string }[]>`
    insert into app.role_grants (tenant_id, membership_id, user_id, role, hospital_id, service_id, granted_by)
    values (${ctx.tenantId}, ${membershipId}, ${userId}, ${g.role}, ${hospitalId}, ${serviceId}, ${ctx.session.realUserId})
    returning id`;
  await audit(tx, ctx, `admin.grant.create:${g.role}`, "role_grant", r!.id);
  return r!.id;
}

route("POST", "/v1/admin/members", async (ctx) => {
  const body = await readJson(ctx.req, InviteMember);
  // Autoriza antes de tocar o provedor de identidade: quem não administra não cria contas.
  await adminTx(ctx, async () => undefined);
  const dir = directory();
  const account = await dir.ensureAccount(body.email, body.name);
  const userId = await adminTx(ctx, async (tx) => {
    const [p] = await tx<{ user_id: string; membership_id: string }[]>`
      select * from app.admin_provision_member(${ctx.tenantId}, ${account.issuer}, ${account.subject}, ${body.email}, ${body.name})`;
    for (const g of body.grants) await insertGrant(tx, ctx, p!.user_id, p!.membership_id, g);
    await audit(tx, ctx, "admin.member.invite", "user", p!.user_id);
    return p!.user_id;
  });
  const invite: Invite | null = account.pending ? await dir.invite(account.subject) : null;
  return json({ userId, existingAccount: !account.pending, invite }, 201);
});

async function loadMember(tx: Tx, ctx: Ctx, userId: string): Promise<MemberRow> {
  const [m] = await tx<MemberRow[]>`select * from app.tenant_members(${ctx.tenantId}) where user_id = ${userId}`;
  if (!m) throw notFound();
  return m;
}

route("POST", "/v1/admin/members/:id/invite", async (ctx) => {
  const id = uuidParam(ctx);
  const m = await adminTx(ctx, async (tx) => {
    const m = await loadMember(tx, ctx, id);
    await audit(tx, ctx, "admin.member.reinvite", "user", id);
    return m;
  });
  if (m.first_login_at || m.last_login_at) throw conflict("already_active", "Esta pessoa já acessou o sistema; não precisa de convite.");
  if (!m.subject) throw notFound();
  return json({ invite: await directory().invite(m.subject) });
});

route("PATCH", "/v1/admin/members/:id", async (ctx) => {
  const id = uuidParam(ctx);
  const body = await readJson(ctx.req, UpdateMembership);
  if (id === ctx.session.realUserId && body.status !== "active") {
    throw forbidden("self_lockout", "Você não pode suspender o próprio vínculo.");
  }
  await adminTx(ctx, async (tx) => {
    const m = await loadMember(tx, ctx, id);
    await tx`update app.memberships set status = ${body.status} where tenant_id = ${ctx.tenantId} and id = ${m.membership_id}`;
    await audit(tx, ctx, `admin.member.${body.status}`, "user", id);
  });
  return json({ ok: true });
});

route("POST", "/v1/admin/members/:id/grants", async (ctx) => {
  const id = uuidParam(ctx);
  const body = await readJson(ctx.req, AddGrant);
  const grantId = await adminTx(ctx, async (tx) => {
    const m = await loadMember(tx, ctx, id);
    return insertGrant(tx, ctx, id, m.membership_id, body);
  });
  if (!grantId) throw conflict("duplicate", "Esta pessoa já tem esse papel nesse escopo.");
  return json({ id: grantId }, 201);
});

route("POST", "/v1/admin/grants/:id/revoke", async (ctx) => {
  const id = uuidParam(ctx);
  await adminTx(ctx, async (tx) => {
    const [g] = await tx<{ user_id: string; role: string }[]>`
      select user_id, role from app.role_grants where tenant_id = ${ctx.tenantId} and id = ${id} and revoked_at is null`;
    if (!g) throw notFound();
    if (g.role === "tenant_admin") {
      const [n] = await tx<{ n: number }[]>`
        select count(*)::int n from app.role_grants g join app.memberships m on m.tenant_id = g.tenant_id and m.id = g.membership_id
        where g.tenant_id = ${ctx.tenantId} and g.role = 'tenant_admin' and g.revoked_at is null and m.status = 'active'`;
      if ((n?.n ?? 0) <= 1) throw conflict("last_admin", "A instituição precisa de pelo menos um administrador.");
    }
    await tx`update app.role_grants set revoked_at = now(), revoked_by = ${ctx.session.realUserId} where tenant_id = ${ctx.tenantId} and id = ${id}`;
    await audit(tx, ctx, `admin.grant.revoke:${g.role}`, "role_grant", id);
  });
  return json({ ok: true });
});

// ---------------------------------------------------------------------------------------------
// Plataforma: operadores criam instituições (tenants) e convidam o primeiro administrador.
// ---------------------------------------------------------------------------------------------
async function requirePlatformAdmin(tx: Tx) {
  const [r] = await tx<{ ok: boolean }[]>`select app.is_platform_admin() as ok`;
  if (!r?.ok) throw forbidden("platform_forbidden", "Apenas operadores da plataforma.");
}

function slugify(name: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "equipe"}-${randomBytes(3).toString("hex")}`;
}

route(
  "GET",
  "/v1/platform/tenants",
  async (ctx) => {
    const rows = await userTx(ctx, async (tx) => {
      await requirePlatformAdmin(tx);
      return tx<{ id: string; name: string; slug: string; timezone: string; created_at: Date; members: number; admins: string[] }[]>`
        select * from app.platform_tenants()`;
    });
    return json({ tenants: rows.map((t) => ({ ...t, createdAt: t.created_at, created_at: undefined })) });
  },
  { tenant: false },
);

route(
  "POST",
  "/v1/platform/tenants",
  async (ctx) => {
    const body = await readJson(ctx.req, CreateTenant);
    await userTx(ctx, requirePlatformAdmin);
    const dir = body.admin ? directory() : null;
    const account = body.admin && dir ? await dir.ensureAccount(body.admin.email, body.admin.name) : null;
    const tenantId = await userTx(ctx, async (tx) => {
      const [r] = await tx<{ id: string }[]>`
        select app.platform_create_tenant(${body.name}, ${slugify(body.name)}, ${body.timezone},
          ${account?.issuer ?? null}, ${account?.subject ?? null}, ${body.admin?.email ?? null}, ${body.admin?.name ?? null}) as id`;
      return r!.id;
    });
    const invite = account?.pending && dir ? await dir.invite(account.subject) : null;
    return json({ id: tenantId, invite, existingAccount: account ? !account.pending : true }, 201);
  },
  { tenant: false },
);
