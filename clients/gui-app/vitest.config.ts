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
// Compile these hooks: a render-time registry read is cached as "no entry yet"
// forever. Only the compiled hook can regress or prove the fix.
const REACT_COMPILER_REGRESSION_FILES =
  /[/\\](?:composer-prompt-editor|use-(?:chat|landing|new-conversation)-prompt-stash-adapters|use-workspace-file-list-subscription|shared-stream-subscription|use-pr-(?:list|detail)-subscription)\.(?:ts|tsx)$/;

export default defineConfig({
  // Composer boundary through the desktop compiler preset. The compiler may
  // replace an imperative-handle facade during an ordinary editor render.
  plugins: [
    react(),
    // Browser regressions spawn vite with this config. Without the Tailwind plugin, utility classes have no rules and geometric/colour claims pass vacuously.
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
    // Anchor to the package directory so siblings whose names contain "zod"
    // are not dragged in.
    server: { deps: { inline: [/[\\/]node_modules[\\/]zod[\\/]/] } },
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
    // Do not fail the run on post-teardown async errors. test-browser-apis.ts
    // still logs them.
    dangerouslyIgnoreUnhandledErrors: true,
  },
});
