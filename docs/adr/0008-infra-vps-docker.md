# ADR 0008 — Infraestrutura: uma VPS, Docker Compose, nginx

- **Status:** aceito para a **demonstração sintética**; reavaliar antes de dado real.
- **Decisão:**
  - Compose com `db` (postgres:17 alpine), `web` e `worker` (mesma imagem, `read_only`,
    `cap_drop: ALL`, `no-new-privileges`), `zitadel-api` e `zitadel-login`. Todas as portas só em
    127.0.0.1 (db 5442, web 3140, zitadel 8140/3141); nginx termina TLS (certbot).
  - O Zitadel **compartilha o servidor PostgreSQL**, mas com banco `zitadel` e papel `zitadel`
    próprios (sem superuser, sem BYPASSRLS, `revoke all from public`). Economiza recursos na
    demo; em produção deve ter instância separada.
  - Log de acesso do nginx sem query string (`combined_noquery`); logs da app com redação.
  - Backup diário (`scripts/backup.sh`, cron 06:30 UTC): dumps dos dois bancos, papéis sem senha
    e arquivos, com retenção de 14 dias, permissão 0600 e checksums.
- **Riscos conhecidos:** a VPS fica nos EUA (transferência internacional — LGPD art. 33); backups
  não são cifrados nem externos; CSP usa `unsafe-inline`. Tudo aceitável só com dados sintéticos.
