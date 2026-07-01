import { defineConfig } from "vitest/config";
import path from "node:path";

// Standalone vitest config for the CLI workspace. Tests live under
// `src/**/__tests__/`. vitest does not read tsconfig paths, so the workspace
// imports (`@traycer-clients/shared`, `@traycer/protocol/*`) are resolved here,
// mirroring the desktop/gui-app configs. `utils/*` lives outside protocol's
// `src/`, so its alias must come before the general protocol alias.
export default defineConfig({
  resolve: {
    alias: [
      { find: "@traycer/cli", replacement: path.resolve(__dirname, "./src") },
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
    include: ["src/**/__tests__/**/*.test.ts"],
    globals: false,
  },
});
