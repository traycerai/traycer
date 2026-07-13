#!/usr/bin/env bun
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * Builds the Electron main process and preload bridge into self-contained
 * CommonJS bundles via esbuild. Inlines every dependency (electron-log,
 * electron-updater, the @traycer-clients/shared barrel, etc.) so the
 * packaged Traycer.app does not need to ship `node_modules/` inside the
 * asar - the only external is `electron` itself, which is provided by
 * the Electron runtime.
 *
 * Replaces the prior `tsc + tsc-alias + write-main-entry.cjs` chain.
 * Dev (`bun run dev`) now uses these same bundles - main-process changes
 * require an Electron restart, and preload changes have always required
 * one - so the prior tsx-based shim path is no longer needed.
 *
 * Output layout matches what `main-process.ts:resolvePreloadPath`,
 * `first-launch-setup.ts:resolveSplashPreloadPath`, and
 * `package.json:main` expect:
 *
 *   dist/main/index.js                          - bundled main process (Electron entry)
 *   dist/preload/index.js                       - bundled preload bridge (main window)
 *
 * Externals:
 *   - `electron`            (Electron runtime - provided at load time)
 *   - `*.node`              (native bindings, future-proofing - none today)
 *   - `font-list`           (spawns a compiled sidecar binary/script via
 *     `__dirname`-relative `execFile` - inlining it breaks both that path
 *     resolution and its ESM `createRequire(import.meta.url)` entry, which
 *     esbuild reduces to `createRequire(undefined)` when squashed into a
 *     CJS bundle. Left as a real `require("font-list")` so Node resolves it
 *     from `node_modules` at runtime; `package.json`'s `files`/`asarUnpack`
 *     ship it alongside the packaged app.)
 */

const { existsSync, mkdirSync, rmSync } = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");
const { sentryEsbuildPlugin } = require("@sentry/esbuild-plugin");

const workspaceRoot = path.resolve(__dirname, "..");
const distDir = path.resolve(workspaceRoot, "dist");
const tsconfigPath = path.resolve(workspaceRoot, "tsconfig.main.json");
const mainEntry = path.resolve(
  workspaceRoot,
  "src",
  "electron-main",
  "main-process.ts",
);
const preloadEntry = path.resolve(
  workspaceRoot,
  "src",
  "electron-preload",
  "preload-bridge.ts",
);
const mainOutFile = path.resolve(distDir, "main", "index.js");
const preloadOutFile = path.resolve(distDir, "preload", "index.js");
const envDefines = {
  "process.env.VITE_TRAYCER_DESKTOP_UPDATE_REPO": JSON.stringify(
    process.env.VITE_TRAYCER_DESKTOP_UPDATE_REPO ?? "",
  ),
  "process.env.VITE_TRAYCER_DESKTOP_UPDATE_TOKEN": JSON.stringify(
    process.env.VITE_TRAYCER_DESKTOP_UPDATE_TOKEN ?? "",
  ),
};

if (!existsSync(mainEntry)) {
  throw new Error(`Main entry not found: ${mainEntry}`);
}
if (!existsSync(preloadEntry)) {
  throw new Error(`Preload entry not found: ${preloadEntry}`);
}
// Reset the bundle outputs so a stale file from a previous tsc-based build
// can't shadow the new bundle.
const outDirs = [mainOutFile, preloadOutFile].map((outfile) =>
  path.dirname(outfile),
);
for (const dir of outDirs) {
  rmSync(dir, { recursive: true, force: true });
}
for (const dir of outDirs) {
  mkdirSync(dir, { recursive: true });
}

const sharedConfig = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  tsconfig: tsconfigPath,
  external: ["electron", "*.node", "font-list"],
  // Source maps are useful when the packaged app surfaces a stack trace
  // through electron-log; "external" keeps them out of app.asar.
  sourcemap: "external",
  legalComments: "none",
  // Sentry's proxy module emits this warning for entry points with no
  // default export. The proxy is never imported for its default.
  logOverride: { "import-is-undefined": "silent" },
  define: envDefines,
};

async function build() {
  const sentryPlugins = (() => {
    if (!process.env.SENTRY_AUTH_TOKEN) return [];
    const missing = ["SENTRY_ORG", "SENTRY_PROJECT"].filter(
      (key) => !process.env[key],
    );
    if (missing.length > 0) {
      throw new Error(
        `SENTRY_AUTH_TOKEN is set but the following required variables are missing: ${missing.join(", ")}`,
      );
    }
    return [
      sentryEsbuildPlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
      }),
    ];
  })();

  const bundles = [
    {
      entry: mainEntry,
      outfile: mainOutFile,
      label: "electron-main",
      plugins: sentryPlugins,
    },
    {
      entry: preloadEntry,
      outfile: preloadOutFile,
      label: "electron-preload",
      plugins: [],
    },
  ];

  for (const { entry, outfile, label, plugins } of bundles) {
    const start = Date.now();
    await esbuild.build({
      ...sharedConfig,
      entryPoints: [entry],
      outfile,
      absWorkingDir: workspaceRoot,
      plugins,
    });
    const ms = Date.now() - start;
    console.log(
      `[desktop] bundled ${label} → ${path.relative(workspaceRoot, outfile)} (${ms}ms)`,
    );
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
