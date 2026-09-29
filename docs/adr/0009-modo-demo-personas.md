# ADR 0009 — Modo demo explícito com personas sintéticas

- **Status:** aceito
- **Decisão:** `APP_MODE ∈ {development, test, demo, production}`. Em `demo`: faixa permanente
  "DEMONSTRAÇÃO — somente dados sintéticos", tenants `is_synthetic`, e uma conta humana
  autenticada (com MFA) vira operador de demo e pode **agir como** persona sintética. A sessão
  guarda o usuário real e o atuante; a auditoria registra os dois. Em `production`: provedores
  mock, troca de persona e seed sintético são recusados na inicialização.
- **Consequências:** a demo mostra o fluxo real (API, RLS, auditoria), não telas com dados fake.
- **Atualização (29/09/2026):** a instância `evolu-ia.pulpfy.com` saiu do modo demo e roda em
  `APP_MODE=production`, com banco zerado (sem tenants, personas ou pacientes sintéticos). O modo
  demo continua disponível para ambientes locais/de avaliação; ver [ADR 0011](0011-administracao-convites-plataforma.md).
