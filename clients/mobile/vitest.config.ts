import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // Shape must satisfy `TraycerMobileBakedConfig` (`src/vite-env.d.ts`); the values themselves are inert - nothing in a jsdom test dials these endpoints.
  define: {
    __TRAYCER_MOBILE_CONFIG__: JSON.stringify({
      environment: "dev",
      authnBaseUrl: "http://127.0.0.1:1",
      signInUrl: "http://127.0.0.1:1/sign-in",
      relayBaseUrl: "ws://127.0.0.1:1",
      hostLabel: "Traycer Mobile (vitest)",
      returnScheme: "traycer-dev",
      sentryDsn: "",
      devHost: null,
    }),
  },
  resolve: {
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
