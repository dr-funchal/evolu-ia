import pino from "pino";

/**
 * Logger estruturado. Regra (especificação 20.2): nenhum texto clínico em logs.
 * Registre apenas identificadores opacos, códigos e métricas. Campos com nomes sensíveis são
 * removidos por redação como segunda linha de defesa, não como licença para enviá-los.
 */
export const SENSITIVE_LOG_KEYS = [
  "content",
  "body",
  "text",
  "reason",
  "full_name",
  "fullName",
  "name",
  "snapshot",
  "action",
  "description",
  "questions",
  "payload",
  "cookie",
  "authorization",
  "password",
  "token",
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.APP_MODE === "test" ? "silent" : "info"),
  base: { service: process.env.SERVICE_NAME ?? "evolu" },
  redact: {
    paths: SENSITIVE_LOG_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]),
    censor: "[removido]",
  },
});
