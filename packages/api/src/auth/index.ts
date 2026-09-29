import * as oidc from "openid-client";
import { env, logger } from "@evolu/config";
import { appSql } from "../context";
import { MOCK_ISSUER } from "@evolu/database";
import { clearSessionCookie, cookieName, createSession, hashToken, readCookie } from "../session";

/**
 * Autenticação delegada a um IdP OIDC (Zitadel). Não há senhas neste sistema. O IdP entrega a
 * identidade (issuer + subject) e o `amr`; a sessão local guarda só o hash do token opaco.
 * Identidade global NÃO concede acesso: os vínculos (tenant/hospital/serviço) vêm do banco.
 */
let configPromise: Promise<oidc.Configuration> | undefined;
function oidcConfig(): Promise<oidc.Configuration> {
  const e = env();
  if (!e.OIDC_ISSUER || !e.OIDC_CLIENT_ID) throw new Error("oidc_not_configured");
  configPromise ??= oidc
    .discovery(new URL(e.OIDC_ISSUER), e.OIDC_CLIENT_ID, e.OIDC_CLIENT_SECRET || undefined)
    .catch((err: unknown) => {
      configPromise = undefined;
      throw err;
    });
  return configPromise;
}

const secure = () => env().APP_BASE_URL.startsWith("https://");
const flowCookieName = () => (secure() ? "__Host-evolu_oidc" : "evolu_oidc");
function flowCookie(value: string, maxAge: number) {
  return [`${flowCookieName()}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`, ...(secure() ? ["Secure"] : [])].join("; ");
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 303, headers });
}

/** Aceita apenas caminhos relativos internos para evitar open redirect. */
function safeReturnTo(v: string | null): string {
  return v && /^\/(?!\/)[A-Za-z0-9/_\-?=&.%]*$/.test(v) ? v : "/";
}

function errorPage(status: number, message: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Evolu-IA</title><body style="font-family:system-ui;padding:2rem">` +
      `<h1>Não foi possível entrar</h1><p>${message}</p><p><a href="/">Voltar</a></p></body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

const MOCK_ALLOWED = () => env().AUTH_PROVIDER === "mock" && (env().APP_MODE === "development" || env().APP_MODE === "test");

export async function handleAuth(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const base = env().APP_BASE_URL;
  try {
    if (path === "/auth/login") {
      const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
      if (env().AUTH_PROVIDER === "mock") {
        // Provedor simulado: só dev/test, só identidades sintéticas pré-cadastradas (seed).
        if (!MOCK_ALLOWED()) return errorPage(403, "Provedor simulado desabilitado neste ambiente.");
        const as = url.searchParams.get("as") ?? "";
        if (!/^[a-z]{2,20}$/.test(as)) return errorPage(400, "Persona inválida.");
        const mfa = url.searchParams.get("mfa") !== "0";
        const s = await createSession(
          appSql(),
          { issuer: MOCK_ISSUER, subject: as, name: null, email: null, amr: mfa ? ["pwd", "otp"] : ["pwd"] },
          { demoOperator: false },
        );
        return redirect(new URL(returnTo, base).toString(), [s.cookie]);
      }
      const config = await oidcConfig();
      const verifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const authUrl = oidc.buildAuthorizationUrl(config, {
        redirect_uri: `${base}/auth/callback`,
        scope: "openid profile email",
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
        state,
        nonce,
      });
      const flow = Buffer.from(JSON.stringify({ verifier, state, nonce, returnTo })).toString("base64url");
      return redirect(authUrl.href, [flowCookie(flow, 600)]);
    }

    if (path === "/auth/callback") {
      const raw = readCookie(req, flowCookieName());
      if (!raw) return errorPage(400, "Sessão de login expirada. Tente novamente.");
      const flow = JSON.parse(Buffer.from(raw, "base64url").toString()) as { verifier: string; state: string; nonce: string; returnTo: string };
      const config = await oidcConfig();
      // O IdP redireciona para APP_BASE_URL; reconstruímos a URL pública (atrás do proxy).
      const current = new URL(`${base}/auth/callback${url.search}`);
      const tokens = await oidc.authorizationCodeGrant(config, current, {
        pkceCodeVerifier: flow.verifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims) return errorPage(400, "Resposta do provedor sem identidade.");
      const amr = Array.isArray(claims.amr) ? claims.amr.map(String) : [];
      const s = await createSession(appSql(), {
        issuer: claims.iss,
        subject: claims.sub,
        email: typeof claims.email === "string" && claims.email_verified === true ? claims.email : null,
        name: typeof claims.name === "string" ? claims.name : null,
        amr,
      });
      const idHint = tokens.id_token ? [idTokenCookie(tokens.id_token)] : [];
      return redirect(new URL(flow.returnTo, base).toString(), [s.cookie, flowCookie("", 0), ...idHint]);
    }

    if (path === "/auth/logout") {
      if (req.method !== "POST") return new Response(null, { status: 405 });
      const origin = req.headers.get("origin");
      if (origin && origin !== new URL(base).origin) return new Response(null, { status: 403 });
      const token = readCookie(req, cookieName());
      if (token) {
        await appSql()`select app.auth_logout(${hashToken(token)})`;
      }
      let location = `${base}/`;
      if (env().AUTH_PROVIDER === "oidc" && env().OIDC_ISSUER) {
        try {
          const config = await oidcConfig();
          const hint = readCookie(req, idTokenCookieName());
          location = oidc.buildEndSessionUrl(config, {
            post_logout_redirect_uri: `${base}/`,
            ...(hint ? { id_token_hint: hint } : {}),
          }).href;
        } catch {
          // Sem end_session no IdP: basta encerrar a sessão local.
        }
      }
      return redirect(location, [clearSessionCookie(), idTokenCookie("", 0)]);
    }
    return new Response("Not found", { status: 404 });
  } catch (err) {
    const e = err as { name?: string; code?: string; error?: string };
    logger.warn({ errName: e?.name, errCode: e?.code ?? e?.error }, "auth_error");
    return errorPage(400, "Falha na autenticação. Tente novamente.");
  }
}

const idTokenCookieName = () => (secure() ? "__Host-evolu_idt" : "evolu_idt");
function idTokenCookie(v: string, maxAge = env().SESSION_TTL_HOURS * 3600) {
  return [`${idTokenCookieName()}=${v}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`, ...(secure() ? ["Secure"] : [])].join("; ");
}

