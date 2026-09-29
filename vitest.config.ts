import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Localmente lemos .env; no CI as variáveis vêm do workflow.
if (existsSync(".env")) process.loadEnvFile(".env");

/** Mesmo servidor, banco separado `evolu_test` (recriado a cada execução pelo global-setup). */
const toTest = (url: string | undefined) => url?.replace(/\/[^/?]+(\?|$)/, "/evolu_test$1");

process.env.EVOLU_TEST_MIGRATION_URL = toTest(process.env.MIGRATION_DATABASE_URL) ?? "";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    globalSetup: ["tests/helpers/global-setup.ts"],
    // Os testes compartilham um banco real (PostgreSQL com RLS); rodar arquivos em série evita
    // interferência entre cenários que alteram vínculos e estados.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      APP_MODE: "test",
      APP_BASE_URL: "http://localhost:3000",
      AUTH_PROVIDER: "mock",
      AUTH_REQUIRE_MFA: "true",
      // IA contra um OpenRouter falso local (tests/security/ia.test.ts); nunca a API real.
      AI_PROVIDER: "openrouter",
      AI_SECRETS_KEY: Buffer.alloc(32, 7).toString("base64"),
      OPENROUTER_BASE_URL: "http://127.0.0.1:18765/api/v1",
      LOG_LEVEL: "silent",
      DATABASE_URL: toTest(process.env.DATABASE_URL) ?? "",
      WORKER_DATABASE_URL: toTest(process.env.WORKER_DATABASE_URL) ?? "",
      MIGRATION_DATABASE_URL: toTest(process.env.MIGRATION_DATABASE_URL) ?? "",
      TEST_ADMIN_DATABASE_URL: process.env.TEST_ADMIN_DATABASE_URL ?? "",
      STORAGE_DIR: mkdtempSync(path.join(tmpdir(), "evolu-test-storage-")),
    },
  },
});
