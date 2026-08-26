import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@traycer-clients/shared": path.resolve(__dirname, "../shared"),
      "@traycer-clients/gui-app": path.resolve(__dirname, "../gui-app"),
      "@traycer-clients/mobile": path.resolve(__dirname, "./src"),
      "@": path.resolve(__dirname, "../gui-app/src"),
    },
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
