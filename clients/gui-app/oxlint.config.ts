// No tsconfig includes this file (its `.mjs` imports have no declarations), so
// the type-aware lint types it on its own; this gives it Node's `process`.
/// <reference types="node" />
import { defineConfig } from "oxlint";
import baseConfig from "./.oxlintrc.base.json" with { type: "json" };
import eslintConfig from "./eslint.config.mjs";
import { adaptOxlintConfig } from "../../eslint/oxlint-config-adapter.mjs";

// tsgolint, the Go binary oxlint starts for the type-aware rules, runs one type
// checker per core, and every checker holds its own copy of the type state: on
// a 14-core Mac a whole-project lint peaked at 8.7-9.3 GB, and at 6.7-7.2 GB on
// one checker, about twice as slow. Neither tsgolint nor this config has a
// setting for it, and Go reads GOMAXPROCS when tsgolint starts. oxlint
// evaluates this file in its own process before it starts tsgolint, so setting
// it here reaches every type-aware run of this config: the lint scripts, nx, a
// bare `oxlint` in this directory, or an agent calling oxlint directly. That is
// why the base config is `.oxlintrc.base.json` and not `.oxlintrc.json`: with
// both names present a bare `oxlint` fails and suggests deleting one, and the
// JSON on its own starts tsgolint without running this file. CI keeps Go's
// default: one job on a 4-core runner, and the diagnostics do not depend on the
// checker count. A GOMAXPROCS already set wins.
if ((process.env.CI ?? "") === "" && (process.env.GOMAXPROCS ?? "") === "") {
  process.env.GOMAXPROCS = "1";
}

// The adapter carries every composed no-restricted-syntax dimension, including
// all seven shared type-safety selectors for production and test overrides.
export default defineConfig(
  adaptOxlintConfig({
    baseConfig,
    eslintConfig,
    jsPlugin: "../../eslint/oxlint-restricted-syntax-plugin.mjs",
  }),
);
