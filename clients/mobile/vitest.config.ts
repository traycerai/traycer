import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    // The `@traycer/protocol` pair mirrors `clients/shared/vitest.config.ts`:
    // the workspace package resolves through the compiler's paths for `tsc`,
    // but vitest's vite resolver needs the same mapping stated here or a test
    // whose module graph reaches the protocol fails to resolve it on a fresh
    // checkout.
    alias: [
      {
        find: "@traycer-clients/shared",
        replacement: path.resolve(__dirname, "../shared"),
      },
      {
        find: "@traycer-clients/gui-app",
        replacement: path.resolve(__dirname, "../gui-app"),
      },
      {
        find: "@traycer-clients/mobile",
        replacement: path.resolve(__dirname, "./src"),
      },
      { find: "@", replacement: path.resolve(__dirname, "../gui-app/src") },
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
    environment: "jsdom",
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "__tests__/**/*.test.ts",
      "__tests__/**/*.test.tsx",
    ],
    globals: false,
  },
});
