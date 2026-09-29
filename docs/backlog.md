# Backlog — Evolu-IA

Status: ✅ feito e testado · 🟡 parcial · ⬜ não iniciado. "Teste" aponta onde o critério é verificado.

## Fase 0 — Fundação

| ID | Item | Critérios de aceite | Status | Teste |
|---|---|---|---|---|
| F0-01 | Toolchain | TS estrito, ESLint, typecheck, Vitest, lockfile, CI (lint → typecheck → testes → migrations up/down/up → build) | ✅ | `.github/workflows/ci.yml` |
| F0-02 | ADRs | Decisões de stack, RLS, identidade, autorização, nota, infra, demo e IA registradas | ✅ | `docs/adr/` |
| F0-03 | Banco com RLS | Papéis sem BYPASSRLS; toda tabela `app.*` com RLS; sem contexto → zero linhas | ✅ | `tests/security/isolamento.test.ts` |
| F0-04 | Migrations reversíveis | Cada migration tem `down`; CI sobe, desce tudo e sobe de novo | ✅ | CI |
| F0-05 | OIDC + MFA | Code + PKCE; sessão sem `amr` de 2º fator → 401 `mfa_required`; sem senha própria | ✅ | testes de auth + E2E real em auth.pulpfy.com |
| F0-06 | Provedores mock bloqueados | `AUTH_PROVIDER=mock`/`AI_PROVIDER=mock` recusados em demo/production | ✅ | `packages/config` |
| F0-07 | Tenants/serviços sintéticos | 2 tenants, 3 hospitais, 5 serviços, 8 personas, flag `is_synthetic` | ✅ | seed + testes; só local/test — produção sem dados sintéticos desde 29/09 |
| F0-08 | Matriz de papéis | Matriz TS == `app.role_capabilities`; cada persona tem permitidos e negados | ✅ | `tests/security/role-matrix.test.ts` |
| F0-09 | Auditoria | allow/deny/error com ator real e atuante, sem conteúdo clínico | ✅ | fluxo + isolamento |
| F0-10 | Deploy demo | HTTPS, portas em loopback, containers endurecidos, faixa DEMO, login obrigatório | ✅ | evolu-ia.pulpfy.com; desde 29/09 em `APP_MODE=production` |
| F0-11 | Backup/restauração | Dump diário app + zitadel + arquivos; restauração testada | 🟡 | sem cifra nem cópia externa |
| F0-12 | Runbooks | Executar, migrar, backup/restauração, testes, Zitadel | ✅ | `docs/runbooks/` |

## Fase 1 — Núcleo clínico e continuidade

| ID | Item | Critérios de aceite | Status | Teste |
|---|---|---|---|---|
| F1-01 | Censo por serviço | Lista do dia no timezone do serviço; filtros meus/pendentes; secretária sem clínico | ✅ | fluxo + E2E |
| F1-02 | Admissão no serviço | Paciente + internação + episódio no serviço + leito; um episódio aberto por internação e serviço (índice único) | ✅ | fluxo |
| F1-03 | Rascunho estruturado | Versão otimista; subjetivo/exame nunca copiados; cópia marcada bloqueia finalizar | ✅ | fluxo + `domain` |
| F1-04 | Finalização imutável | `If-Match` + `Idempotency-Key`; 409 em conflito; SHA-256; trigger impede alteração | ✅ | fluxo |
| F1-05 | Adendo | Só em nota final, autor identificado, sem alterar original | ✅ | fluxo |
| F1-06 | Tarefas | Ação, critério, contingência, responsável, prazo IANA, histórico, atrasadas | ✅ | fluxo |
| F1-07 | Passagem I-PASS | Snapshot congelado, tarefas transferidas, aceite/dúvidas do receptor | ✅ | fluxo + UI |
| F1-08 | Pendências documentais | Pacientes ativos sem nota final no dia do serviço | ✅ | fluxo |
| F1-09 | Coordenação | Atrasos, sem nota, sem responsável, passagens abertas, rascunhos antigos | ✅ | UI |
| F1-10 | Notificações | Via outbox/worker; só tipo + link interno | ✅ | fluxo |
| F1-11 | Exportação de nota | Job revalida vínculo; arquivo privado; download autorizado | 🟡 | cancelada fica `queued` |
| F1-12 | Isolamento | API, SQL, arquivos e jobs entre tenants/serviços → 404/zero linhas | ✅ | `tests/security/` |
| F1-13 | Responsividade | Uso em celular à beira-leito | 🟡 | cabeçalho quebra em telas estreitas |
| F1-14 | Administração de vínculos na UI | Plataforma cria equipes; admin cadastra hospitais/serviços, convida por e-mail (Zitadel), concede/revoga papéis por escopo | ✅ | ADR 0011; validade de grant ainda só por SQL |

## Próximas fases (resumo)

| ID | Item | Dependência |
|---|---|---|
| F2-01 | Escala, plantões e financeiro (centavos, regras versionadas, competência fechada imutável) — **escala feita (ADR 0012)**; financeiro pendente | F1-14 |
| F2-02 | Protocolos clínicos (rascunho até aprovação médica) | revisão médica |
| F3-01 | IA/voz/OCR como proposta revisável | contrato + DPA com provedor, hospedagem de dados |
| P-01 | Pré-produção com dado real | **Em uso real desde 29/09 com riscos assumidos pelo responsável.** Pendentes: hospedagem no Brasil ou base legal para transferência, backups cifrados/externos, antivírus, CSP sem `unsafe-inline`, Zitadel em banco separado, DPIA/RIPD |
