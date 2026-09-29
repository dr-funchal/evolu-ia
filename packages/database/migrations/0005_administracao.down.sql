drop function if exists app.platform_tenants();
drop function if exists app.platform_create_tenant(text, text, text, text, text, text, text);
drop function if exists app.tenant_members(uuid);
drop function if exists app.admin_provision_member(uuid, text, text, text, text);
drop function if exists app.provision_identity(text, text, text, text);

create or replace function app.my_service_capabilities()
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

revoke insert, update on app.hospitals, app.services from evolu_app;
revoke insert on app.specialties from evolu_app;
revoke update on app.tenants from evolu_app;
drop policy if exists services_admin_update on app.services;
drop policy if exists services_admin_insert on app.services;
drop policy if exists specialties_admin_insert on app.specialties;
drop policy if exists hospitals_admin_update on app.hospitals;
drop policy if exists hospitals_admin_insert on app.hospitals;
drop policy if exists tenants_admin_update on app.tenants;

alter table app.memberships drop column if exists invited_at;
alter table app.memberships drop column if exists invited_by;
alter table app.services drop column if exists active;
alter table app.hospitals drop column if exists active;

drop function if exists app.is_platform_admin();
drop table if exists app.platform_admins;
