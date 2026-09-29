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

## Usuários

Contas são criadas por admin (não há auto-registro). Uma conta nova entra no app **sem nenhum
vínculo**: em modo demo pode operar personas sintéticas; acesso a tenant real só por grant.
