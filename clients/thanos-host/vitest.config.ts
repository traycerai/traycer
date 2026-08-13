import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: [
      { find: "@thanos/host", replacement: path.resolve(__dirname, "./src") },
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
    testTimeout: 15_000,
  },
});
