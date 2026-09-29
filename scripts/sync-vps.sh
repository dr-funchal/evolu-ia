#!/bin/sh
# Copia o código do ambiente de edição para a VPS (sem node_modules, .env, storage).
# O pnpm-lock.yaml é gerado na VPS (o ambiente de edição não tem node): nunca é apagado pelo --delete;
# use scripts/pull-lockfile.sh para trazê-lo de volta antes de commitar.
set -eu
rsync -az --no-owner --no-group --delete \
  --exclude node_modules --exclude .next --exclude .env --exclude storage --exclude backups --exclude .git \
  --exclude .pnpm-store --exclude coverage --exclude pnpm-lock.yaml \
  "$(dirname "$0")/../" orbita-vps:/var/www/evolu-ia/
