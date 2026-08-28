import { defineConfig } from "oxlint";
import baseConfig from "./.oxlintrc.json" with { type: "json" };
import eslintConfig from "./eslint.config.mjs";
import { adaptOxlintConfig } from "../eslint/oxlint-config-adapter.mjs";

export default defineConfig(
  adaptOxlintConfig({
    baseConfig,
    eslintConfig,
    jsPlugin: "../eslint/oxlint-restricted-syntax-plugin.mjs",
  }),
);
