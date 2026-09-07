import path from "path";
import { defineConfig } from "vitest/config";
import { ZOD_INLINE_SERVER_DEPS } from "./vitest.shared";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@traycer-clients/shared",
        replacement: path.resolve(__dirname, "../shared"),
      },
      {
        find: "@traycer-clients/desktop",
        replacement: path.resolve(__dirname, "./src"),
      },
      // Match gui-app: resolve the protocol source directly (vitest doesn't use
      // tsconfig paths). `utils/*` lives outside `src/`, so it must come first.
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
    server: ZOD_INLINE_SERVER_DEPS,
    include: ["**/__tests__/**/*.test.ts"],
    globals: false,
    // jsdom provides `self` / `window` / `localStorage` so the renderer-shell
    // tests can `import "encrypt-storage"` (UMD wrapper references `self`).
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
  },
});
