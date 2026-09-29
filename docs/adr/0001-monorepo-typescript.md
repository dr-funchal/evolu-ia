# ADR 0001 — Monorepo TypeScript com API agnóstica de framework

- **Status:** aceito (2026-09)
- **Contexto:** a especificação pede TS, lint, typecheck, testes, migrations e CI desde a fase 0, com
  regras de domínio testáveis sem navegador e sem framework.
- **Decisão:** monorepo pnpm (ESM, lockfile versionado). Pacotes: `config`, `authorization`,
  `contracts` (zod), `domain` (regras puras), `database` (migrations SQL + contexto), `api`
  (`handleApi(Request) → Response`, `handleAuth`). `apps/web` (Next.js 16, App Router) só monta a
  API em `app/api/[...path]` e as rotas `/auth/*`; `apps/worker` consome outbox e jobs.
- **Consequências:** testes de API chamam `handleApi` direto contra PostgreSQL real, sem servidor
  HTTP. Trocar Next por outro host exige só um adaptador. O pacote `database/migrate` fica fora do
  índice para não entrar no bundle do Next.
