import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    // Mirrors `tsconfig.json`'s `paths`, entry for entry. The protocol pair is
    // ordered `utils` first because vite matches an object alias by PREFIX, so
    // the bare `@traycer/protocol` key would otherwise swallow it and resolve
    // `utils/*` under `src/`. Type-only protocol imports need none of this -
    // these exist for the specifiers a test evaluates at RUNTIME (the RPC
    // registry, the request-context factory), which is what makes a shell test
    // able to drive the real transport rather than a stand-in for it.
    alias: {
      "@traycer-clients/shared": path.resolve(__dirname, "../shared"),
      "@traycer-clients/gui-app": path.resolve(__dirname, "../gui-app"),
      "@traycer-clients/webapp": path.resolve(__dirname, "./src"),
      "@traycer/protocol/utils": path.resolve(
        __dirname,
        "../../protocol/utils",
      ),
      "@traycer/protocol": path.resolve(__dirname, "../../protocol/src"),
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
