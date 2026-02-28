// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    // Apply to all TypeScript source files
    files: ["src/**/*.ts"],
    rules: {
      // Allow `any` with a warning — reduce count over time via 1.4 type hardening
      "@typescript-eslint/no-explicit-any": "warn",
      // Catch genuinely unused variables (parameters excluded — too noisy)
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Prefer structured logger over bare console — addressed in 1.7
      "no-console": "warn",
      // Avoid unsafe operations that circumvent TypeScript's type system
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      // Require `await` on async calls — catches fire-and-forget bugs
      "@typescript-eslint/no-floating-promises": "off", // enable after 1.4
    },
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Ignore test files and build output
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "**/*.test.ts",
      "vitest.setup.ts",
      "scripts/**",
      "src/index.ts",
    ],
  },
);
