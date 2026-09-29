# Runbook — executar

## Local (desenvolvimento)

```bash
cp .env.example .env     # APP_MODE=development, AUTH_PROVIDER=mock, senhas locais
docker compose up -d db  # Postgres 17 em 127.0.0.1:5442; cria evolu_owner/app/worker e o banco do Zitadel
pnpm install
pnpm db:migrate && pnpm db:seed
pnpm dev                 # http://localhost:3000 — /auth/login?as=ana (mock só em development/test)
pnpm worker              # outro terminal
```

## Demonstração na VPS (`/var/www/evolu-ia`)

O código é editado fora da VPS e sincronizado com `scripts/sync-vps.sh` (rsync; não envia `.env`,
`node_modules` nem lockfile). Na VPS:

```bash
cd /var/www/evolu-ia
docker compose up -d db zitadel-api zitadel-login   # identidade
docker compose up -d --build web worker             # aplicação (imagem evolu-ia-app)
docker compose ps && curl -s http://127.0.0.1:3140/healthz
```

- nginx: `infra/nginx/*.conf` → `/etc/nginx/sites-available/` (evolu-ia.pulpfy.com → 3140;
  auth.pulpfy.com → 8140/3141). `evolu-ia-logformat.conf` → `/etc/nginx/conf.d/`.
- Primeiro deploy do Zitadel: ver [zitadel.md](zitadel.md).
- Logs: `docker compose logs -f web worker` (JSON, sem conteúdo clínico).
- **Nunca** colocar dado real: `APP_MODE=demo` e tenants sintéticos apenas.
