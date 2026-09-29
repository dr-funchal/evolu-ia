import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/.next/**", "**/dist/**", "apps/web/next-env.d.ts", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Logs não podem carregar conteúdo clínico: todo log passa pelo logger com redação (packages/config/src/logger.ts).
      "no-console": ["error", { allow: ["error"] }],
    },
  },
  {
    files: ["scripts/**", "packages/database/src/cli.ts", "tests/**"],
    rules: { "no-console": "off" },
  },
  {
    // Testes inspecionam respostas JSON arbitrárias.
    files: ["tests/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
