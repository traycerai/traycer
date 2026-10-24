import { defineConfig } from "vitest/config";
import os from "node:os";
import path from "path";

// The same cap gui-app's config carries. Without one a run takes a fork per
// core, and each fork of this package holds the whole contract in memory: a
// multi-file run on a 14-core laptop passed 50 GB and took the machine down.
const availableParallelism =
  typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;
const MAX_TEST_WORKERS = Math.min(
  2,
  Math.max(1, Math.floor(availableParallelism / 2)),
);

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@traycer\/protocol\/utils\/(.*)$/,
        replacement: path.resolve(__dirname, "./utils/$1"),
      },
      {
        find: /^@traycer\/protocol\/(.*)$/,
        replacement: path.resolve(__dirname, "./src/$1"),
      },
    ],
  },
  test: {
    // Vitest 5 flipped clearMocks to true; keep the v4 behavior (mock call history persists across tests).
    clearMocks: false,
    // Anchored to the package directory so siblings whose names merely
    // CONTAIN "zod" (`zod-to-json-schema`, `@hookform/resolvers/zod`) are
    // not dragged in. Full rationale for the workaround itself lives in
    // `clients/desktop/vitest.shared.ts`.
    server: { deps: { inline: [/[\\/]node_modules[\\/]zod[\\/]/] } },
    include: ["**/__tests__/**/*.test.ts"],
    globals: false,
    maxWorkers: MAX_TEST_WORKERS,
  },
});
