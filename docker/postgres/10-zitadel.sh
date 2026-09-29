#!/bin/sh
# Banco e papel próprios do Zitadel no mesmo servidor PostgreSQL, isolados do banco clínico:
# o papel zitadel não tem superuser nem acesso ao banco evolu, e nenhum papel do Evolu-IA acessa o banco zitadel.
# Em volume já inicializado, rode manualmente: docker compose exec -T db sh < docker/postgres/10-zitadel.sh
set -eu
: "${ZITADEL_DB_PASSWORD:?}"
psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname postgres -v zpw="$ZITADEL_DB_PASSWORD" <<'SQL'
select 'create role zitadel login nosuperuser nobypassrls nocreaterole nocreatedb'
where not exists (select 1 from pg_roles where rolname = 'zitadel') \gexec
alter role zitadel password :'zpw';
select 'create database zitadel owner zitadel'
where not exists (select 1 from pg_database where datname = 'zitadel') \gexec
revoke all on database zitadel from public;
revoke connect on database evolu from zitadel;
SQL
