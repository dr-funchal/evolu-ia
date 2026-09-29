# Runbook — migrations

Migrations SQL em `packages/database/migrations/NNNN_nome.sql` + `NNNN_nome.down.sql`, aplicadas
com o papel dono (`MIGRATION_DATABASE_URL` → `evolu_owner`). A aplicação nunca migra.

```bash
pnpm db:status          # aplicadas / pendentes
pnpm db:migrate         # aplica pendentes, cada uma em transação
pnpm db:rollback 1      # desfaz a última (N para desfazer N)
```

Na VPS, com o `.env` carregado (o banco escuta em 127.0.0.1:5442):

```bash
cd /var/www/evolu-ia && set -a && . ./.env && set +a && pnpm db:status && pnpm db:migrate
docker compose restart web worker
```

Regras:
1. **Faça backup antes** (`./scripts/backup.sh`).
2. Toda tabela nova em `app` precisa de `enable row level security` + políticas e de grants
   mínimos a `evolu_app`/`evolu_worker`; o teste de isolamento falha se faltar RLS.
3. Nunca editar migration já aplicada: crie outra.
4. O CI aplica tudo, desfaz tudo e aplica de novo — o `down` precisa funcionar.
