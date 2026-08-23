import { defineConfig } from "vitest/config";
import path from "path";

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
    // Anchored to the package directory so siblings whose names merely
    // CONTAIN "zod" (`zod-to-json-schema`, `@hookform/resolvers/zod`) are
    // not dragged in. Full rationale for the workaround itself lives in
    // `clients/desktop/vitest.shared.ts`.
    server: { deps: { inline: [/[\\/]node_modules[\\/]zod[\\/]/] } },
    include: ["**/__tests__/**/*.test.ts"],
    globals: false,
  },
});
