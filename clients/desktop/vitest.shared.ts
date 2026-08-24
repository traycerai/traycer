/**
 * Vitest options shared by this package's two configs.
 *
 * The rationale below lived in both of them, byte-identical, and ended with
 * "revisit at the next Vite bump" - which meant revisiting in two places and
 * letting the copies drift about which suites still needed the workaround.
 */

/**
 * Forces `zod` through the test module graph instead of the dependency
 * optimizer's pre-bundle.
 *
 * zod 4.4.3's entry re-exports a namespace binding:
 *
 * ```js
 * import * as z from "./v4/classic/external.js";
 * export * from "./v4/classic/external.js";
 * export { z };
 * ```
 *
 * The pinned Vite 8 loses that binding when it pre-bundles the package, so
 * `import { z } from "zod"` resolves to `undefined` and every module that
 * builds a schema at import time dies with "undefined is not an object
 * (evaluating 'z.object')". Inlining skips the pre-bundle, and the binding
 * survives.
 *
 * `deps.external` is NOT an alternative. It looks like one - a test file's own
 * direct `import { z }` starts working - but every transformed SOURCE module
 * still reads `undefined`, so a probe written as a throwaway test passes while
 * the real suites stay red. Verify any replacement against the actual suites.
 *
 * TEST-ONLY: `test.server.deps` governs how vitest loads modules and has no
 * effect on any production bundle. Preferred over rewriting every
 * `import { z }` in the monorepo, which would have to be re-applied to each new
 * one forever and still could not reach source checked out of git history at
 * runtime (the `host-v1.1.5` schema oracle does exactly that).
 *
 * The pattern is anchored to the package directory so sibling packages whose
 * names merely CONTAIN "zod" - `zod-to-json-schema`,
 * `@hookform/resolvers/zod` - are not dragged in with it.
 *
 * Revisit at the next Vite bump: if the binding survives pre-bundling again,
 * this can go.
 */
export const ZOD_INLINE_SERVER_DEPS = {
  deps: { inline: [/[\\/]node_modules[\\/]zod[\\/]/] },
} as const;
