# ADR 0010 — IA desabilitada; quando existir, só propõe

- **Status:** aceito
- **Decisão:** `AI_PROVIDER=none`. Não há agentes autônomos clínicos. Quando houver provedor (fase 3,
  com contrato e DPA), a IA só gera **propostas** marcadas, que o médico revisa; nada é finalizado,
  prescrito, cobrado ou compartilhado automaticamente. Voz e OCR idem.

**Adendo (29/09/2026):** o provedor passou a existir: OpenRouter, com a chave de cada equipe
(ADR 0013). A regra desta ADR continua valendo sem mudança: a IA só propõe e o médico confirma.
