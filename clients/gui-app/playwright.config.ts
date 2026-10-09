import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

/**
 * The GUI's real-browser regressions, `browser-tests/**\/*.spec.ts`: claims
 * jsdom cannot decide - layout, painted pixels and real input dispatch -
 * checked against the fixture pages in `src/__tests__/browser/`, which one
 * shared Vite dev server serves (`vite.browser-tests.config.ts`).
 *
 * CI runs them in `.github/workflows/browser-regressions.yml`, sharded across
 * parallel jobs, whenever a change touches what they depend on; its
 * `browser regressions` job is a required check on `main`. Locally:
 *
 *   bun run test:browser                                  # every spec
 *   bun run test:browser browser-tests/hover-card.spec.ts # one file
 *
 * The browser is the machine's own Google Chrome (`channel: "chrome"`), so
 * nothing downloads one. Set CHROME_BIN to run another Chrome build instead.
 */

const GUI_APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
// BROWSER_TESTS_PORT lets two local runs (two worktrees, two agents) keep
// their own servers; each gets its own Vite cache too, see the Vite config.
const PORT = Number(process.env.BROWSER_TESTS_PORT ?? "4178");
const BASE_URL = `http://127.0.0.1:${String(PORT)}`;
const isCi = process.env.CI !== undefined;
const chromeBin = process.env.CHROME_BIN;

/** Vite's CLI, run under Node exactly as the app's own dev server is. */
function viteBin(): string {
  const requireFromHere = createRequire(import.meta.url);
  const manifestPath = requireFromHere.resolve("vite/package.json");
  const manifest = requireFromHere(manifestPath) as {
    readonly bin: Readonly<Record<string, string>>;
  };
  return path.resolve(path.dirname(manifestPath), manifest.bin.vite);
}

export default defineConfig({
  testDir: "./browser-tests",
  testMatch: "**/*.spec.ts",
  // Test by test, across workers and shards; a group sharing one page opts
  // out with `mode: "default"`, so it boots once (browser-tests/README.md).
  fullyParallel: true,
  forbidOnly: isCi,
  // One retry on CI absorbs a runner hiccup; the report still marks such a
  // test "flaky", so a real intermittent failure stays visible.
  retries: isCi ? 1 : 0,
  // The heaviest fixtures boot most of the app from unbundled modules, and a
  // standard runner has 4 vCPUs: two pages at a time leaves room for Vite.
  workers: 2,
  timeout: 180_000,
  expect: { timeout: 10_000 },
  reporter: isCi
    ? [["github"], ["list"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    baseURL: BASE_URL,
    ...(chromeBin === undefined
      ? { channel: "chrome" }
      : { launchOptions: { executablePath: chromeBin } }),
    headless: true,
    // A heavy fixture's load takes seconds. One that never fires its load
    // event (the old CDP drivers saw this on CI runners) fails here and is
    // retried, rather than spending the whole test timeout.
    navigationTimeout: 60_000,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node ${JSON.stringify(viteBin())} --config vite.browser-tests.config.ts --host 127.0.0.1 --port ${String(PORT)} --strictPort`,
    cwd: GUI_APP_ROOT,
    env: { BROWSER_TESTS_PORT: String(PORT) },
    url: `${BASE_URL}/src/__tests__/browser/quit-intercept-cancel.html`,
    reuseExistingServer: !isCi,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
