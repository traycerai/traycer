import { mergeConfig } from "vite";

import base from "./vitest.config.ts";
import { sandboxAssets } from "./vite/sandbox-assets.ts";

/**
 * The Vite config the browser tests' shared dev server runs with
 * (`playwright.config.ts`, `webServer`). It is the app's own config - which
 * also compiles Tailwind for the fixture pages, see the note on
 * `tailwindcss()` there - plus what a long-lived test server needs:
 *
 * - `optimizeDeps.entries` names the fixture pages. Vite's dependency scan
 *   skips `__tests__` directories by default, so without it every dependency
 *   was discovered in the middle of a page load, re-optimised, and the page
 *   reloaded under the test. That is why the old CDP drivers carried
 *   reload-tolerant waits and started Vite with `--force` every run.
 * - `server.warmup` transforms the fixtures' module graphs when the server
 *   starts, not on the first test's page load.
 * - `server.watch: null`: nothing edits files during a run, and a watcher
 *   reload in the middle of a test would take the page's injected helpers
 *   with it.
 * - `sandboxAssets()` serves the sandbox loader at `/sandbox/`, as the
 *   mobile app does, so a fixture can run a real sandboxed page or app.
 * - `cacheDir` is per server port, so two servers running at once (two
 *   worktrees, or `BROWSER_TESTS_PORT`) never rewrite one optimised-deps
 *   cache under each other.
 */
const port = process.env.BROWSER_TESTS_PORT ?? "4178";

export default mergeConfig(base, {
  plugins: [sandboxAssets()],
  cacheDir: `node_modules/.vite/browser-tests-${port}`,
  optimizeDeps: { entries: ["src/__tests__/browser/*.html"] },
  server: {
    watch: null,
    warmup: { clientFiles: ["./src/__tests__/browser/*.tsx"] },
  },
});
