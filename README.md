# Evolu-IA

Visita hospitalar e coordenação de equipes médicas: censo por serviço, evolução estruturada com
finalização imutável, tarefas com responsável e prazo, passagem de plantão (I-PASS) com aceite,
pendências documentais e visão de coordenação. Multi-tenant (instituição → hospital → serviço).

> **Estado:** fase 0 + núcleo da fase 1 (API, banco, worker e testes). Interface web em construção.
> A demonstração em `evolu-ia.pulpfy.com` usa **exclusivamente dados sintéticos**. Não é um sistema
> certificado, não tem assinatura digital qualificada e não deve receber dados reais de pacientes.

Especificação completa: [`docs/ESPECIFICACAO_APP_VISITA_HOSPITALAR_CLAUDE_CODE.md`](docs/ESPECIFICACAO_APP_VISITA_HOSPITALAR_CLAUDE_CODE.md).
Decisões de arquitetura: [`docs/adr/`](docs/adr/). Backlog: [`docs/backlog.md`](docs/backlog.md).

## Estrutura

```
apps/
  worker/            outbox → notificações; jobs (exportação de nota) com revalidação de vínculo
packages/
  config/            env validado (zod), logger com redação, armazenamento privado de arquivos
  authorization/     papéis, capacidades e matriz (espelhada no banco e testada)
  contracts/         esquemas zod da API (entrada/saída)
  domain/            regras puras: nota estruturada, checagem de finalização, datas/timezone
  database/          migrations SQL (RLS), contexto por transação, seed sintético
  api/               API HTTP agnóstica de framework (Request → Response) + autenticação OIDC
tests/
  clinical/          fluxo completo censo → nota → finalizar → tarefa → passagem → worker
  security/          isolamento por tenant/serviço (API, SQL, arquivos, jobs) e matriz de papéis
```

## Requisitos

- Node 22.12+ e pnpm 10 (`corepack enable`)
- PostgreSQL 17 (via `docker compose up -d db`)

## Executar localmente

```bash
cp .env.example .env        # preencha as senhas; AUTH_PROVIDER=mock e APP_MODE=development para dev
docker compose up -d db     # cria os papéis evolu_owner / evolu_app / evolu_worker
pnpm install
pnpm db:migrate             # aplica migrations com o papel dono
pnpm db:seed                # 2 tenants, 3 hospitais, 5 serviços, 8 pessoas — tudo sintético
pnpm worker                 # processa outbox e jobs
```

Com `AUTH_PROVIDER=mock` (aceito apenas em `development`/`test`), entre com
`/auth/login?as=bruno` (coordenador multi-vínculo), `ana` (assistente restrita), `carla`
(secretária), `fabio` (financeiro), `gabriela` (admin do tenant), `rafael` (residente), `diana`
(cardiologia), `eduardo` (outro tenant). `&mfa=0` simula login sem segundo fator (deve ser negado).

## Testes

```bash
pnpm test        # recria o banco evolu_test, migra, faz seed e roda tudo contra PostgreSQL real
pnpm check       # lint + typecheck + testes
```

`TEST_ADMIN_DATABASE_URL` precisa apontar para um superusuário **apenas** para criar/derrubar o banco
de teste. Os testes acessam os dados com `evolu_app`/`evolu_worker`, sujeitos à RLS.

## Migrations e restauração

Ver [`docs/runbooks/`](docs/runbooks/): executar, migrar/reverter, backup/restauração e testes.

## Regras que o código garante

- Identidade global não concede acesso clínico: tenant, hospital e serviço são validados no servidor
  e novamente pela RLS do PostgreSQL. Recurso fora do escopo responde 404 indistinguível.
- A aplicação nunca usa conexão que contorne RLS (papéis sem `BYPASSRLS`, sem ownership).
- Nota finalizada é imutável (trigger + versão com hash); correção só por adendo.
  Finalizar exige `If-Match` e `Idempotency-Key`; conflito responde 409.
- Exame físico e subjetivo nunca são copiados de nota anterior; histórico copiado vem marcado e
  bloqueia a finalização até ser reconfirmado.
- Logs, auditoria, outbox e notificações não carregam conteúdo clínico.
- IA não está habilitada; quando houver, só propõe — o médico confirma.
