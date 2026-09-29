#!/bin/sh
# Executado uma única vez na inicialização do volume do PostgreSQL (docker-entrypoint-initdb.d).
# Cria o banco da aplicação e três papéis:
#   evolu_owner  — dono do schema; só migrations e seed.
#   evolu_app    — web; NOSUPERUSER, NOBYPASSRLS, sem ownership (RLS sempre aplicada).
#   evolu_worker — worker; idem.
set -eu
: "${EVOLU_OWNER_PASSWORD:?}" "${EVOLU_APP_PASSWORD:?}" "${EVOLU_WORKER_PASSWORD:?}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner_pw="$EVOLU_OWNER_PASSWORD" -v app_pw="$EVOLU_APP_PASSWORD" -v worker_pw="$EVOLU_WORKER_PASSWORD" <<'SQL'
create role evolu_owner login password :'owner_pw' nosuperuser nobypassrls nocreaterole nocreatedb;
create role evolu_app login password :'app_pw' nosuperuser nobypassrls nocreaterole nocreatedb noinherit;
create role evolu_worker login password :'worker_pw' nosuperuser nobypassrls nocreaterole nocreatedb noinherit;
create database evolu owner evolu_owner;
revoke all on database evolu from public;
grant connect on database evolu to evolu_app, evolu_worker;
SQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname evolu <<'SQL'
revoke create on schema public from public;
alter default privileges for role evolu_owner revoke execute on functions from public;
SQL
