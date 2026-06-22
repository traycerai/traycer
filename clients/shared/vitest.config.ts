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
    include: ["**/__tests__/**/*.test.ts"],
    globals: false,
    env: {
      VITE_TRAYCER_OSS_REPO: "https://github.com/traycerai/traycer",
    },
  },
});
