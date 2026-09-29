import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "./env";

/**
 * Segredos de equipe em repouso (ex.: chave de API do OpenRouter): AES-256-GCM com a chave do
 * servidor (AI_SECRETS_KEY). O banco guarda só o texto cifrado; o navegador nunca recebe o valor.
 * Formato: v1.<iv>.<tag>.<cifra>, em base64url. O tenant entra como dado autenticado, então
 * copiar o texto cifrado para outra equipe não decifra.
 */
function key(): Buffer {
  const k = env().AI_SECRETS_KEY;
  if (!k) throw new Error("AI_SECRETS_KEY não definido");
  return Buffer.from(k, "base64");
}

export function sealSecret(plain: string, tenantId: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  c.setAAD(Buffer.from(tenantId));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv, c.getAuthTag(), ct].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

export function openSecret(sealed: string, tenantId: string): string {
  const [v, iv, tag, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("segredo em formato desconhecido");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAAD(Buffer.from(tenantId));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}
