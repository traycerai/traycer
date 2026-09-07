#!/usr/bin/env bun
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// Some packages must resolve to a single physical copy or they break at runtime.
// This only surfaces in the production build - Vite's dev pre-bundle collapses duplicate copies, so `make dev-desktop` never shows it.

const { readdirSync, readFileSync, existsSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { resolve, join } = require("node:path");

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(__dirname, "..", "..", "..");
const assetsDir = resolve(desktopRoot, "dist", "renderer", "assets");

const GUARDED_STORE_TOKEN =
  /\.bun\/(@(?:codemirror|lezer)\+[a-z0-9-]+|react(?:-dom)?)@([^/]+)\/node_modules\//g;

function decodePackageName(encodedName) {
  return encodedName.startsWith("@")
    ? `@${encodedName.slice(1).replace("+", "/")}`
    : encodedName;
}

function findDuplicates() {
  if (!existsSync(assetsDir)) return null;
  const maps = readdirSync(assetsDir).filter((f) => f.endsWith(".map"));
  if (maps.length === 0) return null;

  // package name -> set of distinct store version tags (each = one copy)
  const copiesByPackage = new Map();
  const record = (encodedName, versionTag) => {
    const pkg = decodePackageName(encodedName);
    const copies = copiesByPackage.get(pkg) ?? new Set();
    copies.add(versionTag);
    copiesByPackage.set(pkg, copies);
  };
  for (const file of maps) {
    const content = readFileSync(join(assetsDir, file), "utf8");
    for (const [, encodedName, versionTag] of content.matchAll(
      GUARDED_STORE_TOKEN,
    )) {
      record(encodedName, versionTag);
    }
  }

  const duplicates = [...copiesByPackage.entries()]
    .filter(([, copies]) => copies.size > 1)
    .map(([pkg, copies]) => ({ pkg, versions: [...copies].sort() }));
  return { total: copiesByPackage.size, duplicates };
}

function formatDuplicates(duplicates) {
  return duplicates
    .map((d) => `  ${d.pkg}: ${d.versions.join(", ")}`)
    .join("\n");
}

const first = findDuplicates();

if (first === null) {
  const message =
    "no renderer sourcemaps found; cannot verify single-instance packages. " +
    "The renderer build must keep `build.sourcemap` enabled for this guard to run.";
  // Fail closed in CI: a relocated output path or disabled sourcemaps must not
  // let a release build ship an unverified bundle. Locally it stays a warning.
  if (process.env.CI) {
    console.error(
      `[assert-single-instance] ${message}\nFailing closed - a CI build must ` +
        "not publish an unverified renderer bundle.",
    );
    process.exit(1);
  }
  console.warn(`[assert-single-instance] ${message}`);
  process.exit(0);
}

if (first.duplicates.length === 0) {
  console.log(
    `[assert-single-instance] OK - ${first.total} single-instance package(s), single copy each.`,
  );
  process.exit(0);
}

// Duplicates found. In CI, fail loudly - a release build must be reproducible
// and must not rewrite its own dependency tree mid-build.
if (process.env.CI) {
  console.error(
    "\n[assert-single-instance] Renderer bundle contains multiple copies of a " +
      "single-instance package:\n" +
      formatDuplicates(first.duplicates) +
      '\n\nThis breaks at runtime - CodeMirror with "Unrecognized extension value ' +
      'in extension set ([object Object])", React with "Invalid hook call". The ' +
      "dependency store is stale or skewed - run `bun install --force` from the repo " +
      "root, rebuild, and commit the resulting lockfile.\n",
  );
  process.exit(1);
}

// Local build: self-heal. A stale store is the usual cause and a forced
// reinstall relinks it; rebuild once and re-check.
console.warn(
  "\n[assert-single-instance] Multiple copies detected in the bundle:\n" +
    formatDuplicates(first.duplicates) +
    "\n\nLikely a stale dependency store. Self-healing: `bun install --force` + rebuild...\n",
);
execFileSync("bun", ["install", "--force"], {
  cwd: repoRoot,
  stdio: "inherit",
});
execFileSync(
  "bun",
  ["x", "vite", "build", "--config", "vite.renderer.config.ts"],
  {
    cwd: desktopRoot,
    stdio: "inherit",
  },
);

const second = findDuplicates();
if (second !== null && second.duplicates.length === 0) {
  console.log(
    "[assert-single-instance] Healed - a clean reinstall collapsed the duplicate copies.",
  );
  process.exit(0);
}

console.error(
  "\n[assert-single-instance] Duplicate copies survived a clean reinstall:\n" +
    formatDuplicates((second ?? first).duplicates) +
    "\n\nThis is not a stale store - a workspace is pinning a different version that " +
    "is reachable from the renderer. Align the pins/overrides so only one version " +
    "resolves, then rebuild.\n",
);
process.exit(1);
