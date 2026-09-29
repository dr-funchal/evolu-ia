-- 0005 — Administração: operador da plataforma (criação de equipes/tenants), cadastro de
-- hospitais/especialidades/serviços pelo admin do tenant e convite de membros.
--
-- Convite: a API cria (ou encontra) a conta no provedor de identidade e chama
-- app.admin_provision_member com o issuer/subject devolvido pelo IdP. O vínculo fica associado à
-- identidade (nunca só ao e-mail); no primeiro login, app.auth_login encontra a identidade
-- pré-cadastrada e as concessões já valem.

-- ---------------------------------------------------------------------------------------------
-- Operadores da plataforma (quem cria tenants). Sem política RLS: só via funções.
-- ---------------------------------------------------------------------------------------------
create table app.platform_admins (
  user_id uuid primary key references app.users(id),
  granted_at timestamptz not null default now(),
  note text
);
alter table app.platform_admins enable row level security;

-- Usa o usuário real (nunca a persona de demonstração).
create function app.is_platform_admin() returns boolean
language sql stable security definer set search_path = pg_catalog, app as $$
  select app.current_real_user_id() is not null
    and app.current_real_user_id() = app.current_user_id()
    and exists (select 1 from app.platform_admins where user_id = app.current_real_user_id())
$$;

-- ---------------------------------------------------------------------------------------------
-- Cadastro organizacional: desativar em vez de apagar (há histórico clínico apontando para eles).
-- ---------------------------------------------------------------------------------------------
alter table app.hospitals add column active boolean not null default true;
alter table app.services add column active boolean not null default true;
alter table app.memberships add column invited_by uuid references app.users(id);
alter table app.memberships add column invited_at timestamptz;

create policy tenants_admin_update on app.tenants for update
  using (app.has_cap(id, null, 'org.manage')) with check (app.has_cap(id, null, 'org.manage'));

create policy hospitals_admin_insert on app.hospitals for insert
  with check (app.has_cap(tenant_id, null, 'org.manage'));
create policy hospitals_admin_update on app.hospitals for update
  using (app.has_cap(tenant_id, null, 'org.manage')) with check (app.has_cap(tenant_id, null, 'org.manage'));
create policy specialties_admin_insert on app.specialties for insert
  with check (app.has_cap(tenant_id, null, 'org.manage'));
create policy services_admin_insert on app.services for insert
  with check (app.has_cap(tenant_id, null, 'org.manage'));
create policy services_admin_update on app.services for update
  using (app.has_cap(tenant_id, null, 'org.manage')) with check (app.has_cap(tenant_id, null, 'org.manage'));

grant update (name, timezone) on app.tenants to evolu_app;
grant insert, update (name, timezone, active) on app.hospitals to evolu_app;
grant insert on app.specialties to evolu_app;
grant insert, update (name, active) on app.services to evolu_app;

-- Serviço desativado sai do seletor de contexto.
create or replace function app.my_service_capabilities()
returns table (service_id uuid, hospital_id uuid, service_name text, hospital_name text, hospital_timezone text, capabilities text[])
language sql stable security definer set search_path = pg_catalog, app as $$
  select s.id, h.id, s.name, h.name, h.timezone,
         array(select rc.capability from (select distinct capability from app.role_capabilities) rc
               where app.user_has_cap(app.current_user_id(), s.tenant_id, s.id, rc.capability) order by 1)
  from app.services s
  join app.hospitals h on h.tenant_id = s.tenant_id and h.id = s.hospital_id
  where s.tenant_id = app.current_tenant_id() and app.is_active_member(s.tenant_id)
    and s.active and h.active
    and exists (select 1 from app.role_capabilities rc
                where app.user_has_cap(app.current_user_id(), s.tenant_id, s.id, rc.capability))
  order by h.name, s.name
$$;

-- ---------------------------------------------------------------------------------------------
-- Provisionamento de membro (convite). Encontra ou cria o usuário pela identidade do IdP e
-- garante o vínculo ativo no tenant. Exige org.manage no tenant da transação.
-- ---------------------------------------------------------------------------------------------
create function app.provision_identity(p_issuer text, p_subject text, p_email text, p_display_name text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, app as $$
declare v_user uuid;
begin
  if coalesce(p_issuer, '') = '' or coalesce(p_subject, '') = '' then
    raise exception 'identidade inválida' using errcode = '22023';
  end if;
  select user_id into v_user from app.user_identities where issuer = p_issuer and subject = p_subject;
  if v_user is null then
    insert into app.users (display_name, email) values (left(coalesce(nullif(trim(p_display_name), ''), 'Usuário'), 200), p_email)
      returning id into v_user;
    insert into app.user_identities (user_id, issuer, subject) values (v_user, p_issuer, p_subject);
  end if;
  return v_user;
end $$;
revoke all on function app.provision_identity(text, text, text, text) from public;

create function app.admin_provision_member(p_tenant uuid, p_issuer text, p_subject text, p_email text, p_display_name text)
returns table (user_id uuid, membership_id uuid)
language plpgsql volatile security definer set search_path = pg_catalog, app as $$
#variable_conflict use_column
declare
  v_user uuid;
  v_membership uuid;
begin
  if not app.has_cap(p_tenant, null, 'org.manage') then
    raise exception 'sem permissão para administrar a instituição' using errcode = '42501';
  end if;
  v_user := app.provision_identity(p_issuer, p_subject, p_email, p_display_name);
  insert into app.memberships (tenant_id, user_id, invited_by, invited_at)
    values (p_tenant, v_user, app.current_real_user_id(), now())
    on conflict (tenant_id, user_id) do update
      set status = 'active', valid_until = null
    returning id into v_membership;
  return query select v_user, v_membership;
end $$;

-- Membros do tenant com o estado do convite (primeiro acesso) — só para org.manage.
create function app.tenant_members(p_tenant uuid)
returns table (user_id uuid, display_name text, email text, membership_id uuid, status text,
               invited_at timestamptz, first_login_at timestamptz, last_login_at timestamptz,
               issuer text, subject text)
language sql stable security definer set search_path = pg_catalog, app as $$
  select u.id, u.display_name, u.email, m.id, m.status, m.invited_at,
         (select min(s.created_at) from app.sessions s where s.user_id = u.id),
         i.last_login_at, i.issuer, i.subject
  from app.memberships m
  join app.users u on u.id = m.user_id
  left join lateral (select * from app.user_identities x where x.user_id = u.id order by x.last_login_at desc nulls last limit 1) i on true
  where app.has_cap(p_tenant, null, 'org.manage') and m.tenant_id = p_tenant
  order by u.display_name
$$;

-- ---------------------------------------------------------------------------------------------
-- Plataforma: criar tenant com o primeiro administrador; listar tenants.
-- ---------------------------------------------------------------------------------------------
create function app.platform_create_tenant(
  p_name text, p_slug text, p_timezone text,
  p_admin_issuer text, p_admin_subject text, p_admin_email text, p_admin_name text
) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, app as $$
declare
  v_tenant uuid;
  v_user uuid;
  v_membership uuid;
begin
  if not app.is_platform_admin() then
    raise exception 'apenas operadores da plataforma criam instituições' using errcode = '42501';
  end if;
  insert into app.tenants (name, slug, timezone) values (trim(p_name), p_slug, p_timezone) returning id into v_tenant;
  -- Sem identidade informada: o próprio operador é o primeiro administrador.
  v_user := case when p_admin_subject is null then app.current_real_user_id()
                 else app.provision_identity(p_admin_issuer, p_admin_subject, p_admin_email, p_admin_name) end;
  insert into app.memberships (tenant_id, user_id, invited_by, invited_at)
    values (v_tenant, v_user, app.current_real_user_id(), now()) returning id into v_membership;
  insert into app.role_grants (tenant_id, membership_id, user_id, role, granted_by)
    values (v_tenant, v_membership, v_user, 'tenant_admin', app.current_real_user_id());
  insert into app.audit_events (tenant_id, actor_user_id, real_user_id, action, resource_type, resource_id, outcome)
    values (v_tenant, app.current_user_id(), app.current_real_user_id(), 'platform.tenant.create', 'tenant', v_tenant, 'allow');
  return v_tenant;
end $$;

create function app.platform_tenants()
returns table (id uuid, name text, slug text, timezone text, created_at timestamptz, members int, admins text[])
language sql stable security definer set search_path = pg_catalog, app as $$
  select t.id, t.name, t.slug, t.timezone, t.created_at,
         (select count(*)::int from app.memberships m where m.tenant_id = t.id and m.status = 'active'),
         array(select coalesce(u.email, u.display_name) from app.role_grants g join app.users u on u.id = g.user_id
               where g.tenant_id = t.id and g.role = 'tenant_admin' and g.revoked_at is null order by 1)
  from app.tenants t
  where app.is_platform_admin() and not t.is_synthetic
  order by t.name
$$;

revoke all on all functions in schema app from public;
grant execute on function app.is_platform_admin(), app.admin_provision_member(uuid, text, text, text, text),
  app.tenant_members(uuid), app.platform_create_tenant(text, text, text, text, text, text, text),
  app.platform_tenants(), app.my_service_capabilities() to evolu_app;
