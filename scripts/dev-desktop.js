#!/usr/bin/env bun
// Dev orchestrator for `make dev-desktop` (OSS).
//
// Mirrors the internal `make dev-desktop` flow, but the Traycer host is
// DOWNLOADED from GitHub Releases instead of built from source — the
// Traycer Host and cloud backend are not part of this repo. The desktop runs
// against PRODUCTION: its baked config points at the real cloud, and the CLI
// provisions the real signed host release.
//
//   - Stages a dev CLI wrapper at `~/.traycer/cli/dev/bin/traycer` that
//     exec's `bun <repo>/clients/traycer-cli/src/index.ts "$@"`, so the OS
//     service plist resolves to a stable executable path (launchd's PATH is
//     minimal, so absolute paths are baked into the wrapper).
//   - Invokes `traycer host install [--release <version>]
//     --allow-self-invocation`. The CLI runs from source
//     (`config.environment === "dev"`), so it targets the dev slot
//     automatically: it downloads + verifies the released host, swaps the
//     dev install dir, writes `~/.traycer/host/dev/install/install.json`,
//     registers the dev OS service label (`ai.traycer.host.dev`), and starts
//     the host. With no `--release`, the CLI installs `latest`.
//   - Runs the HMR Electron shell + tails `~/.traycer/host/dev/host.log`
//     under `concurrently`.
//   - On Ctrl-C, runs `traycer host uninstall --all` so the dev install +
//     service are gone. `~/.traycer/` user data is preserved (no --purge);
//     any production host/CLI state in the prod slot is never touched.

"use strict";

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const CLI_ENTRY = path.join(
  REPO_ROOT,
  "clients",
  "traycer-cli",
  "src",
  "index.ts",
);
const DESKTOP_WORKSPACE = path.join(REPO_ROOT, "clients", "desktop");
const TRAYCER_HOME = path.join(os.homedir(), ".traycer");
const DEV_HOST_LOG = path.join(TRAYCER_HOME, "host", "dev", "host.log");
// Local, version-keyed cache of downloaded host archives so repeated
// `make dev-desktop` runs (the Ctrl-C teardown uninstalls the dev host) don't
// re-download the same release. Outside the repo tree, so `git clean` never
// nukes it and it's shared across worktrees. Each archive is installed via
// `host install --from`, which re-checks its sha256.
const HOST_ARCHIVE_CACHE_DIR = path.join(TRAYCER_HOME, "dev-host-cache");

// Shared dev wrapper layout — also consumed by the desktop's CLI discovery
// (`src/electron-main/cli/cli-discovery.ts`) + host-management IPC, so both
// sides stay in lockstep on where the staged wrapper lives. Defensive parse so
// a corrupt edit produces a clear error instead of an opaque `undefined.join`
// failure downstream.
const DEV_WRAPPER_PATHS_FILE = path.join(
  DESKTOP_WORKSPACE,
  "src",
  "electron-main",
  "cli",
  "dev-wrapper-paths.json",
);

function loadDevWrapperPaths(filePath) {
  let raw;
  try {
    raw = require(filePath);
  } catch (err) {
    throw new Error(
      `dev-wrapper-paths.json is malformed or unreadable at ${filePath}: ${err && err.message ? err.message : err}`,
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `dev-wrapper-paths.json is malformed at ${filePath}: not an object`,
    );
  }
  if (
    !Array.isArray(raw.segments) ||
    !raw.segments.every((s) => typeof s === "string" && s.length > 0)
  ) {
    throw new Error(
      `dev-wrapper-paths.json is malformed at ${filePath}: \`segments\` must be a non-empty array of non-empty strings`,
    );
  }
  if (typeof raw.filenamePosix !== "string" || raw.filenamePosix.length === 0) {
    throw new Error(
      `dev-wrapper-paths.json is malformed at ${filePath}: \`filenamePosix\` must be a non-empty string`,
    );
  }
  if (typeof raw.filenameWin32 !== "string" || raw.filenameWin32.length === 0) {
    throw new Error(
      `dev-wrapper-paths.json is malformed at ${filePath}: \`filenameWin32\` must be a non-empty string`,
    );
  }
  return raw;
}

const DEV_WRAPPER_PATHS = loadDevWrapperPaths(DEV_WRAPPER_PATHS_FILE);
const DEV_CLI_BIN_DIR = path.join(os.homedir(), ...DEV_WRAPPER_PATHS.segments);

function log(message) {
  console.log(`[dev-desktop] ${message}`);
}

// Quote a value for safe interpolation into a POSIX shell command (used when
// generating the wrapper shell script that embeds absolute paths).
function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Resolve a tool's shell-PATH binary to an absolute path. launchd's PATH is
// minimal (`/usr/bin:/bin:/usr/sbin:/sbin`), so anything Homebrew / nvm-managed
// must be resolved up front and baked into the wrapper we hand the service
// manager.
function resolveBinary(tool) {
  const cmd = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(cmd, [tool], { encoding: "utf8" });
  if (result.status !== 0) return tool;
  const first = String(result.stdout)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  return first ?? tool;
}

// Stage the dev CLI wrapper the OS service invokes as `traycer host start`
// (dev slot, baked from the source `config.environment`). Points at the
// source-tree CLI entry via bun so the dev loop needs no SEA build; baked
// absolute paths survive launchd's minimal PATH. Also exports `TRAYCER_CLI`
// (its own absolute path) so a host-spawned agent session resolves
// `${TRAYCER_CLI} monitor` absolutely instead of relying on a bare-`traycer`
// PATH lookup.
async function stageDevCliWrapper() {
  await fsp.mkdir(DEV_CLI_BIN_DIR, { recursive: true });
  const bunBin = resolveBinary("bun");
  const bunBinDir = path.dirname(bunBin);
  if (process.platform === "win32") {
    const wrapperPath = path.join(
      DEV_CLI_BIN_DIR,
      DEV_WRAPPER_PATHS.filenameWin32,
    );
    const q = (s) => s.replace(/"/g, '""');
    await fsp.writeFile(
      wrapperPath,
      [
        `@echo off`,
        `set "PATH=${q(bunBinDir)};%PATH%"`,
        `set "TRAYCER_CLI=${q(wrapperPath)}"`,
        `"${q(bunBin)}" "${q(CLI_ENTRY)}" %*`,
        ``,
      ].join("\r\n"),
      "utf8",
    );
    return wrapperPath;
  }
  const wrapperPath = path.join(
    DEV_CLI_BIN_DIR,
    DEV_WRAPPER_PATHS.filenamePosix,
  );
  await fsp.writeFile(
    wrapperPath,
    [
      `#!/bin/sh`,
      `export PATH=${shellEscape(bunBinDir)}:"$PATH"`,
      `export TRAYCER_CLI=${shellEscape(wrapperPath)}`,
      `exec ${shellEscape(bunBin)} ${shellEscape(CLI_ENTRY)} "$@"`,
      ``,
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
  return wrapperPath;
}

function ensureHostLog() {
  fs.mkdirSync(path.dirname(DEV_HOST_LOG), { recursive: true });
  if (!fs.existsSync(DEV_HOST_LOG)) {
    fs.closeSync(fs.openSync(DEV_HOST_LOG, "a"));
  }
}

// `--release <version>` pins a specific host release; omitted ⇒ the CLI
// installs `latest`. Exported so the unit test can pin the parse without
// spawning anything.
function parseReleaseArg(argv) {
  const tail = Array.isArray(argv) ? argv.slice(2) : [];
  const idx = tail.indexOf("--release");
  if (
    idx !== -1 &&
    typeof tail[idx + 1] === "string" &&
    tail[idx + 1].length > 0
  ) {
    return tail[idx + 1];
  }
  return null;
}

// Build the argv the orchestrator hands the CLI. The CLI runs from source
// (`config.environment === "dev"`), so every command targets the dev slot
// automatically — there is no flag to pass. `--allow-self-invocation` lets the
// unpackaged CLI register itself as the service command; the service resolves
// the wrapper we staged at `~/.traycer/cli/dev/bin/traycer`. Exported for the
// unit test to pin the command shape.
function buildHostInstallArgs(opts) {
  const releaseArgs = opts && opts.release ? ["--release", opts.release] : [];
  return [
    "run",
    CLI_ENTRY,
    "host",
    "install",
    ...releaseArgs,
    "--allow-self-invocation",
  ];
}

// `host install --from <archive>` installs a local archive (sha256-checked,
// minisign bypassed). Used after a cache hit so no network is touched.
function buildHostInstallFromArgs(archivePath) {
  return [
    "run",
    CLI_ENTRY,
    "host",
    "install",
    "--from",
    archivePath,
    "--allow-self-invocation",
  ];
}

// Path to any already-cached archive for `version`, or null. Matches by the
// per-version cache subdir so a pinned `--release` re-run resolves fully
// offline (the exact archive basename came from the manifest at download time).
function findCachedArchive(version) {
  const dir = path.join(HOST_ARCHIVE_CACHE_DIR, version);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const archive = entries.find((name) => /\.(tgz|tar\.gz|tar|zip)$/i.test(name));
  return archive === undefined ? null : path.join(dir, archive);
}

// Resolve a verified host archive for the target version from the local cache,
// downloading + caching it first on a miss. Reuses the CLI's registry client
// (bun imports the TS directly) so a freshly downloaded archive goes through the
// exact same sha256 + minisign verification as the normal `host install
// <version>` path - the cache only avoids re-downloading. Returns the archive
// path, or null to fall back to the plain network install (offline + uncached,
// an unknown version, or any resolution error - the cache must never break the
// dev flow).
async function resolveCachedHostArchive(release) {
  try {
    // Offline fast path: a pinned --release that's already cached needs no
    // network and no registry import at all.
    if (release) {
      const hit = findCachedArchive(release);
      if (hit !== null) {
        log(`using cached host ${release}`);
        return hit;
      }
    }

    const registry = await import(
      path.join(REPO_ROOT, "clients", "traycer-cli", "src", "registry", "index.ts")
    );
    const { config } = await import(
      path.join(REPO_ROOT, "clients", "traycer-cli", "src", "config.ts")
    );
    const client = await registry.createDefaultRegistryClient(
      config.environment,
    );
    const { entry, asset } = await client.resolveAsset(
      release ?? "latest",
      registry.currentHostPlatformKey(),
    );
    const version = entry.version;

    const hit = findCachedArchive(version);
    if (hit !== null) {
      log(`using cached host ${version}`);
      return hit;
    }

    log(`downloading host ${version} (not cached)…`);
    const { archivePath } = await client.downloadAndVerify(
      entry,
      asset,
      () => {},
    );
    const destDir = path.join(HOST_ARCHIVE_CACHE_DIR, version);
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, path.basename(archivePath));
    fs.copyFileSync(archivePath, dest);
    log(`cached host ${version} at ${dest}`);
    return dest;
  } catch (err) {
    log(
      `host archive cache unavailable (${err && err.message ? err.message : err}); using network install`,
    );
    return null;
  }
}

function buildHostUninstallArgs() {
  return ["run", CLI_ENTRY, "host", "uninstall", "--all"];
}

function runCli(args) {
  const result = spawnSync("bun", args, { stdio: "inherit", cwd: REPO_ROOT });
  return result.status ?? 1;
}

function resolveConcurrentlyBin() {
  const pkgPath = require.resolve("concurrently/package.json");
  const pkg = require(pkgPath);
  const binField = pkg && pkg.bin;
  const binRelative =
    typeof binField === "string"
      ? binField
      : binField && typeof binField.concurrently === "string"
        ? binField.concurrently
        : null;
  if (binRelative === null) {
    throw new Error(
      "could not resolve `concurrently` bin from its package.json — run `bun install` at the repo root",
    );
  }
  return path.resolve(path.dirname(pkgPath), binRelative);
}

// The HMR Electron shell + a follower on the dev host's log file. The desktop
// injects NO environment: it self-derives all dev wiring from its baked
// `config.environment` (`dev` in source) via `isDevBuild` — dev slot,
// renderer/tray/icon dirs, the Vite dev URL at localhost:5173 — and finds the
// dev CLI wrapper staged at `~/.traycer/cli/dev/bin`.
function buildDevDesktopEntries() {
  return [
    {
      name: "electron",
      color: "green",
      command: "bun run --cwd clients/desktop dev",
    },
    {
      name: "host",
      color: "gray",
      command: `tail -n 0 -F ${shellEscape(DEV_HOST_LOG)}`,
    },
  ];
}

// Spawn `concurrently` with the supplied stream entries, install signal
// forwarders, and exit when either the user hits Ctrl-C or a child dies. Calls
// `onTeardown` exactly once (signal path or exit/error path) before exiting.
function runConcurrentStack(options) {
  const entries = options.entries;
  const onTeardown = options.onTeardown;
  const cwd = options.cwd ?? REPO_ROOT;

  const names = entries.map((e) => e.name).join(",");
  const colors = entries.map((e) => e.color).join(",");
  const commands = entries.map((e) => e.command);
  const concurrentlyBin = resolveConcurrentlyBin();

  const child = spawn(
    process.execPath,
    [
      concurrentlyBin,
      "--kill-others",
      "--names",
      names,
      "--prefix-colors",
      colors,
      ...commands,
    ],
    { stdio: "inherit", cwd, env: process.env },
  );

  let tornDown = false;
  async function teardown() {
    if (tornDown) return;
    tornDown = true;
    if (typeof onTeardown !== "function") return;
    try {
      await onTeardown();
    } catch (err) {
      console.warn(
        `[dev-desktop] teardown error: ${err && err.message ? err.message : err}`,
      );
    }
  }

  const forwardSignal = (signal) => async () => {
    await teardown();
    if (!child.killed) {
      try {
        child.kill(signal);
      } catch (err) {
        console.warn(
          `[dev-desktop] failed to forward ${signal} to concurrently: ${err.message}`,
        );
      }
    }
  };

  process.on("SIGINT", forwardSignal("SIGINT"));
  process.on("SIGTERM", forwardSignal("SIGTERM"));
  process.on("SIGHUP", forwardSignal("SIGHUP"));

  child.on("exit", async (code, signal) => {
    await teardown();
    process.exit(signal !== null ? 1 : (code ?? 1));
  });

  child.on("error", async (err) => {
    console.error(
      `[dev-desktop] failed to launch concurrently: ${err.message}`,
    );
    await teardown();
    process.exit(1);
  });
}

async function main() {
  const release = parseReleaseArg(process.argv);

  // Stage the bun wrapper at the well-known per-environment bin path
  // (`~/.traycer/cli/dev/bin/traycer`). The CLI's service registration and the
  // desktop's CLI discovery both find it via the bin-dir convention — no flag
  // or env coupling.
  await stageDevCliWrapper();
  ensureHostLog();

  // Prefer a locally-cached (or freshly downloaded + cached) archive so
  // re-runs don't re-download the same release; fall back to the plain
  // registry install when the cache can't be resolved.
  const cachedArchive = await resolveCachedHostArchive(release);
  const args =
    cachedArchive !== null
      ? buildHostInstallFromArgs(cachedArchive)
      : buildHostInstallArgs({ release });
  log(
    cachedArchive !== null
      ? `installing host from cache: bun ${args.join(" ")}`
      : release
        ? `installing host release ${release}: bun ${args.join(" ")}`
        : `installing latest host release: bun ${args.join(" ")}`,
  );
  const status = runCli(args);
  if (status !== 0) {
    console.error(
      [
        ``,
        `[dev-desktop] traycer host install failed (exit ${status}).`,
        ``,
        `If it failed verifying the host signature, the downloaded release is`,
        `not signed by the trust root committed in`,
        `clients/traycer-cli/src/config.ts (host signing key id`,
        `847ef539119a1961). Confirm the published host release is signed with`,
        `the current key.`,
        ``,
      ].join("\n"),
    );
    process.exit(1);
    return;
  }
  log("dev host installed + service registered via CLI");

  runConcurrentStack({
    entries: buildDevDesktopEntries(),
    cwd: REPO_ROOT,
    onTeardown: async () => {
      // Deregister the dev host + service. Leaves ~/.traycer/ user data
      // (credentials, config) intact; the production slot was never touched.
      const code = runCli(buildHostUninstallArgs());
      if (code !== 0) {
        console.warn(
          `[dev-desktop] traycer host uninstall --all failed (exit ${code})`,
        );
      } else {
        log("dev host + service deregistered via CLI");
      }
    },
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[dev-desktop] fatal:", err);
    process.exit(1);
  });
}

module.exports = {
  buildHostInstallArgs,
  buildHostInstallFromArgs,
  buildHostUninstallArgs,
  buildDevDesktopEntries,
  parseReleaseArg,
  findCachedArchive,
  CLI_ENTRY,
  DEV_CLI_BIN_DIR,
  DEV_HOST_LOG,
  HOST_ARCHIVE_CACHE_DIR,
};
