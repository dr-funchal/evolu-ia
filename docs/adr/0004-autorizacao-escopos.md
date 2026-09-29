# ADR 0004 — Autorização por papel com escopo (tenant → hospital → serviço)

- **Status:** aceito
- **Decisão:** papéis (assistente, coordenador, residente, secretária, financeiro, admin do
  tenant, ...) mapeiam para capacidades (`clinical.read`, `clinical.write`, `note.finalize`,
  `handoff.participate`, `coordination.view`, `audit.read`, ...). A matriz existe em
  `packages/authorization` e em `app.role_capabilities`; um teste garante que as duas são iguais.
  Grants têm escopo de tenant, hospital ou serviço e validade. A UI só esconde; quem decide é o
  servidor. Negações são auditadas (`outcome = deny`) sem conteúdo clínico.
- **Consequências:** secretária vê censo e pendências, mas não conteúdo clínico; financeiro não vê
  nada clínico; admin do tenant administra, mas não lê clínico por padrão.
