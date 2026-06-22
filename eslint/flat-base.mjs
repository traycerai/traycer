/**
 * Shared flat-config building blocks for the monorepo. Lives at the repo root
 * so its plugin imports resolve from the root node_modules, which is also where
 * the eslint toolchain devDependencies are declared. Per-workspace
 * `eslint.config.mjs` files import from here instead of depending on the
 * eslint packages individually.
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export { js, tseslint, globals };

// Build output and generated/declaration files that no workspace should lint.
// `.cjs`/`.mjs` are excluded to match the old `--ext .ts[,.tsx]` scope (deploy
// scripts and tool configs like vite/vitest configs were never linted).
export const commonIgnores = [
  "**/node_modules/**",
  "**/dist/**",
  "**/dist-*/**",
  "**/out/**",
  "**/@types/**",
  "**/*.d.ts",
  "**/*.cjs",
  "**/*.mjs",
];

// The eslintrc setup did not report unused eslint-disable directives (the CLI
// flag defaulted off); flat config defaults this to "warn" and `--fix` would
// strip the directives. Keep it off so this upgrade does not change which files
// pass/fail. Re-enabling it + removing dead directives is a good follow-up.
export const linterOptionsConfig = {
  linterOptions: { reportUnusedDisableDirectives: "off" },
};
