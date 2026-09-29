# ADR 0005 — Evolução estruturada, finalização imutável e adendos

- **Status:** aceito
- **Decisão:**
  - Rascunho estruturado (subjetivo, exame, dados, avaliação por problema, plano) com versão
    otimista (`If-Match`). Finalizar exige `If-Match` + `Idempotency-Key`; conflito → 409.
  - Na finalização grava-se `note_versions` com conteúdo canônico e SHA-256; trigger impede
    UPDATE/DELETE de nota final. Correção só por adendo.
  - "Não preencher informação clínica ausente nem copiar exame físico antigo como atual": nova
    nota nunca copia subjetivo/exame; o que vier de nota anterior entra marcado como copiado e
    bloqueia a finalização até ser reconfirmado.
  - A UI diz explicitamente: hash de integridade **não é** assinatura digital qualificada
    (ICP-Brasil).
