import { env } from "@evolu/config";
import { ApiError } from "./http";
import { MOCK_ISSUER } from "@evolu/database";

/**
 * Diretório de identidades usado pelos convites. O Evolu-IA não guarda senhas: a conta é criada no
 * IdP (Zitadel), que cuida de senha e MFA. O vínculo local aponta para issuer + subject.
 */
export interface DirectoryAccount {
  issuer: string;
  subject: string;
  /** A conta ainda não definiu credenciais (precisa do convite). */
  pending: boolean;
}

export interface Invite {
  /** Link para o convidado definir senha e MFA; null quando o próprio IdP enviou o e-mail. */
  link: string | null;
  sentByEmail: boolean;
}

export interface Directory {
  ensureAccount(email: string, name: string): Promise<DirectoryAccount>;
  invite(subject: string): Promise<Invite>;
}

const unavailable = () =>
  new ApiError(503, "directory_unavailable", "Cadastro de contas indisponível: o provedor de identidade não está configurado.");

function splitName(name: string): { givenName: string; familyName: string } {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return { givenName: parts[0]!, familyName: "-" };
  return { givenName: parts.slice(0, -1).join(" "), familyName: parts.at(-1)! };
}

class ZitadelDirectory implements Directory {
  constructor(
    private base: string,
    private issuer: string,
    private pat: string,
    private orgId: string,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.pat}`, "content-type": "application/json", accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw unavailable();
    }
    const data = (await res.json().catch(() => ({}))) as T & { code?: number; message?: string };
    if (!res.ok) {
      // Não repassar a mensagem do IdP (pode conter o e-mail); só o status.
      if (res.status === 409) throw new ApiError(409, "account_conflict", "Já existe uma conta com esses dados no provedor de identidade.");
      throw new ApiError(502, "directory_error", `Provedor de identidade recusou a operação (HTTP ${res.status}).`);
    }
    return data;
  }

  async ensureAccount(email: string, name: string): Promise<DirectoryAccount> {
    const found = await this.call<{ result?: { userId: string; state?: string }[] }>("POST", "/v2/users", {
      queries: [{ emailQuery: { emailAddress: email, method: "TEXT_QUERY_METHOD_EQUALS_IGNORE_CASE" } }],
    });
    const existing = found.result?.[0];
    if (existing) {
      // Conta criada por convite fica ACTIVE no IdP mesmo sem cadastro concluído: pendente = sem
      // nenhum método de autenticação (senha, TOTP, chave de acesso).
      if (existing.state === "USER_STATE_INITIAL") return { issuer: this.issuer, subject: existing.userId, pending: true };
      const m = await this.call<{ authMethodTypes?: string[] }>("GET", `/v2/users/${existing.userId}/authentication_methods`);
      return { issuer: this.issuer, subject: existing.userId, pending: !m.authMethodTypes?.length };
    }
    const created = await this.call<{ userId: string }>("POST", "/v2/users/human", {
      organization: { orgId: this.orgId },
      username: email,
      profile: { ...splitName(name), preferredLanguage: "pt" },
      // returnCode: o IdP não dispara e-mail de verificação; o convite verifica o e-mail.
      email: { email, returnCode: {} },
    });
    return { issuer: this.issuer, subject: created.userId, pending: true };
  }

  async invite(subject: string): Promise<Invite> {
    if (!/^\d{6,30}$/.test(subject)) throw new ApiError(422, "invalid_subject", "Conta externa inválida.");
    if (env().INVITE_DELIVERY === "email") {
      await this.call("POST", `/v2/users/${subject}/invite_code`, {
        sendCode: {
          applicationName: "Evolu-IA",
          urlTemplate: `${this.base}/ui/v2/login/verify?userId={{.UserID}}&code={{.Code}}&invite=true`,
        },
      });
      return { link: null, sentByEmail: true };
    }
    const r = await this.call<{ inviteCode?: string }>("POST", `/v2/users/${subject}/invite_code`, { returnCode: {} });
    if (!r.inviteCode) throw new ApiError(502, "directory_error", "Provedor de identidade não devolveu o código de convite.");
    const url = new URL(`${this.base}/ui/v2/login/verify`);
    url.searchParams.set("userId", subject);
    url.searchParams.set("code", r.inviteCode);
    url.searchParams.set("invite", "true");
    return { link: url.toString(), sentByEmail: false };
  }
}

/**
 * Diretório simulado (somente development/test com AUTH_PROVIDER=mock): o subject é a parte local
 * do e-mail, para que o teste entre com /auth/login?as=<subject>.
 */
class MockDirectory implements Directory {
  async ensureAccount(email: string): Promise<DirectoryAccount> {
    const subject = email.split("@")[0]!.toLowerCase().replace(/[^a-z]/g, "").slice(0, 20);
    if (subject.length < 2) throw new ApiError(422, "invalid_email", "E-mail inválido para o provedor simulado.");
    return { issuer: MOCK_ISSUER, subject, pending: true };
  }
  async invite(subject: string): Promise<Invite> {
    return { link: `${env().APP_BASE_URL}/auth/login?as=${subject}`, sentByEmail: false };
  }
}

export function directory(): Directory {
  const e = env();
  if (e.AUTH_PROVIDER === "mock") {
    if (e.APP_MODE !== "development" && e.APP_MODE !== "test") throw unavailable();
    return new MockDirectory();
  }
  if (!e.OIDC_ISSUER || !e.ZITADEL_SERVICE_PAT || !e.ZITADEL_ORG_ID) throw unavailable();
  return new ZitadelDirectory((e.ZITADEL_API_URL ?? e.OIDC_ISSUER).replace(/\/$/, ""), e.OIDC_ISSUER, e.ZITADEL_SERVICE_PAT, e.ZITADEL_ORG_ID);
}
