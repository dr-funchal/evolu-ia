# Runbook — Zitadel (auth.pulpfy.com)

- Containers: `zitadel-api` (127.0.0.1:8140) e `zitadel-login` (login v2, 127.0.0.1:3141).
- Banco `zitadel`, papel `zitadel` no mesmo servidor Postgres (`docker/postgres/10-zitadel.sh`).
- Primeira subida (`start-from-init`) cria a org "PulpFy", um admin humano
  (`ZITADEL_ADMIN_PASSWORD`, troca obrigatória) e o usuário de máquina `bootstrap-admin` com PAT
  em `/zitadel/admin/admin.pat` (volume `evolu-ia_zitadel-admin`).

## Provisionar o Evolu-IA

```bash
cd /var/www/evolu-ia && set -a && . ./.env && set +a
EVOLU_ADMIN_EMAIL=medico@exemplo ./scripts/zitadel-bootstrap.sh
docker compose up -d web   # relê OIDC_CLIENT_ID/SECRET
```

O script (idempotente) aplica a política de login (sem auto-registro, MFA obrigatório), cria o
projeto e o app OIDC, grava o client id/secret no `.env` e cria o usuário humano com senha
temporária em `/root/evolu-ia-credenciais.txt` (0600). **Apague esse arquivo depois do primeiro
acesso.**

## Depois do bootstrap

O `bootstrap-admin` é **desativado** e o arquivo do PAT removido. Para rodar o script de novo:
entrar no console (`https://auth.pulpfy.com/ui/console`) com um admin humano, reativar o usuário
de máquina e gerar um PAT novo com validade curta; desativar de novo ao terminar.

## Admin humano da instância

Login no console com `admin@pulpfy.auth.pulpfy.com` (não só `admin`). Senha e segredo TOTP ficam
em `/root/zitadel-admin-credenciais.txt` (0600, só na VPS). Use apenas para operar o IdP.

## Usuário de serviço (convites)

`evolu-ia-service` (máquina, papel `ORG_USER_MANAGER` na org PulpFy). O PAT fica no `.env` como
`ZITADEL_SERVICE_PAT` (com `ZITADEL_ORG_ID`) e **expira em 2027-09-29** — gerar outro no console
antes disso (Usuários → Contas de serviço → evolu-ia-service → Tokens), atualizar o `.env` e
`docker compose up -d web`. A API usa o PAT para: buscar conta por e-mail, criar conta humana sem
senha, listar métodos de autenticação (conta pendente = nenhum) e gerar código de convite.

## Envio de convites por e-mail (SMTP)

Sem SMTP o admin copia o link de convite na tela de Administração (`INVITE_DELIVERY=link`). Para
o Zitadel enviar sozinho: no console, Configurações da instância → Provedor SMTP (ex.: Gmail com
senha de app, ou um provedor transacional com domínio `pulpfy.com` e SPF/DKIM), ativar, testar;
depois `INVITE_DELIVERY=email` no `.env` e `docker compose up -d web`.

## Usuários

Não há auto-registro: contas nascem de convite (tela de Administração) ou do console. Uma conta
sem vínculo entra no app vendo "Sem vínculo ativo"; operadores da plataforma veem a tela de
criação de equipe. Designar operador: `pnpm db:platform-admin https://auth.pulpfy.com <userId-zitadel> [e-mail] [nome]`.
