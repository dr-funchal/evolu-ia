#!/usr/bin/env bash
# Backup do Evolu-IA na VPS: banco da aplicação, banco do Zitadel e arquivos privados.
# Uso (na VPS, em /var/www/evolu-ia):  ./scripts/backup.sh [diretório]   (padrão /var/backups/evolu-ia)
# Retenção: BACKUP_KEEP_DAYS (padrão 14). Arquivos 0600, diretório 0700.
# ATENÇÃO: hoje só há dados sintéticos. Antes de qualquer dado real, os backups precisam ser
# cifrados (age/gpg) e copiados para fora da VPS — ver docs/runbooks/backup-restauracao.md.
set -euo pipefail
cd "$(dirname "$0")/.."
DEST=${1:-/var/backups/evolu-ia}
KEEP=${BACKUP_KEEP_DAYS:-14}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
umask 077
mkdir -p "$DEST"; chmod 700 "$DEST"

for db in evolu zitadel; do
  docker compose exec -T db pg_dump -U postgres -d "$db" -Fc > "$DEST/$db-$STAMP.dump.tmp"
  mv "$DEST/$db-$STAMP.dump.tmp" "$DEST/$db-$STAMP.dump"
done
# Papéis globais (sem senhas: --no-role-passwords); as senhas vivem no .env.
docker compose exec -T db pg_dumpall -U postgres --roles-only --no-role-passwords > "$DEST/roles-$STAMP.sql"
docker run --rm -v evolu-ia_storage:/s:ro alpine tar -C /s -czf - . > "$DEST/storage-$STAMP.tar.gz"

( cd "$DEST" && sha256sum ./*-"$STAMP".* > "SHA256SUMS-$STAMP" )
find "$DEST" -maxdepth 1 -type f -mtime +"$KEEP" -delete
echo "backup ok: $DEST (*-$STAMP)"
