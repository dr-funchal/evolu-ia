-- Papéis para CI/teste local (senhas descartáveis). Mesmas propriedades de docker/postgres/00-roles.sh.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'evolu_owner') then
    create role evolu_owner login password 'evolu_owner_test' nosuperuser nobypassrls nocreaterole nocreatedb;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'evolu_app') then
    create role evolu_app login password 'evolu_app_test' nosuperuser nobypassrls nocreaterole nocreatedb noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'evolu_worker') then
    create role evolu_worker login password 'evolu_worker_test' nosuperuser nobypassrls nocreaterole nocreatedb noinherit;
  end if;
end $$;
