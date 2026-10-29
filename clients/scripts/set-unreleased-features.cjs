/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * Selects, per build, the features the next release does not ship (sandboxes,
 * environments and bots) by rewriting the one literal every gate reads:
 *
 *   export const UNRELEASED_FEATURES_ENABLED: boolean = true;
 *
 * in each client's `unreleased-features.ts`. The committed value is `true`:
 * development (the tree as checked out) and the staging builds run with the
 * features; only a production build writes `false` (the desktop and CLI
 * `set-deploy-target.cjs` do it for `--target=production`, the mobile
 * production lane through the internal copy of this script). A developer
 * comparing against production runs `--off` locally and `--restore` before
 * committing (the commit hook refuses anything but `true`). There is no
 * runtime lookup.
 *
 * Owned by the clients tree, like `rewrite-config-target.cjs`, so the client
 * stampers resolve it within this workspace.
 *
 * Usage, from the repository root:
 *   bun clients/scripts/set-unreleased-features.cjs --off           # every client file below
 *   bun clients/scripts/set-unreleased-features.cjs --on <file>...  # the named files
 *   bun clients/scripts/set-unreleased-features.cjs --restore       # the committed value
 */

const fs = require("node:fs");
const path = require("node:path");

const PREFIX = "[set-unreleased-features]";
const CLIENTS_ROOT = path.resolve(__dirname, "..");

/** Every read site in the clients. */
const UNRELEASED_FEATURES_FILES = [
  "gui-app/src/unreleased-features.ts",
  "traycer-cli/src/unreleased-features.ts",
  "desktop/src/unreleased-features.ts",
  "shared/unreleased-features.ts",
].map((relative) => path.join(CLIENTS_ROOT, relative));

const LITERAL = /(\bUNRELEASED_FEATURES_ENABLED: boolean = )(true|false)(;)/;

/**
 * Writes `enabled` into the literal at `sourcePath`. Throws when the file has
 * no such literal: a build that could not find it would otherwise ship
 * whatever the file holds, which is the one outcome this script exists to
 * rule out.
 */
function rewriteUnreleasedFeatures(sourcePath, enabled) {
  const source = fs.readFileSync(sourcePath, "utf8");
  if (!LITERAL.test(source)) {
    throw new Error(
      `${PREFIX} no 'UNRELEASED_FEATURES_ENABLED: boolean = <true|false>;' literal in ${sourcePath}`,
    );
  }
  fs.writeFileSync(
    sourcePath,
    source.replace(LITERAL, `$1${enabled ? "true" : "false"}$3`),
    "utf8",
  );
  console.log(`${PREFIX} ${sourcePath} -> ${enabled ? "on" : "off"}`);
}

function parseArgs(argv) {
  let enabled = null;
  const files = [];
  for (const arg of argv) {
    if (arg === "--on" || arg === "--restore") enabled = true;
    else if (arg === "--off") enabled = false;
    else if (arg.startsWith("--")) {
      console.error(`${PREFIX} unknown option '${arg}'`);
      process.exit(2);
    } else files.push(path.resolve(arg));
  }
  if (enabled === null) {
    console.error(`${PREFIX} usage: --on | --off | --restore [file...]`);
    process.exit(1);
  }
  return {
    enabled,
    files: files.length === 0 ? UNRELEASED_FEATURES_FILES : files,
  };
}

if (require.main === module) {
  const { enabled, files } = parseArgs(process.argv.slice(2));
  try {
    for (const file of files) rewriteUnreleasedFeatures(file, enabled);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(3);
  }
}

module.exports = { rewriteUnreleasedFeatures, UNRELEASED_FEATURES_FILES };
