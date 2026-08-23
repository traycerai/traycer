import path from "path";
import { defineConfig } from "vitest/config";

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
    // zod 4.4.3's entry re-exports a namespace binding:
    //
    //   import * as z from "./v4/classic/external.js";
    //   export * from "./v4/classic/external.js";
    //   export { z };
    //
    // The pinned Vite 8 drops that re-exported binding when it transforms the
    // package, so `import { z } from "zod"` resolves to `undefined` and every
    // module that builds a schema at import time dies with "undefined is not an
    // object (evaluating 'z.object')". Externalizing zod hands it to Node's own
    // ESM loader. Vitest's `inline` is what actually restores it: the package
    // is processed as part of the test module graph rather than pre-bundled by
    // the dep optimizer, and the optimizer's pre-bundle is where the binding is
    // lost. `external` is NOT sufficient - it fixes a test file's own direct
    // import while leaving every transformed SOURCE module still reading
    // `undefined`, which is exactly the case that matters.
    //
    // TEST-ONLY: `test.server.deps` governs how vitest loads modules and has no
    // effect on any production bundle. Preferred over rewriting ~207 source
    // files to `import * as z`, which would have to be re-applied to every new
    // zod import in the monorepo forever. Revisit at the next Vite bump.
    server: { deps: { inline: [/zod/] } },
    include: ["**/__tests__/**/*.test.ts"],
    globals: false,
    // jsdom provides `self` / `window` / `localStorage` so the renderer-shell
    // tests can `import "encrypt-storage"` (UMD wrapper references `self`).
    environment: "jsdom",
    // Home sandbox: re-points `os.homedir()` at the (per-test) env and
    // baselines HOME to a temp dir, so no suite - nor electron-log's file
    // transport - can write into the real `~` on any runtime. Deliberately
    // NOT wired into vitest.config.packaging.ts: the real electron-builder
    // pack there needs the real `~/Library/Caches/electron-builder`.
    setupFiles: ["./vitest.setup.ts"],
  },
});
