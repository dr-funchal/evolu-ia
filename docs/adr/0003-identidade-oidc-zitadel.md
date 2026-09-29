# ADR 0003 — Identidade: Zitadel auto-hospedado (OIDC + MFA), sessão no servidor

- **Status:** aceito
- **Contexto:** "Não escreva seu próprio sistema de senhas." MFA obrigatório. Decisão do usuário:
  tudo na VPS, sem Supabase.
- **Decisão:**
  - Zitadel v4 (API + login v2) em `auth.pulpfy.com`. Política da instância: sem auto-registro,
    `forceMfa`, sem descoberta de domínio, `ignoreUnknownUsernames`.
  - App OIDC web: authorization code + PKCE (S256) + client secret (BASIC), `state` e `nonce`.
  - O app lê `amr` do id_token; sessão só vale como MFA se `amr` contém segundo fator
    (`otp`, `u2f`, `mfa`, ...). `AUTH_REQUIRE_MFA=true` → 401 `mfa_required` sem MFA.
  - Sessão local: token aleatório em cookie `HttpOnly; Secure; SameSite=Lax`, só o hash no banco,
    expiração absoluta e por inatividade.
  - `app.auth_login` cria o usuário no primeiro login (JIT) **sem nenhum vínculo**: acesso clínico
    vem só de `role_grants` concedidos por admin do tenant.
  - `AUTH_PROVIDER=mock` só em `development`/`test`; `demo` e `production` recusam na inicialização.
- **Consequências:** provisionamento reproduzível por `scripts/zitadel-bootstrap.sh`. O usuário
  de máquina de bootstrap é desativado depois do uso.
