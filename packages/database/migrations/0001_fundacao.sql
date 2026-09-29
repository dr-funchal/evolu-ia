-- 0001 — Fundação: schema, funções de contexto, identidade, organização, vínculos, auditoria,
-- idempotência, outbox, jobs e notificações.
--
-- Executada pelo papel evolu_owner (dono dos objetos). Os papéis de acesso evolu_app (web) e
-- evolu_worker são criados fora das migrations (docker/postgres/00-roles.sh e scripts/ci-roles.sql),
-- NÃO são superusuários, NÃO têm BYPASSRLS e NÃO são donos de tabelas.
-- Ver docs/adr/0003-autorizacao-e-rls.md.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'evolu_app') or
     not exists (select 1 from pg_roles where rolname = 'evolu_worker') then
    raise exception 'papéis evolu_app/evolu_worker precisam existir antes das migrations';
  end if;
  if exists (select 1 from pg_roles where rolname in ('evolu_app', 'evolu_worker') and (rolsuper or rolbypassrls)) then
    raise exception 'evolu_app/evolu_worker não podem ser superusuários nem ter BYPASSRLS';
  end if;
end $$;

create schema app;
revoke all on schema app from public;
grant usage on schema app to evolu_app, evolu_worker;

-- ---------------------------------------------------------------------------------------------
-- Contexto transacional. O servidor define app.user_id / app.tenant_id com set_config(..., true)
-- (escopo de transação), então nada sobrevive à devolução da conexão ao pool (SEC-05).
-- ---------------------------------------------------------------------------------------------
create function app.current_user_id() returns uuid
language sql stable set search_path = pg_catalog as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create function app.current_real_user_id() returns uuid
language sql stable set search_path = pg_catalog as $$
  select coalesce(nullif(current_setting('app.real_user_id', true), '')::uuid,
                  nullif(current_setting('app.user_id', true), '')::uuid)
$$;

create function app.current_tenant_id() returns uuid
language sql stable set search_path = pg_catalog as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

create function app.touch_updated_at() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  new.updated_at := now();
  return new;
end $$;

create function app.forbid_mutation() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'registro imutável: % em %', tg_op, tg_table_name using errcode = 'P0001';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Identidade global (exceção documentada: sem tenant_id). Identidade NÃO concede acesso clínico.
-- ---------------------------------------------------------------------------------------------
create table app.users (
  id uuid primary key default gen_random_uuid(),
  display_name text not null check (length(display_name) between 1 and 200),
  email text,
  is_synthetic boolean not null default false,
  is_demo_operator boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger users_touch before update on app.users for each row execute function app.touch_updated_at();

create table app.user_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.users(id),
  issuer text not null,
  subject text not null,
  created_at timestamptz not null default now(),
  last_login_at timestamptz,
  unique (issuer, subject)
);

create table app.sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  user_id uuid not null references app.users(id),
  acting_user_id uuid references app.users(id),
  mfa boolean not null default false,
  amr text[] not null default '{}',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index sessions_user_idx on app.sessions (user_id) where revoked_at is null;

-- ---------------------------------------------------------------------------------------------
-- Organização
-- ---------------------------------------------------------------------------------------------
create table app.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique check (slug ~ '^[a-z0-9-]{2,60}$'),
  timezone text not null default 'America/Sao_Paulo',
  is_synthetic boolean not null default false,
  created_at timestamptz not null default now()
);

create table app.memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  user_id uuid not null references app.users(id),
  status text not null default 'active' check (status in ('active', 'suspended', 'revoked')),
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, user_id),
  check (valid_until is null or valid_until > valid_from)
);
create trigger memberships_touch before update on app.memberships for each row execute function app.touch_updated_at();

create table app.hospitals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  name text not null,
  timezone text not null default 'America/Sao_Paulo',
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table app.specialties (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  name text not null,
  unique (tenant_id, id),
  unique (tenant_id, name)
);

create table app.services (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  hospital_id uuid not null,
  specialty_id uuid not null,
  name text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, hospital_id, id),
  foreign key (tenant_id, hospital_id) references app.hospitals (tenant_id, id),
  foreign key (tenant_id, specialty_id) references app.specialties (tenant_id, id)
);

create table app.units (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  hospital_id uuid not null,
  name text not null,
  unique (tenant_id, id),
  unique (tenant_id, hospital_id, id),
  foreign key (tenant_id, hospital_id) references app.hospitals (tenant_id, id)
);

create table app.beds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  hospital_id uuid not null,
  unit_id uuid not null,
  label text not null,
  unique (tenant_id, id),
  unique (tenant_id, hospital_id, id),
  foreign key (tenant_id, hospital_id, unit_id) references app.units (tenant_id, hospital_id, id)
);

-- Catálogo global papel → capacidade (espelha packages/authorization).
create table app.role_capabilities (
  role text not null,
  capability text not null,
  primary key (role, capability)
);

-- Concessão com escopo e vigência. Escopo: tenant inteiro (hospital e serviço nulos),
-- hospital (serviço nulo) ou serviço.
create table app.role_grants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  membership_id uuid not null,
  user_id uuid not null references app.users(id),
  role text not null check (role in ('tenant_admin', 'clinical_coordinator', 'attending_physician', 'resident', 'secretary', 'finance')),
  hospital_id uuid,
  service_id uuid,
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references app.users(id),
  granted_by uuid references app.users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, membership_id) references app.memberships (tenant_id, id),
  foreign key (tenant_id, hospital_id) references app.hospitals (tenant_id, id),
  foreign key (tenant_id, hospital_id, service_id) references app.services (tenant_id, hospital_id, id),
  check (service_id is null or hospital_id is not null),
  check (valid_until is null or valid_until > valid_from)
);
create index role_grants_user_idx on app.role_grants (user_id, tenant_id) where revoked_at is null;

-- Garante que o usuário da concessão é o mesmo do vínculo.
create function app.role_grant_membership_check() returns trigger
language plpgsql set search_path = pg_catalog, app as $$
begin
  if not exists (select 1 from app.memberships m where m.tenant_id = new.tenant_id and m.id = new.membership_id and m.user_id = new.user_id) then
    raise exception 'concessão incompatível com o vínculo' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger role_grants_membership before insert or update on app.role_grants
  for each row execute function app.role_grant_membership_check();

-- ---------------------------------------------------------------------------------------------
-- Funções de autorização (SECURITY DEFINER, dono evolu_owner, search_path fixo).
-- Respondem apenas sobre o usuário do contexto atual e exigem que o tenant consultado seja o
-- tenant da transação: um usuário com vínculos em dois tenants nunca vê ambos numa mesma consulta.
-- ---------------------------------------------------------------------------------------------
create function app.user_has_cap(p_user uuid, p_tenant uuid, p_service uuid, p_cap text) returns boolean
language sql stable security definer set search_path = pg_catalog, app as $$
  select p_user is not null and p_tenant is not null and exists (
    select 1
    from app.role_grants g
    join app.memberships m on m.tenant_id = g.tenant_id and m.id = g.membership_id and m.user_id = g.user_id
    join app.role_capabilities rc on rc.role = g.role and rc.capability = p_cap
    left join app.services s on s.tenant_id = p_tenant and s.id = p_service
    where g.tenant_id = p_tenant
      and g.user_id = p_user
      and m.status = 'active' and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
      and g.revoked_at is null and g.valid_from <= now() and (g.valid_until is null or g.valid_until > now())
      and (
        (g.hospital_id is null and g.service_id is null)
        or (g.service_id is null and s.id is not null and g.hospital_id = s.hospital_id)
        or (p_service is not null and g.service_id = p_service)
      )
  )
$$;

create function app.has_cap(p_tenant uuid, p_service uuid, p_cap text) returns boolean
language sql stable security definer set search_path = pg_catalog, app as $$
  select p_tenant = app.current_tenant_id() and app.user_has_cap(app.current_user_id(), p_tenant, p_service, p_cap)
$$;

-- Capacidade em qualquer escopo do hospital (inclui concessões de serviço desse hospital).
create function app.has_cap_in_hospital(p_tenant uuid, p_hospital uuid, p_cap text) returns boolean
language sql stable security definer set search_path = pg_catalog, app as $$
  select p_tenant = app.current_tenant_id() and exists (
    select 1
    from app.role_grants g
    join app.memberships m on m.tenant_id = g.tenant_id and m.id = g.membership_id and m.user_id = g.user_id
    join app.role_capabilities rc on rc.role = g.role and rc.capability = p_cap
    where g.tenant_id = p_tenant and g.user_id = app.current_user_id()
      and m.status = 'active' and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
      and g.revoked_at is null and g.valid_from <= now() and (g.valid_until is null or g.valid_until > now())
      and (g.hospital_id is null or g.hospital_id = p_hospital)
  )
$$;

-- Capacidade em qualquer escopo do tenant atual.
create function app.has_cap_any(p_tenant uuid, p_cap text) returns boolean
language sql stable security definer set search_path = pg_catalog, app as $$
  select p_tenant = app.current_tenant_id() and exists (
    select 1
    from app.role_grants g
    join app.memberships m on m.tenant_id = g.tenant_id and m.id = g.membership_id and m.user_id = g.user_id
    join app.role_capabilities rc on rc.role = g.role and rc.capability = p_cap
    where g.tenant_id = p_tenant and g.user_id = app.current_user_id()
      and m.status = 'active' and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
      and g.revoked_at is null and g.valid_from <= now() and (g.valid_until is null or g.valid_until > now())
  )
$$;

create function app.is_active_member(p_tenant uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, app as $$
  select exists (
    select 1 from app.memberships m
    where m.tenant_id = p_tenant and m.user_id = app.current_user_id()
      and m.status = 'active' and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
  )
$$;

-- Para exibir nomes de colegas (autor, receptor): o outro usuário precisa ter vínculo ativo
-- no tenant atual e o usuário atual também.
create function app.shares_current_tenant(p_user uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, app as $$
  select app.current_tenant_id() is not null
    and app.is_active_member(app.current_tenant_id())
    and exists (select 1 from app.memberships m where m.tenant_id = app.current_tenant_id() and m.user_id = p_user)
$$;

-- ---------------------------------------------------------------------------------------------
-- Autenticação: funções estreitas usadas pelo callback OIDC e pela resolução de sessão.
-- A aplicação não lê app.sessions nem app.user_identities diretamente.
-- ---------------------------------------------------------------------------------------------
create function app.auth_login(
  p_issuer text, p_subject text, p_email text, p_display_name text,
  p_token_hash text, p_expires_at timestamptz, p_amr text[], p_mfa boolean
) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, app as $$
declare
  v_user uuid;
begin
  if p_issuer is null or p_subject is null or length(p_token_hash) < 32 then
    raise exception 'parâmetros de login inválidos' using errcode = '22023';
  end if;
  select user_id into v_user from app.user_identities where issuer = p_issuer and subject = p_subject;
  if v_user is null then
    insert into app.users (display_name, email) values (coalesce(nullif(p_display_name, ''), 'Usuário'), p_email)
      returning id into v_user;
    insert into app.user_identities (user_id, issuer, subject, last_login_at) values (v_user, p_issuer, p_subject, now());
  else
    update app.user_identities set last_login_at = now() where issuer = p_issuer and subject = p_subject;
    update app.users set email = coalesce(p_email, email) where id = v_user;
  end if;
  insert into app.sessions (token_hash, user_id, expires_at, amr, mfa)
    values (p_token_hash, v_user, p_expires_at, coalesce(p_amr, '{}'), coalesce(p_mfa, false));
  return v_user;
end $$;

create function app.auth_resolve_session(p_token_hash text, p_idle_minutes int)
returns table (session_id uuid, user_id uuid, acting_user_id uuid, display_name text, acting_display_name text,
               is_demo_operator boolean, mfa boolean, expires_at timestamptz)
language plpgsql volatile security definer set search_path = pg_catalog, app as $$
begin
  return query
  update app.sessions s set last_seen_at = now()
  from app.users u
  where s.token_hash = p_token_hash
    and u.id = s.user_id
    and s.revoked_at is null
    and s.expires_at > now()
    and s.last_seen_at > now() - make_interval(mins => p_idle_minutes)
  returning s.id, s.user_id, s.acting_user_id, u.display_name,
    (select a.display_name from app.users a where a.id = s.acting_user_id),
    u.is_demo_operator, s.mfa, s.expires_at;
end $$;

create function app.auth_logout(p_token_hash text) returns void
language sql volatile security definer set search_path = pg_catalog, app as $$
  update app.sessions set revoked_at = now() where token_hash = p_token_hash and revoked_at is null
$$;

-- Demonstração: persona só pode ser usuário sintético; o operador precisa estar marcado.
-- A aplicação recusa esta chamada fora do modo demo (packages/api).
create function app.auth_set_persona(p_token_hash text, p_persona uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, app as $$
declare
  v_session app.sessions%rowtype;
begin
  select * into v_session from app.sessions where token_hash = p_token_hash and revoked_at is null and expires_at > now();
  if not found then raise exception 'sessão inválida' using errcode = '28000'; end if;
  if not exists (select 1 from app.users where id = v_session.user_id and is_demo_operator) then
    raise exception 'usuário não é operador de demonstração' using errcode = '42501';
  end if;
  if p_persona is not null and not exists (select 1 from app.users where id = p_persona and is_synthetic) then
    raise exception 'persona precisa ser usuário sintético' using errcode = '42501';
  end if;
  update app.sessions set acting_user_id = p_persona where id = v_session.id;
end $$;

create function app.auth_mark_demo_operator(p_user uuid) returns void
language sql volatile security definer set search_path = pg_catalog, app as $$
  update app.users set is_demo_operator = true where id = p_user and not is_synthetic
$$;

create function app.demo_personas()
returns table (user_id uuid, display_name text, tenant_name text, role text, scope text)
language sql stable security definer set search_path = pg_catalog, app as $$
  select u.id, u.display_name, t.name, g.role,
         coalesce(s.name, h.name, 'Tenant inteiro')
  from app.users u
  join app.role_grants g on g.user_id = u.id and g.revoked_at is null
  join app.tenants t on t.id = g.tenant_id and t.is_synthetic
  left join app.hospitals h on h.tenant_id = g.tenant_id and h.id = g.hospital_id
  left join app.services s on s.tenant_id = g.tenant_id and s.id = g.service_id
  where u.is_synthetic
  order by u.display_name, t.name, g.role
$$;

create function app.revoke_user_sessions(p_user uuid) returns int
language plpgsql volatile security definer set search_path = pg_catalog, app as $$
declare n int;
begin
  update app.sessions set revoked_at = now() where (user_id = p_user or acting_user_id = p_user) and revoked_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Auditoria append-only (sem conteúdo clínico: só ação, recurso, resultado, código).
-- ---------------------------------------------------------------------------------------------
create table app.audit_events (
  id bigint generated always as identity primary key,
  tenant_id uuid references app.tenants(id),
  actor_user_id uuid references app.users(id),
  real_user_id uuid references app.users(id),
  action text not null,
  resource_type text,
  resource_id uuid,
  outcome text not null check (outcome in ('allow', 'deny', 'error')),
  reason_code text,
  request_id text,
  at timestamptz not null default now()
);
create index audit_events_tenant_idx on app.audit_events (tenant_id, at desc);
create trigger audit_events_immutable before update or delete on app.audit_events
  for each row execute function app.forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Idempotência de comandos sensíveis (escopo tenant + usuário + operação).
-- ---------------------------------------------------------------------------------------------
create table app.idempotency_keys (
  tenant_id uuid not null references app.tenants(id),
  user_id uuid not null references app.users(id),
  operation text not null,
  key text not null check (length(key) between 8 and 200),
  request_hash text not null,
  response_status int,
  response_body jsonb,
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id, operation, key)
);

-- ---------------------------------------------------------------------------------------------
-- Outbox transacional: payload mínimo (IDs, versão). Consumidores carregam dados com autorização.
-- ---------------------------------------------------------------------------------------------
create table app.outbox_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references app.tenants(id),
  event_type text not null,
  aggregate_type text not null,
  aggregate_id uuid not null,
  actor_user_id uuid references app.users(id),
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  processed_at timestamptz,
  attempts int not null default 0,
  last_error_code text,
  locked_until timestamptz
);
create index outbox_pending_idx on app.outbox_events (available_at) where processed_at is null;

-- Jobs duráveis (worker separado).
create table app.jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  kind text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  requested_by uuid not null references app.users(id),
  resource_type text,
  resource_id uuid,
  idempotency_key text not null,
  attempts int not null default 0,
  max_attempts int not null default 5,
  run_after timestamptz not null default now(),
  locked_until timestamptz,
  locked_by text,
  last_error_code text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, kind, idempotency_key)
);
create index jobs_ready_idx on app.jobs (run_after) where status = 'queued';
create trigger jobs_touch before update on app.jobs for each row execute function app.touch_updated_at();

-- Notificações: texto genérico + link autenticado; nunca nome de paciente ou diagnóstico.
create table app.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  recipient_user_id uuid not null references app.users(id),
  source_event_id bigint references app.outbox_events(id),
  kind text not null,
  generic_text text not null check (length(generic_text) <= 140),
  link_path text not null check (link_path ~ '^/[A-Za-z0-9/_-]*$'),
  status text not null default 'pending' check (status in ('pending', 'delivered', 'read', 'cancelled_access')),
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  read_at timestamptz,
  unique (source_event_id, recipient_user_id)
);

-- ---------------------------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------------------------
alter table app.users enable row level security;
alter table app.user_identities enable row level security;
alter table app.sessions enable row level security;
alter table app.tenants enable row level security;
alter table app.memberships enable row level security;
alter table app.hospitals enable row level security;
alter table app.specialties enable row level security;
alter table app.services enable row level security;
alter table app.units enable row level security;
alter table app.beds enable row level security;
alter table app.role_capabilities enable row level security;
alter table app.role_grants enable row level security;
alter table app.audit_events enable row level security;
alter table app.idempotency_keys enable row level security;
alter table app.outbox_events enable row level security;
alter table app.jobs enable row level security;
alter table app.notification_deliveries enable row level security;

-- users: o próprio usuário ou colegas do tenant atual.
create policy users_select on app.users for select
  using (id = app.current_user_id() or app.shares_current_tenant(id));

-- user_identities e sessions: sem política para evolu_app → acesso negado; só via funções auth_*.

create policy tenants_select on app.tenants for select using (app.is_active_member(id));

create policy memberships_select on app.memberships for select
  using (user_id = app.current_user_id() or app.has_cap(tenant_id, null, 'org.manage'));
create policy memberships_write on app.memberships for all
  using (app.has_cap(tenant_id, null, 'org.manage'))
  with check (app.has_cap(tenant_id, null, 'org.manage'));

create policy hospitals_select on app.hospitals for select
  using (tenant_id = app.current_tenant_id() and app.is_active_member(tenant_id));
create policy specialties_select on app.specialties for select
  using (tenant_id = app.current_tenant_id() and app.is_active_member(tenant_id));
create policy services_select on app.services for select
  using (tenant_id = app.current_tenant_id() and app.is_active_member(tenant_id));
create policy units_select on app.units for select
  using (tenant_id = app.current_tenant_id() and app.is_active_member(tenant_id));
create policy beds_select on app.beds for select
  using (tenant_id = app.current_tenant_id() and app.is_active_member(tenant_id));

create policy role_capabilities_select on app.role_capabilities for select using (true);

-- Concessões próprias são visíveis em todos os tenants (seletor de contexto); as demais só para org.manage.
create policy role_grants_select on app.role_grants for select
  using (user_id = app.current_user_id() or app.has_cap(tenant_id, null, 'org.manage'));
create policy role_grants_write on app.role_grants for all
  using (app.has_cap(tenant_id, null, 'org.manage'))
  with check (app.has_cap(tenant_id, null, 'org.manage'));

create policy audit_insert on app.audit_events for insert
  with check (actor_user_id is not distinct from app.current_user_id()
              and (tenant_id is null or tenant_id = app.current_tenant_id()));
create policy audit_select on app.audit_events for select
  using (tenant_id is not null and app.has_cap(tenant_id, null, 'audit.read'));
create policy audit_worker_insert on app.audit_events for insert to evolu_worker with check (true);

create policy idem_own on app.idempotency_keys for all
  using (tenant_id = app.current_tenant_id() and user_id = app.current_user_id())
  with check (tenant_id = app.current_tenant_id() and user_id = app.current_user_id());

create policy outbox_insert on app.outbox_events for insert
  with check (tenant_id = app.current_tenant_id() and app.is_active_member(tenant_id));
create policy outbox_worker on app.outbox_events for all to evolu_worker using (true) with check (true);

create policy jobs_own on app.jobs for select
  using (tenant_id = app.current_tenant_id() and requested_by = app.current_user_id());
create policy jobs_insert on app.jobs for insert
  with check (tenant_id = app.current_tenant_id() and requested_by = app.current_user_id() and app.is_active_member(tenant_id));
create policy jobs_worker on app.jobs for all to evolu_worker using (true) with check (true);

create policy notif_own on app.notification_deliveries for select
  using (tenant_id = app.current_tenant_id() and recipient_user_id = app.current_user_id());
create policy notif_own_read on app.notification_deliveries for update
  using (tenant_id = app.current_tenant_id() and recipient_user_id = app.current_user_id())
  with check (tenant_id = app.current_tenant_id() and recipient_user_id = app.current_user_id());
create policy notif_worker on app.notification_deliveries for all to evolu_worker using (true) with check (true);

-- ---------------------------------------------------------------------------------------------
-- Privilégios (sem DELETE nas tabelas de negócio; histórico nunca é apagado pela aplicação).
-- ---------------------------------------------------------------------------------------------
grant select on app.users, app.tenants, app.memberships, app.hospitals, app.specialties, app.services,
  app.units, app.beds, app.role_capabilities, app.role_grants to evolu_app;
grant insert, update on app.memberships, app.role_grants to evolu_app;
grant select, insert on app.audit_events to evolu_app;
grant select, insert, update on app.idempotency_keys to evolu_app;
grant insert on app.outbox_events to evolu_app;
grant select, insert on app.jobs to evolu_app;
grant select, update on app.notification_deliveries to evolu_app;

grant select, update on app.outbox_events to evolu_worker;
grant select, update on app.jobs to evolu_worker;
grant select, insert, update on app.notification_deliveries to evolu_worker;
grant insert on app.audit_events to evolu_worker;
grant select on app.users, app.tenants, app.services, app.hospitals, app.role_capabilities to evolu_worker;

revoke all on all functions in schema app from public;
grant execute on all functions in schema app to evolu_app, evolu_worker;
