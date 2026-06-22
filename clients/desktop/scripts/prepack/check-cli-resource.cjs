#!/usr/bin/env bun
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * Precheck invoked before `electron-builder`. Replaces the previous
 * `check-host-resource.cjs` - Desktop no longer bundles a host. The CLI
 * (single-file SEA, per platform/arch) is the only native asset Desktop
 * ships, staged into `resources/cli/` and mapped to `extraResources/cli/`.
 *
 * NP-7 publishes per-platform/arch binaries (`traycer-darwin-arm64`,
 * `traycer-win32-x64.exe`, ...). The desktop release workflows rename and
 * place each binary into a matching `resources/cli/<platform>-<arch>/`
 * directory so the renderer can resolve the binary for the current
 * `process.platform`/`process.arch` at runtime. The legacy flat layout
 * (`resources/cli/<traycer>`) stays accepted so local dev flows
 * (`make install-desktop`) that stage a single SEA binary continue to
 * work.
 *
 * Pass `--platform <darwin|linux|win32>` and `--arch <arm64|x64|...>`
 * (each can be repeated) to require specific platform/arch binaries
 * - release workflows pin the matrix they expect to ship. Without
 * those flags the precheck only verifies SOMETHING usable exists for
 * the current host (sufficient for `make install-desktop`).
 */

const {
  existsSync,
  statSync,
  readdirSync,
  readFileSync,
  accessSync,
  constants,
} = require("node:fs");
const { resolve, join } = require("node:path");

const CLI_DIR = resolve(__dirname, "..", "..", "resources", "cli");
const PLACEHOLDERS = new Set([".gitkeep", "README.md"]);
const VERSION_METADATA_FILENAME = "version.json";

function parseArgs(argv) {
  const platforms = [];
  const archs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--platform" && i + 1 < argv.length) {
      platforms.push(argv[i + 1]);
      i++;
    } else if (argv[i] === "--arch" && i + 1 < argv.length) {
      archs.push(argv[i + 1]);
      i++;
    }
  }
  return { platforms, archs };
}

function cliBinaryName(platform) {
  return platform === "win32" ? "traycer.exe" : "traycer";
}

function isExecutable(path) {
  let info;
  try {
    info = statSync(path);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;
  if (process.platform === "win32") {
    // Windows doesn't expose POSIX X_OK semantics - existence + isFile
    // (checked above) is the strongest we can do here.
    return true;
  }
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate the bundled CLI `version.json` staged next to the SEA binary.
 * Returns an empty string when the metadata is valid, otherwise a human-
 * readable failure reason that the caller surfaces in the matrix-mode
 * failure list. We accept any non-empty `version` string; the release
 * workflow writes the resolved `cli-v<version>` tag derivative and the
 * local installer writes a `0.0.0-local` sentinel - both are valid.
 */
function validateVersionMetadata(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return `version metadata missing at ${path}`;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return `version metadata is not valid JSON at ${path}`;
  }
  if (parsed === null || typeof parsed !== "object") {
    return `version metadata is not a JSON object at ${path}`;
  }
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    return `version metadata missing non-empty "version" field at ${path}`;
  }
  return "";
}

function fail(message) {
  console.error(
    `[desktop] ${message}\n` +
      `         Stage a CLI binary into ${CLI_DIR} (see clients/desktop/RELEASE.md)\n` +
      `         or run the release pipeline in CI (.github/workflows/release-desktop-*.yaml),\n` +
      `         which downloads the bundled CLI from the matching 'cli-v<version>' GitHub\n` +
      `         Release before invoking electron-builder.`,
  );
  process.exit(1);
}

if (!existsSync(CLI_DIR)) {
  fail(
    `CLI resource directory is missing at ${CLI_DIR}.\n` +
      `         The desktop build refuses to package without a bundled CLI binary.`,
  );
}

const { platforms, archs } = parseArgs(process.argv.slice(2));

// Explicit-matrix mode: every (platform, arch) pair must have a real
// executable at resources/cli/<platform>-<arch>/<binary> AND a sibling
// `version.json` so Desktop's `readBundledCliVersion()` resolves to the
// actual bundled release version instead of the `0.0.0-local` fallback.
// Release workflows drive this - both the rename step and the
// version-metadata staging must land before electron-builder runs.
if (platforms.length > 0 && archs.length > 0) {
  const problems = [];
  for (const p of platforms) {
    for (const a of archs) {
      const archDir = join(CLI_DIR, `${p}-${a}`);
      const binaryPath = join(archDir, cliBinaryName(p));
      if (!isExecutable(binaryPath)) {
        problems.push(`missing or non-executable binary: ${binaryPath}`);
        // Skip metadata check when the binary itself is absent - the
        // workflow has bigger problems and the metadata-missing message
        // would just be noise.
        continue;
      }
      const versionPath = join(archDir, VERSION_METADATA_FILENAME);
      const versionProblem = validateVersionMetadata(versionPath);
      if (versionProblem.length > 0) {
        problems.push(versionProblem);
      }
    }
  }
  if (problems.length > 0) {
    fail(
      `Release-matrix CLI staging failed validation:\n` +
        problems.map((m) => `         - ${m}`).join("\n"),
    );
  }
  console.log(
    `[desktop] CLI resource precheck ok - verified ${platforms.length * archs.length} platform/arch binar${
      platforms.length * archs.length === 1 ? "y" : "ies"
    } + version metadata under ${CLI_DIR}.`,
  );
  process.exit(0);
}

// Host-mode: at minimum the current host needs a usable binary. We check
// the arch-scoped layout first (NP-7), then fall back to the legacy flat
// layout (`make install-desktop` produces this).
const hostBinary = cliBinaryName(process.platform);
const archScoped = join(
  CLI_DIR,
  `${process.platform}-${process.arch}`,
  hostBinary,
);
const flat = join(CLI_DIR, hostBinary);
if (isExecutable(archScoped)) {
  console.log(
    `[desktop] CLI resource precheck ok - arch-scoped binary present at ${archScoped}.`,
  );
  process.exit(0);
}
if (isExecutable(flat)) {
  console.log(
    `[desktop] CLI resource precheck ok - flat-layout binary present at ${flat} (legacy dev layout).`,
  );
  process.exit(0);
}

// Neither layout had an executable binary for this host - surface what
// the directory does contain so the failure is debuggable.
let listing = "(empty)";
try {
  const entries = readdirSync(CLI_DIR, { withFileTypes: true })
    .filter((entry) => !PLACEHOLDERS.has(entry.name))
    .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`);
  if (entries.length > 0) listing = entries.join(", ");
} catch {
  // fall through - listing stays "(empty)".
}

fail(
  `No executable CLI binary found for ${process.platform}-${process.arch}.\n` +
    `         Looked at:\n` +
    `           - ${archScoped}\n` +
    `           - ${flat}\n` +
    `         Directory contents: ${listing}`,
);
