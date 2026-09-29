# ADR 0002 — PostgreSQL 17 com RLS como segunda barreira de isolamento

- **Status:** aceito
- **Contexto:** regra inegociável: "não utilize conexão que contorne RLS nos caminhos de usuário";
  identidade global não concede acesso clínico.
- **Decisão:**
  - Três papéis de login, todos `NOSUPERUSER NOBYPASSRLS`: `evolu_owner` (dono do schema; só
    migrations/seed), `evolu_app` (web) e `evolu_worker` (jobs). `app` e `worker` não são donos de
    tabela, então `FORCE`/ownership não abrem brecha.
  - Toda requisição roda em `withContext`: transação com `set_config(..., true)` do usuário,
    tenant e serviços permitidos; as políticas RLS leem esse contexto. Sem contexto, zero linhas.
  - A API valida escopo antes (404 indistinguível) e a RLS repete a checagem no banco.
  - Funções `security definer` só onde necessário (login, resolução de sessão), com
    `search_path` fixo.
- **Consequências:** testes de segurança atacam também via SQL direto com `evolu_app` sem
  contexto e com contexto de outro tenant. Migrations têm `down` e o CI sobe → desce → sobe.
