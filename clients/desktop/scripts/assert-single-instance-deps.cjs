#!/usr/bin/env bun
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// Post-build guard for the renderer bundle.
//
// Some packages must resolve to a single physical copy or they break at
// runtime:
//   - CodeMirror / Lezer key their extension systems on `instanceof` checks
//     against module-level singletons (facets, `StateField`, `NodeType`). Two
//     copies of e.g. `@codemirror/state` make an extension built by one copy
//     unrecognizable to the `EditorState` built by the other, and the app
//     crashes with "Unrecognized extension value in extension set
//     ([object Object])".
//   - React keys hooks and context on module-level state (and per-copy
//     `Symbol.for` element tags). A second copy of `react` / `react-dom`
//     surfaces as "Invalid hook call" or context that silently reads its
//     default value.
//
// This only surfaces in the production build - Vite's dev pre-bundle collapses
// duplicate copies, so `make dev-desktop` never shows it. Two things can
// reintroduce a duplicate: a stale bun isolated store (leftover copies from an
// in-place dependency bump that consolidated the lock without pruning), and a
// version skew between this repo's pins and another workspace's.
//
// Rather than guess at the install layout, this asserts ground truth: it scans
// the emitted sourcemaps for a single-instance package that appears at more
// than one version IN THE BUNDLE. It runs only from `build:renderer`, never
// `dev:renderer`, so the dev loop is untouched, and on a clean build it is a
// no-op that adds a few hundred ms.
//
// Self-correction: a stale store is the common cause and `bun install --force`
// relinks it. So locally the guard heals itself - reinstall, rebuild once, and
// re-check - and only fails if the duplicate survives a clean reinstall, which
// means a genuine version skew that a human must resolve. In CI (`process.env
// .CI`) it never self-heals: a release build must fail loudly and be
// reproducible, not silently mutate its own dependency tree.

const { readdirSync, readFileSync, existsSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { resolve, join } = require("node:path");

const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(__dirname, "..", "..", "..");
const assetsDir = resolve(desktopRoot, "dist", "renderer", "assets");

// Each package copy lives in a bun store directory
// `.bun/<encodedName>@<versionTag>/node_modules/...` (scoped names use `+`,
// e.g. `@codemirror+state@6.7.1`), and that path lands in the sourcemap
// `sources`. `<versionTag>` is captured whole - including any prerelease or
// build suffix such as `4.25.10+a7c5f79d` - so it identifies a *physical* copy:
// two roots at the same semver (e.g. a patched dep) are still two copies and
// must fail. Anchoring on `.bun/` also stops bare `react`/`react-dom` from
// matching scoped neighbours like `@radix-ui+react-slot` or
// `@floating-ui+react-dom`.
const GUARDED_STORE_TOKEN =
  /\.bun\/(@(?:codemirror|lezer)\+[a-z0-9-]+|react(?:-dom)?)@([^/]+)\/node_modules\//g;

function decodePackageName(encodedName) {
  return encodedName.startsWith("@")
    ? `@${encodedName.slice(1).replace("+", "/")}`
    : encodedName;
}

// Scan every emitted sourcemap and return the guarded packages that appear as
// more than one physical copy, as `[{ pkg, versions }]`. Copy identity is the
// full `<versionTag>`, so distinct roots at the same semver still count as two.
// `null` means the check could not run (no assets or no sourcemaps).
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
