-- 0006 — Escala: séries recorrentes (RRULE em horário local + fuso IANA) com rascunho → publicação
-- e exceções por ocorrência ancoradas no início local original.
--
-- As ocorrências são calculadas a partir da série na leitura (packages/domain/src/recurrence.ts),
-- sem tabela materializada; ver ADR 0012. Escala não contém dado de paciente: qualquer membro ativo
-- vê a escala publicada; rascunhos só quem pode montar escala no serviço.
-- Publicar (ou alterar o que já foi publicado) exige schedule.publish, verificado também na RLS.

create table app.schedule_series (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  hospital_id uuid not null,
  service_id uuid not null,
  modality text not null check (modality in ('visita', 'retaguarda', 'plantao')),
  assignee_user_id uuid not null references app.users(id),
  timezone text not null check (length(timezone) between 1 and 64),
  dtstart_local timestamp(0) not null,
  duration_minutes int not null check (duration_minutes between 15 and 2880),
  rrule text check (rrule is null or length(rrule) <= 200),
  until_local date,
  notes text check (notes is null or length(notes) <= 500),
  status text not null default 'draft' check (status in ('draft', 'published', 'cancelled')),
  version int not null default 1,
  -- Série criada ao dividir outra ("esta e as próximas").
  split_from uuid references app.schedule_series(id),
  created_by uuid not null references app.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  published_by uuid references app.users(id),
  unique (tenant_id, id),
  check (until_local is null or until_local >= dtstart_local::date),
  foreign key (tenant_id, hospital_id, service_id) references app.services (tenant_id, hospital_id, id)
);
create index schedule_series_tenant_idx on app.schedule_series (tenant_id, status, service_id);

create table app.schedule_exceptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  series_id uuid not null,
  original_start_local timestamp(0) not null,
  -- 'none' = exceção desfeita (sem DELETE: o histórico fica na auditoria e nesta linha).
  kind text not null check (kind in ('cancelled', 'reassigned', 'none')),
  assignee_user_id uuid references app.users(id),
  reason text check (reason is null or length(reason) <= 300),
  updated_by uuid not null references app.users(id),
  updated_at timestamptz not null default now(),
  unique (series_id, original_start_local),
  check ((kind = 'reassigned') = (assignee_user_id is not null)),
  foreign key (tenant_id, series_id) references app.schedule_series (tenant_id, id)
);

alter table app.schedule_series enable row level security;
alter table app.schedule_exceptions enable row level security;

create policy schedule_series_select on app.schedule_series for select
  using (tenant_id = app.current_tenant_id() and app.is_active_member(tenant_id)
         and (status <> 'draft' or app.has_cap(tenant_id, service_id, 'schedule.draft')));
create policy schedule_series_insert on app.schedule_series for insert
  with check (app.has_cap(tenant_id, service_id, 'schedule.draft')
              and (status = 'draft' or app.has_cap(tenant_id, service_id, 'schedule.publish')));
create policy schedule_series_update on app.schedule_series for update
  using (app.has_cap(tenant_id, service_id, 'schedule.draft')
         and (status = 'draft' or app.has_cap(tenant_id, service_id, 'schedule.publish')))
  with check (app.has_cap(tenant_id, service_id, 'schedule.draft')
              and (status = 'draft' or app.has_cap(tenant_id, service_id, 'schedule.publish')));

-- Exceções seguem a série: visíveis se a série é visível; alteráveis por quem pode alterar a série.
create policy schedule_exceptions_select on app.schedule_exceptions for select
  using (exists (select 1 from app.schedule_series s where s.tenant_id = schedule_exceptions.tenant_id and s.id = schedule_exceptions.series_id));
create policy schedule_exceptions_write on app.schedule_exceptions for all
  using (exists (select 1 from app.schedule_series s
                 where s.tenant_id = schedule_exceptions.tenant_id and s.id = schedule_exceptions.series_id
                   and app.has_cap(s.tenant_id, s.service_id, 'schedule.draft')
                   and (s.status = 'draft' or app.has_cap(s.tenant_id, s.service_id, 'schedule.publish'))))
  with check (exists (select 1 from app.schedule_series s
                      where s.tenant_id = schedule_exceptions.tenant_id and s.id = schedule_exceptions.series_id
                        and app.has_cap(s.tenant_id, s.service_id, 'schedule.draft')
                        and (s.status = 'draft' or app.has_cap(s.tenant_id, s.service_id, 'schedule.publish'))));

grant select, insert, update on app.schedule_series, app.schedule_exceptions to evolu_app;

-- Membros ativos do tenant que podem ser escalados num serviço (qualquer papel que cubra o serviço).
-- Só para quem monta escala nesse serviço; não expõe e-mail.
create function app.schedule_assignable(p_service uuid)
returns table (user_id uuid, display_name text)
language sql stable security definer set search_path = pg_catalog, app as $$
  select u.id, u.display_name
  from app.memberships m
  join app.users u on u.id = m.user_id
  where m.tenant_id = app.current_tenant_id()
    and app.has_cap(m.tenant_id, p_service, 'schedule.draft')
    and m.status = 'active' and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
    and app.user_has_cap(m.user_id, m.tenant_id, p_service, 'patient.basic.read')
  order by u.display_name
$$;

-- Serviços ativos do tenant (a escala mostra todos, mesmo sem papel clínico no serviço).
create function app.tenant_active_services()
returns table (service_id uuid, hospital_id uuid, service_name text, hospital_name text, hospital_timezone text,
               can_draft boolean, can_publish boolean)
language sql stable security definer set search_path = pg_catalog, app as $$
  select s.id, h.id, s.name, h.name, h.timezone,
         app.has_cap(s.tenant_id, s.id, 'schedule.draft'), app.has_cap(s.tenant_id, s.id, 'schedule.publish')
  from app.services s
  join app.hospitals h on h.tenant_id = s.tenant_id and h.id = s.hospital_id
  where s.tenant_id = app.current_tenant_id() and app.is_active_member(s.tenant_id) and s.active and h.active
  order by h.name, s.name
$$;

revoke all on function app.schedule_assignable(uuid), app.tenant_active_services() from public;
grant execute on function app.schedule_assignable(uuid), app.tenant_active_services() to evolu_app;
