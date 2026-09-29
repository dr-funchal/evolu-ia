-- 0004 — Funções de leitura estreitas (SECURITY DEFINER) para o seletor de contexto e para a
-- escolha de colegas (receptor de passagem, responsável de tarefa). Respondem apenas sobre o
-- usuário do contexto e só para escopos em que ele próprio tem acesso.

-- Concessões do próprio usuário, com nomes, em todos os tenants (seletor de contexto).
create function app.my_scopes()
returns table (tenant_id uuid, tenant_name text, tenant_timezone text, is_synthetic boolean, role text,
               hospital_id uuid, hospital_name text, service_id uuid, service_name text)
language sql stable security definer set search_path = pg_catalog, app as $$
  select t.id, t.name, t.timezone, t.is_synthetic, g.role, h.id, h.name, s.id, s.name
  from app.role_grants g
  join app.memberships m on m.tenant_id = g.tenant_id and m.id = g.membership_id and m.user_id = g.user_id
  join app.tenants t on t.id = g.tenant_id
  left join app.hospitals h on h.tenant_id = g.tenant_id and h.id = g.hospital_id
  left join app.services s on s.tenant_id = g.tenant_id and s.id = g.service_id
  where g.user_id = app.current_user_id()
    and m.status = 'active' and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
    and g.revoked_at is null and g.valid_from <= now() and (g.valid_until is null or g.valid_until > now())
  order by t.name, h.name nulls first, s.name nulls first
$$;

-- Capacidades efetivas do usuário por serviço no tenant atual (para projeção e interface).
create function app.my_service_capabilities()
returns table (service_id uuid, hospital_id uuid, service_name text, hospital_name text, hospital_timezone text, capabilities text[])
language sql stable security definer set search_path = pg_catalog, app as $$
  select s.id, h.id, s.name, h.name, h.timezone,
         array(select rc.capability from (select distinct capability from app.role_capabilities) rc
               where app.user_has_cap(app.current_user_id(), s.tenant_id, s.id, rc.capability) order by 1)
  from app.services s
  join app.hospitals h on h.tenant_id = s.tenant_id and h.id = s.hospital_id
  where s.tenant_id = app.current_tenant_id() and app.is_active_member(s.tenant_id)
    and exists (select 1 from app.role_capabilities rc
                where app.user_has_cap(app.current_user_id(), s.tenant_id, s.id, rc.capability))
  order by h.name, s.name
$$;

-- Equipe do serviço com a capacidade pedida. Exige que o solicitante leia o serviço.
create function app.service_team(p_tenant uuid, p_service uuid, p_cap text)
returns table (user_id uuid, display_name text)
language sql stable security definer set search_path = pg_catalog, app as $$
  select u.id, u.display_name
  from app.users u
  where app.has_cap(p_tenant, p_service, 'patient.basic.read')
    and exists (select 1 from app.memberships m where m.tenant_id = p_tenant and m.user_id = u.id and m.status = 'active')
    and app.user_has_cap(u.id, p_tenant, p_service, p_cap)
  order by u.display_name
$$;

grant select on app.problems, app.users to evolu_worker;
revoke all on all functions in schema app from public;
grant execute on all functions in schema app to evolu_app, evolu_worker;

-- Possível duplicidade no cadastro (mesmo tenant). Devolve só o mínimo para o usuário decidir:
-- id, iniciais e data de nascimento, sem vínculo clínico. Exige escrita de cadastro no tenant.
create function app.possible_duplicate_patients(p_tenant uuid, p_full_name text, p_birth date)
returns table (patient_id uuid, initials text, birth_date date)
language sql stable security definer set search_path = pg_catalog, app as $$
  select p.id,
         (select string_agg(left(w, 1), '' order by ord) from unnest(string_to_array(p.full_name, ' ')) with ordinality as t(w, ord)
          where length(w) > 2),
         p.birth_date
  from app.patients p
  where app.has_cap_any(p_tenant, 'patient.basic.write')
    and p.tenant_id = p_tenant
    and lower(p.full_name) = lower(trim(p_full_name))
    and (p_birth is null or p.birth_date is null or p.birth_date = p_birth)
  limit 5
$$;
revoke all on function app.possible_duplicate_patients(uuid, text, date) from public;
grant execute on function app.possible_duplicate_patients(uuid, text, date) to evolu_app;
