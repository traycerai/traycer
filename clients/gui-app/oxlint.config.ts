import { defineConfig } from "oxlint";
import baseConfig from "./.oxlintrc.json" with { type: "json" };
import eslintConfig from "./eslint.config.mjs";
import { adaptOxlintConfig } from "../../eslint/oxlint-config-adapter.mjs";

// The adapter carries every composed no-restricted-syntax dimension, including
// all seven shared type-safety selectors for production and test overrides.
export default defineConfig(
  adaptOxlintConfig({
    baseConfig,
    eslintConfig,
    jsPlugin: "../../eslint/oxlint-restricted-syntax-plugin.mjs",
  }),
);
