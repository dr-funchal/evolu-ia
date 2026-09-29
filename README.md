# Evolu-IA

Visita hospitalar e coordenação de equipes médicas: censo por serviço, evolução estruturada com
finalização imutável, tarefas com responsável e prazo, passagem de plantão (I-PASS) com aceite,
pendências documentais, escala de visita/plantão e visão de coordenação. Multi-tenant (instituição → hospital → serviço).

> **Estado:** em uso (`APP_MODE=production`) em https://evolu-ia.pulpfy.com, com login real
> (Zitadel + MFA), administração de equipes e convites por e-mail. Sem dados de demonstração.
> Não é um sistema certificado e não tem assinatura digital qualificada. Ver **Limitações** abaixo
> antes de registrar dados de pacientes.

Especificação completa: [`docs/ESPECIFICACAO_APP_VISITA_HOSPITALAR_CLAUDE_CODE.md`](docs/ESPECIFICACAO_APP_VISITA_HOSPITALAR_CLAUDE_CODE.md).
Decisões de arquitetura: [`docs/adr/`](docs/adr/). Backlog: [`docs/backlog.md`](docs/backlog.md).

## Estrutura

```
apps/
  web/               Next.js 16: Meu dia, episódio, nota, tarefas, passagens, pendências, coordenação, avisos, auditoria
  worker/            outbox → notificações; jobs (exportação de nota) com revalidação de vínculo
packages/
  config/            env validado (zod), logger com redação, armazenamento privado de arquivos
  authorization/     papéis, capacidades e matriz (espelhada no banco e testada)
  contracts/         esquemas zod da API (entrada/saída)
  domain/            regras puras: nota estruturada, checagem de finalização, datas/timezone
  database/          migrations SQL (RLS), contexto por transação, seed sintético
  api/               API HTTP agnóstica de framework (Request → Response) + autenticação OIDC
infra/nginx/         vhosts evolu-ia.pulpfy.com e auth.pulpfy.com (log sem query string)
docker/postgres/     init: papéis evolu_* e banco/papel próprios do Zitadel
scripts/             sync-vps, zitadel-bootstrap, backup
tests/
  clinical/          fluxo completo censo → nota → finalizar → tarefa → passagem → worker
  security/          isolamento por tenant/serviço (API, SQL, arquivos, jobs) e matriz de papéis
```

## Requisitos

- Node 22.12+ e pnpm 10 (`corepack enable`)
- PostgreSQL 17 (via `docker compose up -d db`, publicado em 127.0.0.1:5442)

## Executar localmente

```bash
cp .env.example .env        # preencha as senhas; AUTH_PROVIDER=mock e APP_MODE=development para dev
docker compose up -d db     # cria os papéis evolu_owner / evolu_app / evolu_worker
pnpm install
pnpm db:migrate             # aplica migrations com o papel dono
pnpm db:seed                # só development/test/demo: 2 tenants, 8 pessoas — tudo sintético
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

## Infraestrutura em uso

Uma VPS com Docker Compose ([ADR 0008](docs/adr/0008-infra-vps-docker.md)): `db` (Postgres 17),
`web` e `worker` (mesma imagem, somente leitura, sem capabilities), `zitadel-api` e
`zitadel-login`. Tudo em 127.0.0.1; nginx + certbot na frente.

| Domínio | Destino |
|---|---|
| `evolu-ia.pulpfy.com` | web (3140) |
| `auth.pulpfy.com` | Zitadel API (8140) e login v2 (3141) |

## Equipes, membros e convites ([ADR 0011](docs/adr/0011-administracao-convites-plataforma.md))

- **Plataforma** (`/plataforma`): operadores (`app.platform_admins`, designados por
  `pnpm db:platform-admin <issuer> <subject> [e-mail] [nome]`) criam equipes (tenants) e
  definem o primeiro administrador: eles mesmos ou outra pessoa convidada por e-mail.
- **Administração** (`/admin`, papel `tenant_admin`): cadastra hospitais e serviços (desativar em
  vez de apagar), convida membros com um ou mais papéis por escopo (equipe inteira, hospital ou
  serviço), gera novo convite, suspende e revoga papéis. Não é possível revogar o último
  administrador nem suspender o próprio vínculo. Administrar **não** dá acesso clínico: para
  atender, o administrador atribui a si mesmo um papel clínico num serviço.
- **Convite**: a API usa um usuário de serviço do Zitadel (`ZITADEL_SERVICE_PAT`,
  `ORG_USER_MANAGER`) para achar ou criar a conta pelo e-mail e gerar o código de convite. O
  vínculo fica preso à identidade (`issuer` + `subject`), nunca só ao e-mail. Com
  `INVITE_DELIVERY=link` (padrão, sem SMTP) o administrador copia o link e envia; com
  `INVITE_DELIVERY=email` o próprio Zitadel envia (exige SMTP configurado no Zitadel). O convidado
  define senha e segundo fator e depois entra em `evolu-ia.pulpfy.com`.

## Escala ([ADR 0012](docs/adr/0012-escala.md))

`/escala`: turnos de **visita, retaguarda ou plantão** por serviço, em séries que se repetem
(diária ou semanal, a cada N semanas, dias escolhidos, até uma data) ou avulsos, no fuso do
hospital. Coordenador, secretária e admin **montam** (rascunho); coordenador e admin **publicam**.
Publicado, todo membro da equipe vê; o escalado recebe aviso. Por turno: trocar profissional ou
cancelar só aquele; por série: editar inteira, alterar "deste turno em diante", encerrar ou
cancelar. Sobreposição da mesma pessoa aparece como conflito. Filtro "só a minha escala".

Sem auto-registro; senha + TOTP/chave de acesso obrigatórios. Backup diário com restauração
testada ([runbook](docs/runbooks/backup-restauracao.md)).

**Limitações** (riscos assumidos no uso com dados reais — LGPD): VPS fora do Brasil
(transferência internacional); backups **sem cifra e sem cópia externa**; uploads sem antivírus;
CSP com `unsafe-inline`; Zitadel no mesmo servidor Postgres; IA/voz/OCR sem provedor. Detalhes e
dependências em [`docs/backlog.md`](docs/backlog.md).
