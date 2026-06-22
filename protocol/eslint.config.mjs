import {
  tseslint,
  globals,
  commonIgnores,
  linterOptionsConfig,
} from "../eslint/flat-base.mjs";
import { traycerTypeSafetyRestrictions } from "../eslint/traycer-type-safety-rules.mjs";

export default tseslint.config(
  { ignores: [...commonIgnores] },
  linterOptionsConfig,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node, ...globals.es2021 },
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "no-restricted-syntax": ["error", ...traycerTypeSafetyRestrictions],
    },
  },
);
