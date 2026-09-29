# AGENTS.md — instruções para agentes de código neste repositório

Leia antes: `docs/ESPECIFICACAO_APP_VISITA_HOSPITALAR_CLAUDE_CODE.md`, `docs/adr/`, `docs/backlog.md`.

## Regras inegociáveis
- Identidade global não concede acesso clínico. Tenant/hospital/serviço são validados no servidor
  **e** pela RLS. Recurso fora de escopo → 404 indistinguível.
- Nunca usar conexão que contorne RLS em caminho de usuário (nada de `evolu_owner`/`postgres` na
  API ou no worker; nada de `BYPASSRLS`).
- Não preencher informação clínica ausente nem copiar exame físico/subjetivo antigo como atual.
- IA só propõe; médico confirma. Nada de finalizar, prescrever, pagar ou compartilhar
  automaticamente. Não criar agentes autônomos clínicos.
- Dados clínicos não entram em logs, analytics, notificações, mensagens de commit ou fixtures
  públicas. Fixtures só sintéticas e marcadas.
- Dinheiro em centavos; regras versionadas; competência fechada não é reescrita.
- Interface pt-BR; timezone IANA do serviço; timestamps em `timestamptz`.
- Não afirmar conformidade legal, assinatura qualificada ou certificação.
- Não escrever sistema de senhas (identidade é do Zitadel). Mock de auth só em development/test.
- Não fazer deploy público com dados reais.

## Como trabalhar
- Toda mudança de dado: migration nova (`up` + `down`), RLS e grants mínimos, teste de isolamento.
- Toda rota nova: checar capacidade no servidor, auditar negação, validar entrada com `contracts`.
- Mutação concorrente: `If-Match` (versão) e `Idempotency-Key` quando repetir for perigoso.
- Rode `pnpm check` antes de commitar. Runbooks em `docs/runbooks/`.
- Ao fim de cada fatia, informe: arquivos alterados, comportamento disponível, testes executados,
  limitações e próxima dependência.
