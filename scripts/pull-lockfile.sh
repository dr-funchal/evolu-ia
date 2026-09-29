#!/bin/sh
# Traz o lockfile gerado na VPS para o repositório local.
set -eu
ssh orbita-vps 'cat /var/www/evolu-ia/pnpm-lock.yaml' > "$(dirname "$0")/../pnpm-lock.yaml"
