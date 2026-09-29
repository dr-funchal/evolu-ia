import { z } from "zod";

export const APP_MODES = ["development", "test", "demo", "production"] as const;
export type AppMode = (typeof APP_MODES)[number];

const EnvSchema = z.object({
  APP_MODE: z.enum(APP_MODES).default("development"),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  APP_TIMEZONE_DEFAULT: z.string().default("America/Sao_Paulo"),
  DATABASE_URL: z.string().min(1).optional(),
  WORKER_DATABASE_URL: z.string().min(1).optional(),
  MIGRATION_DATABASE_URL: z.string().min(1).optional(),
  AUTH_PROVIDER: z.enum(["oidc", "mock"]).default("oidc"),
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  AUTH_REQUIRE_MFA: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(60),
  STORAGE_DIR: z.string().default("./storage"),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  // none = IA desligada na plataforma; openrouter = cada equipe usa a própria chave (Administração).
  AI_PROVIDER: z.enum(["none", "mock", "openrouter"]).default("none"),
  // Cifra as chaves de API das equipes em repouso (AES-256-GCM). 32 bytes em base64: openssl rand -base64 32
  AI_SECRETS_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "AI_SECRETS_KEY deve ter 32 bytes em base64")
    .optional(),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  // Diretório de identidades (convites). Usuário de máquina com ORG_USER_MANAGER na organização.
  ZITADEL_API_URL: z.string().url().optional(),
  ZITADEL_SERVICE_PAT: z.string().min(20).optional(),
  ZITADEL_ORG_ID: z.string().regex(/^\d{6,30}$/).optional(),
  // link: o admin recebe o link de convite para enviar; email: o Zitadel envia (exige SMTP configurado nele).
  INVITE_DELIVERY: z.enum(["link", "email"]).default("link"),
});

export type Env = z.infer<typeof EnvSchema>;

export class UnsafeConfigurationError extends Error {}

/**
 * Valida o ambiente. Em produção, recusa qualquer provedor simulado ou recurso de demonstração
 * (especificação, seção 23.2: "mocks devem estar explicitamente rotulados e bloqueados em produção").
 */
export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  // Compose repassa variáveis ausentes como "" (${VAR:-}); vazio = não definido.
  const clean = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ""));
  const env = EnvSchema.parse(clean);
  assertSafeForMode(env);
  return env;
}

export function assertSafeForMode(env: Env): void {
  const problems: string[] = [];
  if (env.APP_MODE === "production" || env.APP_MODE === "demo") {
    if (env.AUTH_PROVIDER === "mock") problems.push("AUTH_PROVIDER=mock não é permitido em " + env.APP_MODE);
    if (env.AI_PROVIDER === "mock") problems.push("AI_PROVIDER=mock não é permitido em " + env.APP_MODE);
  }
  if (env.AI_PROVIDER === "openrouter" && !env.AI_SECRETS_KEY) problems.push("AI_PROVIDER=openrouter exige AI_SECRETS_KEY");
  if (env.APP_MODE === "production" && !env.AUTH_REQUIRE_MFA) {
    problems.push("AUTH_REQUIRE_MFA=false não é permitido em production");
  }
  if (problems.length) throw new UnsafeConfigurationError(problems.join("; "));
}

let cached: Env | undefined;
export function env(): Env {
  cached ??= parseEnv();
  return cached;
}

/** Recursos de demonstração (troca de persona, selo DEMO) só existem em demo/development/test. */
export function demoFeaturesEnabled(e: Env = env()): boolean {
  return e.APP_MODE !== "production";
}
