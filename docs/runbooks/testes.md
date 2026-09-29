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

E2E no navegador (manual, não está no CI): Playwright em container contra a demo — login real no
Zitadel com TOTP, troca de persona, nota finalizada. Use sempre um usuário de teste descartável,
criado e apagado pela API do Zitadel.
