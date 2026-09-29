create or replace function app.user_has_cap(p_user uuid, p_tenant uuid, p_service uuid, p_cap text) returns boolean
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
revoke update (handoffs_enabled) on app.tenants from evolu_app;
alter table app.tenants drop column handoffs_enabled;
