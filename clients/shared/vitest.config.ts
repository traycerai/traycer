import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@traycer-clients/shared",
        replacement: path.resolve(__dirname, "."),
      },
      {
        find: /^@traycer\/protocol\/utils\/(.*)$/,
        replacement: path.resolve(__dirname, "../../protocol/utils/$1"),
      },
      {
        find: /^@traycer\/protocol\/(.*)$/,
        replacement: path.resolve(__dirname, "../../protocol/src/$1"),
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
    // Pins the home directory to a temp dir per test file - see the file.
    setupFiles: ["./vitest.setup.ts"],
    globals: false,
    env: {
      VITE_TRAYCER_OSS_REPO: "https://github.com/traycerai/traycer",
    },
  },
});
