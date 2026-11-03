import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { mergeConfig, type Plugin } from "vite";

import base from "./vitest.config.ts";
import { sandboxAssets } from "./vite/sandbox-assets.ts";

/**
 * The Vite config the browser tests' shared server runs with
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
 *
 * `build` is the same pages bundled, which CI serves with `vite preview`
 * (`BROWSER_TESTS_BUNDLE` in `playwright.config.ts`). A fixture on the dev
 * server fetches up to 3,500 modules and 150 MB in every test's fresh context;
 * bundled it fetches a few hundred chunks. `NODE_ENV=development` on the build
 * keeps the React and the `import.meta.env` the dev server gives them.
 */
const port = process.env.BROWSER_TESTS_PORT ?? "4178";
const GUI_APP_ROOT = import.meta.dirname;
const FIXTURE_DIR = "src/__tests__/browser";

/**
 * Every module a spec imports at runtime, `import("/src/...")` inside a page.
 * Each stays an entry at its own path, so that import keeps resolving, and
 * shares the page's module instance through the common chunks.
 */
function modulesSpecsImport(): string[] {
  const root = path.join(GUI_APP_ROOT, "browser-tests");
  const specs = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
    (name) => name.endsWith(".ts"),
  );
  const modules = new Set<string>();
  for (const spec of specs) {
    const source = readFileSync(path.join(root, spec), "utf8");
    for (const match of source.matchAll(/import\(\s*["'`]\/(src\/[^"'`]+)/g)) {
      modules.add(match[1]);
    }
  }
  return [...modules];
}

/** `vite preview` would serve those `.ts` entries as MPEG transport streams. */
function typescriptEntriesAreJavascript(): Plugin {
  return {
    name: "traycer:browser-tests-typescript-entries-are-javascript",
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0].endsWith(".ts") === true) {
          res.setHeader("Content-Type", "text/javascript");
        }
        next();
      });
    },
  };
}

const specModules = modulesSpecsImport();
const fixturePages = readdirSync(path.join(GUI_APP_ROOT, FIXTURE_DIR))
  .filter((name) => name.endsWith(".html"))
  .map((name) => path.join(FIXTURE_DIR, name));

export default mergeConfig(base, {
  plugins: [sandboxAssets(), typescriptEntriesAreJavascript()],
  cacheDir: `node_modules/.vite/browser-tests-${port}`,
  optimizeDeps: { entries: ["src/__tests__/browser/*.html"] },
  server: {
    watch: null,
    warmup: { clientFiles: ["./src/__tests__/browser/*.tsx"] },
  },
  build: {
    // Per server port like `cacheDir`, and ignored with `node_modules`.
    outDir: `node_modules/.vite/browser-tests-${port}-dist`,
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: Number.MAX_SAFE_INTEGER,
    rollupOptions: {
      input: [...fixturePages, ...specModules],
      preserveEntrySignatures: "strict",
      output: {
        entryFileNames: (chunk: {
          readonly facadeModuleId: string | null;
        }): string => {
          const id = chunk.facadeModuleId;
          if (id === null) return "assets/[name]-[hash].js";
          const relative = path
            .relative(GUI_APP_ROOT, id)
            .split(path.sep)
            .join("/");
          return specModules.includes(relative)
            ? relative
            : "assets/[name]-[hash].js";
        },
      },
    },
  },
});
