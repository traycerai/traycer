import path from "path";
import os from "node:os";
import { defineConfig } from "vitest/config";

const availableParallelism =
  typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;
const MAX_TEST_WORKERS = Math.min(
  4,
  Math.max(2, Math.floor(availableParallelism / 2)),
);

export default defineConfig({
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
    maxWorkers: MAX_TEST_WORKERS,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
