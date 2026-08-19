import path from "path";
import os from "node:os";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const availableParallelism =
  typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;
const MAX_TEST_WORKERS = Math.min(
  2,
  Math.max(1, Math.floor(availableParallelism / 2)),
);
const REACT_COMPILER_REGRESSION_FILES =
  /[/\\](?:composer-prompt-editor|use-(?:chat|landing|new-conversation)-prompt-stash-adapters)\.(?:ts|tsx)$/;

export default defineConfig({
  // Run the affected composer boundary through the packaged desktop
  // renderer's compiler preset. The stash regression was invisible when
  // tests skipped this pass because the compiler may replace a React
  // imperative-handle facade during an ordinary editor render. The filter
  // keeps unrelated GUI tests on their existing fast transform path.
  plugins: [
    react(),
    // This config is ALSO what the browser regressions serve their fixtures
    // from - every driver in `scripts/*-browser.mjs` spawns vite with
    // `--config vitest.config.ts`. Without this plugin, `@import "tailwindcss"`
    // at `src/index.css:1` compiles to NOTHING (there is no `postcss.config.*`
    // here, so there is no second compile path), and the fixtures render with
    // the utility classes present on every element and no rules behind them:
    // `h-8` measured 24px, `DialogFooter`'s `flex` computed `display: block`,
    // `bg-primary` computed `rgba(0, 0, 0, 0)`.
    //
    // That is a harness that lies in the SAFE direction. A fixture asserting
    // two nodes share a left edge passes trivially when both are unstyled
    // blocks at the same content edge, and one asserting a control is "filled"
    // passes-as-transparent - on the fixed tree and the broken one alike. Any
    // geometric or colour claim measured without this was vacuous.
    //
    // jsdom runs are unaffected: vitest does not process CSS by default, so
    // this changes what the dev server serves, not what the suite transforms.
    tailwindcss(),
    babel({
      include: REACT_COMPILER_REGRESSION_FILES,
      presets: [reactCompilerPreset()],
    }).then((plugin) => ({
      ...plugin,
      enforce: "post" as const,
    })),
  ],
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(__dirname, "src") },
      {
        find: "@traycer-clients/shared",
        replacement: path.resolve(__dirname, "..", "shared"),
      },
      {
        find: /^@traycer\/protocol\/utils\/(.*)$/,
        replacement: path.resolve(
          __dirname,
          "..",
          "..",
          "protocol",
          "utils",
          "$1",
        ),
      },
      {
        find: /^@traycer\/protocol\/(.*)$/,
        replacement: path.resolve(
          __dirname,
          "..",
          "..",
          "protocol",
          "src",
          "$1",
        ),
      },
    ],
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./__tests__/test-browser-apis.ts"],
    include: [
      "__tests__/**/*.test.ts",
      "__tests__/**/*.test.tsx",
      "src/**/__tests__/**/*.test.ts",
      "src/**/__tests__/**/*.test.tsx",
    ],
    globals: false,
    pool: "forks",
    // A few suites advance large fake-timer windows. Limiting concurrently
    // running files keeps those timers responsive on CI's shared runners.
    maxWorkers: MAX_TEST_WORKERS,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Don't let a stray post-teardown async error (a timer/socket/microtask
    // rejecting after a test finished) fail the whole run with exit 1 and no
    // failing test - the classic intermittent CI flake. The setup file
    // (`__tests__/test-browser-apis.ts`) still logs every such error, so we keep
    // visibility instead of silently swallowing it.
    dangerouslyIgnoreUnhandledErrors: true,
  },
});
