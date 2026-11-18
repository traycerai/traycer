import {
  tseslint,
  globals,
  commonIgnores,
  linterOptionsConfig,
} from "../../eslint/flat-base.mjs";
import { traycerTypeSafetyRestrictions } from "../../eslint/traycer-type-safety-rules.mjs";
import { traycerClientsImportBoundaryRestrictions } from "../../eslint/traycer-clients-import-boundary-rules.mjs";

export default tseslint.config(
  {
    ignores: [
      ...commonIgnores,
      "release/**",
      "resources/**",
      "scripts/**",
      "vitest.config.ts",
      "vite.renderer.config.ts",
    ],
  },
  linterOptionsConfig,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.es2021 },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "no-restricted-syntax": ["error", ...traycerTypeSafetyRestrictions],
      "@typescript-eslint/no-restricted-imports": [
        "error",
        traycerClientsImportBoundaryRestrictions,
      ],
    },
  },
);
