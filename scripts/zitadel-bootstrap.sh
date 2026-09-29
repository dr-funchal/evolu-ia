#!/usr/bin/env bash
# Bootstrap do Zitadel para o Evolu-IA (roda NA VPS, a partir de /var/www/evolu-ia, com o .env carregado).
# Idempotente: pode rodar de novo. Usa o PAT do usuário de máquina bootstrap-admin (volume zitadel-admin).
#   1. Política de login da instância: sem auto-registro, MFA obrigatório, sem descoberta de domínio.
#   2. Projeto "Evolu-IA" + app OIDC web (code + PKCE, client secret) com redirect para APP_BASE_URL/auth/callback.
#   3. Usuário humano do médico (EVOLU_ADMIN_EMAIL) com senha temporária e troca obrigatória.
# Escreve OIDC_CLIENT_ID/OIDC_CLIENT_SECRET no .env e a senha temporária em /root/evolu-ia-credenciais.txt (0600).
set -euo pipefail
: "${APP_BASE_URL:?}" "${ZITADEL_DOMAIN:?}" "${EVOLU_ADMIN_EMAIL:?defina EVOLU_ADMIN_EMAIL}"
Z="https://${ZITADEL_DOMAIN}"
PAT=$(docker run --rm -v evolu-ia_zitadel-admin:/a:ro alpine cat /a/admin.pat)
api() { # método caminho [json]
  local out code
  out=$(curl -sS -w '\n%{http_code}' -X "$1" "$Z$2" -H "Authorization: Bearer $PAT" -H 'Content-Type: application/json' ${3:+-d "$3"})
  code=${out##*$'\n'}; out=${out%$'\n'*}
  if [[ $code -ge 400 ]]; then echo "ERRO $1 $2 → $code: $out" >&2; return 1; fi
  printf '%s' "$out"
}

echo "1) política de login"
api PUT /admin/v1/policies/login '{
  "allowUsernamePassword": true, "allowRegister": false, "allowExternalIdp": false, "forceMfa": true,
  "forceMfaLocalOnly": false, "passwordlessType": "PASSWORDLESS_TYPE_ALLOWED", "hidePasswordReset": false,
  "ignoreUnknownUsernames": true, "allowDomainDiscovery": false, "disableLoginWithEmail": false, "disableLoginWithPhone": true,
  "passwordCheckLifetime": "864000s", "externalLoginCheckLifetime": "864000s", "mfaInitSkipLifetime": "0s",
  "secondFactorCheckLifetime": "43200s", "multiFactorCheckLifetime": "43200s"
}' >/dev/null || echo "   (sem mudança)"
api GET /admin/v1/policies/login | jq -c '.policy | {allowRegister, forceMfa, mfaInitSkipLifetime, secondFactors, allowDomainDiscovery}'

echo "2) projeto e app OIDC"
PROJECT_ID=$(api POST /management/v1/projects/_search '{"queries":[{"nameQuery":{"name":"Evolu-IA","method":"TEXT_QUERY_METHOD_EQUALS"}}]}' | jq -r '.result[0].id // empty')
if [[ -z $PROJECT_ID ]]; then
  PROJECT_ID=$(api POST /management/v1/projects '{"name":"Evolu-IA","projectRoleAssertion":false}' | jq -r .id)
fi
echo "   projeto $PROJECT_ID"
APP_JSON=$(api POST "/management/v1/projects/$PROJECT_ID/apps/_search" '{}' | jq -c '[.result[]? | select(.name=="evolu-ia-web")][0] // empty')
if [[ -z $APP_JSON ]]; then
  R=$(api POST "/management/v1/projects/$PROJECT_ID/apps/oidc" "$(jq -nc --arg b "$APP_BASE_URL" '{
    name: "evolu-ia-web", redirectUris: [$b + "/auth/callback"], postLogoutRedirectUris: [$b + "/"],
    responseTypes: ["OIDC_RESPONSE_TYPE_CODE"], grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE"],
    appType: "OIDC_APP_TYPE_WEB", authMethodType: "OIDC_AUTH_METHOD_TYPE_BASIC", version: "OIDC_VERSION_1_0",
    devMode: false, accessTokenType: "OIDC_TOKEN_TYPE_BEARER", idTokenUserinfoAssertion: true, idTokenRoleAssertion: false,
    clockSkew: "0s"}')")
  CLIENT_ID=$(jq -r .clientId <<<"$R"); CLIENT_SECRET=$(jq -r .clientSecret <<<"$R")
  sed -i '/^OIDC_CLIENT_ID=/d;/^OIDC_CLIENT_SECRET=/d' .env
  printf 'OIDC_CLIENT_ID=%s\nOIDC_CLIENT_SECRET=%s\n' "$CLIENT_ID" "$CLIENT_SECRET" >> .env
  echo "   app criado; client id/secret gravados no .env"
else
  echo "   app já existe ($(jq -r .oidcConfig.clientId <<<"$APP_JSON")); segredo mantido no .env"
fi

echo "3) usuário do médico"
USER_ID=$(api POST /v2/users '{"queries":[{"emailQuery":{"emailAddress":"'"$EVOLU_ADMIN_EMAIL"'","method":"TEXT_QUERY_METHOD_EQUALS"}}]}' | jq -r '.result[0].userId // empty')
if [[ -z $USER_ID ]]; then
  TMP="Tmp-$(openssl rand -base64 18 | tr -d '/+=')-9a!"
  USER_ID=$(api POST /v2/users/human "$(jq -nc --arg e "$EVOLU_ADMIN_EMAIL" --arg p "$TMP" --arg g "${EVOLU_ADMIN_GIVEN:-Médico}" --arg f "${EVOLU_ADMIN_FAMILY:-Responsável}" '{
    username: $e, profile: {givenName: $g, familyName: $f, preferredLanguage: "pt"},
    email: {email: $e, isVerified: true}, password: {password: $p, changeRequired: true}}')" | jq -r .userId)
  umask 077
  printf 'Evolu-IA — primeiro acesso (%s)\nLogin: %s\nSenha temporária (troca obrigatória + cadastro de 2º fator no 1º acesso): %s\n' \
    "$(date -Iseconds)" "$EVOLU_ADMIN_EMAIL" "$TMP" > /root/evolu-ia-credenciais.txt
  echo "   usuário $USER_ID criado; senha temporária em /root/evolu-ia-credenciais.txt"
else
  echo "   usuário já existe ($USER_ID)"
fi
echo "OIDC_SUBJECT=$USER_ID  (vincular em app.user_identities com issuer $Z)"
