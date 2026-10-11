import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import { defineConfig } from "eslint/config";
import svelte from "eslint-plugin-svelte";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: [
      ".claude/**",
      "**/node_modules/**",
      "**/dist/**",
      "apps/web/build/**",
      "**/.svelte-kit/**",
      "**/.wrangler/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
    ],
  },
  js.configs.recommended,
  {
    // Type-aware linting for all TypeScript sources inside workspaces.
    files: ["{apps,packages,tools}/**/*.ts"],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": "allow-with-description", minimumDescriptionLength: 10 },
      ],
    },
  },
  {
    // Svelte components: type-aware via the TS parser inside <script lang="ts">.
    files: ["apps/**/*.svelte"],
    extends: [
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      svelte.configs.recommended,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        extraFileExtensions: [".svelte"],
        parser: tseslint.parser,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Boundary enforcement that dependency-cruiser cannot express: runtime
    // imports of @clavis/core from audio and notation are forbidden, type-only
    // imports are allowed. (dependency-cruiser enforces the same rule too.)
    files: ["packages/audio/**/*.ts", "packages/notation/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@clavis/core", "@clavis/core/*"],
              allowTypeImports: true,
              message: "audio and notation may only use `import type` from @clavis/core.",
            },
          ],
        },
      ],
    },
  },
  {
    // Plain JS/CJS config files at the repo root: not type-checked.
    files: ["*.js", "*.cjs", "*.mjs", "apps/*/*.js", "apps/*/scripts/*.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    // Core is pure: no ambient time or randomness.
    files: ["packages/core/src/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "Math",
          property: "random",
          message: "Use the injected seeded RNG in core.",
        },
        {
          object: "Date",
          property: "now",
          message: "Use the injected clock in core.",
        },
      ],
    },
  },
  prettier,
);
