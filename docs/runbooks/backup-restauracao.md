# Runbook — backup e restauração

## Backup

`scripts/backup.sh` (cron `/etc/cron.d/evolu-ia-backup`, diário 06:30 UTC, log em
`/var/log/evolu-ia-backup.log`) grava em `/var/backups/evolu-ia/` (0700, arquivos 0600):

| Arquivo | Conteúdo |
|---|---|
| `evolu-<UTC>.dump` | banco da aplicação (`pg_dump -Fc`) |
| `zitadel-<UTC>.dump` | banco do Zitadel (usuários, MFA, apps OIDC) |
| `roles-<UTC>.sql` | papéis globais **sem senhas** |
| `storage-<UTC>.tar.gz` | volume de arquivos privados |
| `SHA256SUMS-<UTC>` | checksums |

Retenção: `BACKUP_KEEP_DAYS` (padrão 14). Também é preciso guardar **fora da VPS** o `.env`
(senhas, `ZITADEL_MASTERKEY` — sem ela o dump do Zitadel é inútil — e `AI_SECRETS_KEY` — sem ela
as chaves do OpenRouter das equipes não abrem e precisam ser recadastradas).

> ⚠️ Pendente antes de dado real: cifrar (age/gpg) e copiar para outro local/provedor.

## Restauração testada (ensaio sem tocar produção)

```bash
cd /var/www/evolu-ia
D=$(ls -t /var/backups/evolu-ia/evolu-*.dump | head -1)
sha256sum -c /var/backups/evolu-ia/SHA256SUMS-<UTC>
docker compose exec -T db psql -U postgres -c "create database evolu_restore_test owner evolu_owner"
docker compose exec -T db pg_restore -U postgres -d evolu_restore_test --exit-on-error < "$D"
docker compose exec -T db psql -U postgres -d evolu_restore_test -c \
  "select count(*) filter (where not rowsecurity) as tabelas_sem_rls from pg_tables where schemaname='app'"  # deve ser 0
docker compose exec -T db psql -U postgres -c "drop database evolu_restore_test"
```

Último ensaio: 2026-09-29 — restauração ok, contagens iguais à origem, 0 tabelas sem RLS.

## Restauração real

```bash
docker compose stop web worker
docker compose exec -T db psql -U postgres -c "drop database evolu" -c "create database evolu owner evolu_owner"
docker compose exec -T db pg_restore -U postgres -d evolu --exit-on-error < /var/backups/evolu-ia/evolu-<UTC>.dump
docker run --rm -i -v evolu-ia_storage:/s alpine sh -c "rm -rf /s/* && tar -C /s -xzf -" < /var/backups/evolu-ia/storage-<UTC>.tar.gz
docker compose start web worker
```

Zitadel: mesmo procedimento com `zitadel` (parar `zitadel-api`/`zitadel-login` antes), usando a
mesma `ZITADEL_MASTERKEY`. Depois da restauração, sessões antigas continuam válidas até expirar;
para invalidar todas: `delete from app.sessions;`.
