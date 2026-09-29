import { createHash, randomBytes } from "node:crypto";
import { env } from "@evolu/config";
import type { Sql } from "@evolu/database";
import { ApiError } from "./http";

export interface Session {
  sessionId: string;
  tokenHash: string;
  /** Usuário autenticado (identidade real). */
  realUserId: string;
  realDisplayName: string;
  /** Usuário efetivo: persona sintética (somente fora de production) ou o próprio usuário. */
  userId: string;
  displayName: string;
  isDemoOperator: boolean;
  personaActive: boolean;
  mfa: boolean;
  expiresAt: Date;
}

export function cookieName(): string {
  return env().APP_BASE_URL.startsWith("https://") ? "__Host-evolu_session" : "evolu_session";
}

export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  const secure = env().APP_BASE_URL.startsWith("https://");
  return [
    `${cookieName()}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearSessionCookie(): string {
  return sessionCookie("", 0);
}

export async function resolveSession(sql: Sql, req: Request): Promise<Session | null> {
  const token = readCookie(req, cookieName());
  if (!token || token.length < 20 || token.length > 200) return null;
  const tokenHash = hashToken(token);
  const rows = await sql<
    {
      session_id: string;
      user_id: string;
      acting_user_id: string | null;
      display_name: string;
      acting_display_name: string | null;
      is_demo_operator: boolean;
      mfa: boolean;
      expires_at: Date;
    }[]
  >`select * from app.auth_resolve_session(${tokenHash}, ${env().SESSION_IDLE_MINUTES})`;
  const r = rows[0];
  if (!r) return null;
  const personaAllowed = env().APP_MODE !== "production" && r.is_demo_operator && r.acting_user_id;
  return {
    sessionId: r.session_id,
    tokenHash,
    realUserId: r.user_id,
    realDisplayName: r.display_name,
    userId: personaAllowed ? r.acting_user_id! : r.user_id,
    displayName: personaAllowed ? (r.acting_display_name ?? r.display_name) : r.display_name,
    isDemoOperator: r.is_demo_operator,
    personaActive: Boolean(personaAllowed),
    mfa: r.mfa,
    expiresAt: r.expires_at,
  };
}

export function requireMfa(s: Session) {
  if (env().AUTH_REQUIRE_MFA && !s.mfa) {
    throw new ApiError(401, "mfa_required", "Autenticação em dois fatores é obrigatória. Entre novamente usando MFA.");
  }
}

export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  email?: string | null;
  name?: string | null;
  amr: string[];
}

const SECOND_FACTORS = new Set(["mfa", "otp", "totp", "u2f", "hwk", "swk", "webauthn", "fido", "sms", "user"]);
export function amrHasSecondFactor(amr: string[]): boolean {
  return amr.some((a) => SECOND_FACTORS.has(a));
}

/** Cria a sessão local depois que o IdP (ou o mock de dev/test) verificou a identidade. */
export async function createSession(
  sql: Sql,
  id: VerifiedIdentity,
  opts: { demoOperator?: boolean } = {},
): Promise<{ token: string; cookie: string; userId: string }> {
  const token = randomBytes(32).toString("base64url");
  const ttl = env().SESSION_TTL_HOURS * 3600;
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const mfa = amrHasSecondFactor(id.amr);
  const [row] = await sql<{ user_id: string }[]>`
    select app.auth_login(${id.issuer}, ${id.subject}, ${id.email ?? null}, ${id.name ?? null},
                          ${hashToken(token)}, ${expiresAt}, ${id.amr}, ${mfa}) as user_id`;
  const userId = row!.user_id;
  if (env().APP_MODE !== "production" && (opts.demoOperator ?? true)) {
    // Fora de produção, contas humanas autenticadas podem operar personas sintéticas (nunca dados reais).
    await sql`select app.auth_mark_demo_operator(${userId})`;
  }
  return { token, cookie: sessionCookie(token, ttl), userId };
}
