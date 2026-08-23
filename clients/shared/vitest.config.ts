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
    env: {
      VITE_TRAYCER_OSS_REPO: "https://github.com/traycerai/traycer",
    },
  },
});
