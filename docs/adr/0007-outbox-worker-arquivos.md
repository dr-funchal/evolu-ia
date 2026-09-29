# ADR 0007 — Outbox, worker e arquivos privados

- **Status:** aceito
- **Decisão:** efeitos colaterais (notificações, exportação de nota) passam por `outbox_events` e
  `jobs` na mesma transação da mudança. O worker (`evolu_worker`, sujeito à RLS) **revalida o
  vínculo do solicitante** antes de executar; se o vínculo caiu, o job falha fechado. Notificações
  carregam só tipo + link interno, nunca conteúdo clínico. Arquivos ficam em `STORAGE_DIR`, fora
  da raiz pública, com caminho derivado de tenant + id e servidos só pela API após autorização.
- **Limitações:** sem antivírus nos uploads; exportação cancelada permanece `queued`.
