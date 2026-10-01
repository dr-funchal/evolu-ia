# Runbook — testes

```bash
pnpm lint && pnpm typecheck
pnpm test          # Vitest contra PostgreSQL real (recria evolu_test, migra, seed)
pnpm check         # os três
pnpm build         # APP_MODE=test AUTH_PROVIDER=mock para build local
```

Precisa de `TEST_ADMIN_DATABASE_URL` (superusuário, **só** para criar/derrubar `evolu_test`) e
das URLs dos papéis `evolu_owner`/`evolu_app`/`evolu_worker`. Os testes usam `evolu_app` e
`evolu_worker`, sujeitos à RLS.

| Suíte | O que prova |
|---|---|
| `tests/clinical/fluxo-completo.test.ts` | censo → aceite → nota → finalizar (If-Match/idempotência/409) → adendo → tarefa → passagem → worker → exportação |
| `tests/security/isolamento.test.ts` | outro tenant/serviço não vê nada via API, SQL direto, arquivos ou jobs; sem contexto = zero linhas |
| `tests/security/role-matrix.test.ts` | matriz TS == banco; cada persona tem ações permitidas e negadas |
| `tests/security/admin.test.ts` | administração da equipe, convites e plataforma |
| `tests/security/escala.test.ts` | montar ≠ publicar, rascunho invisível, exceções só em ocorrência real, divisão da série, outro tenant |
| `tests/security/modulos.test.ts` | Passagens opcional: padrão desligado, só admin alterna, capacidade some e volta |
| `tests/security/ia.test.ts` | IA por equipe contra OpenRouter falso local: só admin, chave validada/cifrada/nunca devolvida, RLS de config e consumo, filtro de retenção zero, consumo sem conteúdo |
| `tests/security/ia-recursos.test.ts` | Recursos clínicos de IA (ADR 0014) contra o OpenRouter falso de `tests/helpers/fake-openrouter.ts`: ditado/conversa (autorização, formato, só o autor, áudio não guardado), OCR proposto → confirmado com If-Match e imutável no banco, modelo sem visão, tarefas da IA só como proposta (gatilho) e limite de 5, relatório (autor, emissão com `note.finalize`, hash, imutável), resumo só para coordenação e sem nome de paciente enviado |
| `tests/security/evolucao-simples.test.ts` | Evolução simples, contexto e paciente por foto (ADR 0015): contexto com If-Match/409, foto confirmada acrescenta título+data ao contexto, nota nova = schema 2, organizar só propõe (nota intacta, tarefas `proposed`/`ia` para amanhã, sem nome no material), negações sem chamar a IA, foto do paciente não guardada, `ai_no_vision` |

E2E no navegador (manual, não está no CI): Playwright em container contra a demo — login real no
Zitadel com TOTP, troca de persona, nota finalizada. Use sempre um usuário de teste descartável,
criado e apagado pela API do Zitadel.
