#!/usr/bin/env bun
// Dev orchestrator for `make dev-desktop` (oss).
// Mirrors the internal `make dev-desktop` flow, but the Traycer host is downloaded from GitHub Releases instead of built from source - the Traycer Host and cloud backend are not part of this repo.

"use strict";

const crypto = require("node:crypto");
const net = require("node:net");
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
// Local, version-keyed cache of downloaded host archives so repeated `make dev-desktop` runs (the Ctrl-C teardown uninstalls the dev host) don't re-download the same release.
// Outside the repo tree, so `git clean` never nukes it and it's shared across worktrees.
const HOST_ARCHIVE_CACHE_DIR = path.join(TRAYCER_HOME, "dev-host-cache");

// Multi-run: each worktree's `make dev-desktop` gets its own dev slot, derived deterministically from the repo root (or overridden via `--slot` / `DEV_DESKTOP_SLOT`).
// This script is the one piece that never set it, so every `make dev-desktop` run on a machine collided on one shared dev CLI wrapper, one shared dev host install/service, and one fixed renderer port (5173, `strictPort`).
const DEV_PORT_RANGE_START = 19000;
const DEV_PORT_RANGE_SIZE = 4000;
const DEV_PORT_SCAN_LIMIT = 50;

function stableHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

// `--slot <name>` overrides the derived default; exported for the unit test
// to pin the parse without spawning anything.
function parseSlotArg(argv) {
  const tail = Array.isArray(argv) ? argv.slice(2) : [];
  const idx = tail.indexOf("--slot");
  if (
    idx !== -1 &&
    typeof tail[idx + 1] === "string" &&
    tail[idx + 1].length > 0
  ) {
    return tail[idx + 1];
  }
  return null;
}

async function loadDevDesktopSlotModule() {
  return import(
    path.join(REPO_ROOT, "clients", "shared", "platform", "dev-desktop-slot.ts")
  );
}

// `--slot` / `DEV_DESKTOP_SLOT` win when present; otherwise derive deterministically from the repo root so the same worktree always resolves to the same slot (and a different worktree never collides with it).
async function resolveDevDesktopSlot(argv, env) {
  const { sanitizeDevDesktopSlot, DEV_DESKTOP_SLOT_ENV } =
    await loadDevDesktopSlotModule();
  const requested =
    parseSlotArg(argv) ??
    (typeof env[DEV_DESKTOP_SLOT_ENV] === "string"
      ? env[DEV_DESKTOP_SLOT_ENV]
      : null);
  const basename =
    sanitizeDevDesktopSlot(path.basename(REPO_ROOT)) || "worktree";
  const defaultSlot = `${basename}-${stableHash(REPO_ROOT).slice(0, 8)}`;
  const slot = sanitizeDevDesktopSlot(requested ?? defaultSlot);
  if (slot.length === 0) {
    throw new Error(
      `dev desktop slot resolved to an empty value; set ${DEV_DESKTOP_SLOT_ENV} or --slot to a non-empty name`,
    );
  }
  return slot;
}

// Single dynamically-allocated port for the Electron renderer's Vite dev server (`vite.renderer.config.ts` sets `strictPort: true`, so a fixed 5173 would make every worktree but the first fail outright).
function preferredPortForSlot(slot) {
  const availableBaseSpan = DEV_PORT_RANGE_SIZE - DEV_PORT_SCAN_LIMIT;
  const hash = parseInt(stableHash(slot).slice(0, 8), 16);
  return DEV_PORT_RANGE_START + (hash % availableBaseSpan);
}

function canListenOnPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close(() => {
        resolve(true);
      });
    });
    server.listen({ port, host: "0.0.0.0", exclusive: true });
  });
}

async function findAvailablePort(preferredPort) {
  for (let offset = 0; offset < DEV_PORT_SCAN_LIMIT; offset += 1) {
    const port = preferredPort + offset;
    if (await canListenOnPort(port)) {
      return port;
    }
  }
  throw new Error(
    `could not find an available port near ${preferredPort} after ${DEV_PORT_SCAN_LIMIT} attempts`,
  );
}

// Shared dev wrapper layout - also consumed by the desktop's CLI discovery (`src/electron-main/cli/cli-discovery.ts`) + host-management IPC, so both sides stay in lockstep on where the staged wrapper lives.
// Defensive parse so a corrupt edit produces a clear error instead of an opaque `undefined.join` failure downstream.
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

function log(message) {
  console.log(`[dev-desktop] ${message}`);
}

// Quote a value for safe interpolation into a POSIX shell command (used when
// generating the wrapper shell script that embeds absolute paths).
function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Cross-platform pid-liveness probe (mirrors the CLI's own `store/cli-lock.ts` probe and the internal orchestrator's copy).
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err) && err.code === "EPERM";
  }
}

// The host's own pid metadata (written by the running host process itself, not by this script) in this run's host home dir - the authoritative "is a host actually alive for this slot" signal.
// Returns null (no guard, safe to proceed) for any missing/malformed file rather than throwing, so a stale or half-written pid.json never blocks a legitimate run.
function readHostPidMetadata(hostHome) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(hostHome, "pid.json"), "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !Number.isInteger(parsed.pid)
  ) {
    return null;
  }
  return parsed;
}

// Realistic collision this guards against: a second `make dev-desktop` run in the same worktree, without an explicit `--slot`, derives the identical default slot as an already-running instance.
// Without this check, the second run's install races the first's, and its Ctrl-C teardown then runs `host uninstall --all` for that slot - deregistering the first run's host, not its own.
function assertSlotNotActive(slot, hostHome) {
  const existing = readHostPidMetadata(hostHome);
  if (existing !== null && isProcessAlive(existing.pid)) {
    throw new Error(
      `a dev-desktop run is already active for slot "${slot}" (host pid ${existing.pid}). Stop it first (Ctrl-C in that terminal), or pass --slot <name> to start a second instance from this worktree.`,
    );
  }
}

// Resolve a tool's shell-path binary to an absolute path.
// launchd's path is minimal (`/usr/bin:/bin:/usr/sbin:/sbin`), so anything Homebrew / nvm-managed must be resolved up front and baked into the wrapper we hand the service manager.
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

// Stage the dev CLI wrapper the OS service invokes as `traycer host start` (dev slot, baked from the source `config.environment`).
async function stageDevCliWrapper(cliBinDir, slot) {
  await fsp.mkdir(cliBinDir, { recursive: true });
  const bunBin = resolveBinary("bun");
  const bunBinDir = path.dirname(bunBin);
  if (process.platform === "win32") {
    const wrapperPath = path.join(cliBinDir, DEV_WRAPPER_PATHS.filenameWin32);
    const q = (s) => s.replace(/"/g, '""');
    await fsp.writeFile(
      wrapperPath,
      [
        `@echo off`,
        `set "PATH=${q(bunBinDir)};%PATH%"`,
        `set "TRAYCER_CLI=${q(wrapperPath)}"`,
        `set "DEV_DESKTOP_SLOT=${q(slot)}"`,
        `"${q(bunBin)}" "${q(CLI_ENTRY)}" %*`,
        ``,
      ].join("\r\n"),
      "utf8",
    );
    return wrapperPath;
  }
  const wrapperPath = path.join(cliBinDir, DEV_WRAPPER_PATHS.filenamePosix);
  await fsp.writeFile(
    wrapperPath,
    [
      `#!/bin/sh`,
      `export PATH=${shellEscape(bunBinDir)}:"$PATH"`,
      `export TRAYCER_CLI=${shellEscape(wrapperPath)}`,
      `export DEV_DESKTOP_SLOT=${shellEscape(slot)}`,
      `exec ${shellEscape(bunBin)} ${shellEscape(CLI_ENTRY)} "$@"`,
      ``,
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
  return wrapperPath;
}

function ensureHostLog(hostLogPath) {
  fs.mkdirSync(path.dirname(hostLogPath), { recursive: true });
  // Opening in append mode creates the file if it's absent and is a no-op
  // otherwise, so there's no need (and no safe way) to existsSync-then-create.
  fs.closeSync(fs.openSync(hostLogPath, "a"));
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
  const archive = entries.find((name) =>
    /\.(tgz|tar\.gz|tar|zip)$/i.test(name),
  );
  return archive === undefined ? null : path.join(dir, archive);
}

// Resolve a verified host archive from the local cache (same sha256 + minisign as `host install`). Null falls back to network install; the cache must never break the dev flow.
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
      path.join(
        REPO_ROOT,
        "clients",
        "traycer-cli",
        "src",
        "registry",
        "index.ts",
      )
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

function runCli(args, env) {
  const result = spawnSync("bun", args, {
    stdio: "inherit",
    cwd: REPO_ROOT,
    env,
  });
  return result.status ?? 1;
}

// Merged into `process.env` (never mutating it directly) at every CLI
// subprocess spawn, so `traycer host install`/`uninstall` resolve their own
// per-slot install/lock paths (`store/paths.ts`) and service label
// (`service/label.ts`) for THIS run, without this orchestrator process's own
// environment ever carrying a stale slot value across calls.
function buildDevDesktopSlotEnv(slot) {
  return { ...process.env, DEV_DESKTOP_SLOT: slot };
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
// self-derives its dev-slot identity (userData dir, single-instance lock,
// CLI discovery paths) from `DEV_DESKTOP_SLOT` via `isDevBuild` +
// `resolveDesktopRuntimeIdentity` — this orchestrator only needs to hand it
// the slot and the renderer's allocated port (`clients/desktop/scripts/dev/
// dev-stack.cjs` derives `TRAYCER_DESKTOP_DEV_URL` from `PORT` itself).
function buildDevDesktopEntries(hostLogPath, slot, port) {
  return [
    {
      name: "electron",
      color: "green",
      command: `DEV_DESKTOP_SLOT=${shellEscape(slot)} PORT=${shellEscape(String(port))} bun run --cwd clients/desktop dev`,
    },
    {
      name: "host",
      color: "gray",
      command: `tail -n 0 -F ${shellEscape(hostLogPath)}`,
    },
  ];
}

// Collapse every shutdown trigger (terminal signal, child exit, spawn error)
// onto one promise. A boolean-only guard lets later triggers return while the
// first async teardown is still running; their process.exit() can then cut the
// host uninstall short and leave the slot's host alive for the next launch.
function createTeardown(onTeardown) {
  let teardownPromise = null;
  return function teardown() {
    if (teardownPromise !== null) return teardownPromise;
    teardownPromise = (async () => {
      if (typeof onTeardown !== "function") return;
      try {
        await onTeardown();
      } catch (err) {
        console.warn(
          `[dev-desktop] teardown error: ${err && err.message ? err.message : err}`,
        );
      }
    })();
    return teardownPromise;
  };
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

  const teardown = createTeardown(onTeardown);

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

  // Resolve this run's slot once and set it ambiently: the CLI path helpers
  // dynamically imported below (`cliInstallHomeDir`/`hostLogPath`) read
  // `DEV_DESKTOP_SLOT` off `process.env` themselves (no override parameter),
  // same as every other slot-aware consumer (`cli-discovery.ts`,
  // `service/label.ts`). This process only ever resolves one slot for its
  // whole lifetime, so setting it once here is safe.
  const slot = await resolveDevDesktopSlot(process.argv, process.env);
  process.env.DEV_DESKTOP_SLOT = slot;
  log(`run slot: ${slot}`);

  const { config } = await import(
    path.join(REPO_ROOT, "clients", "traycer-cli", "src", "config.ts")
  );
  const { cliInstallHomeDir, hostLogPath } = await import(
    path.join(REPO_ROOT, "clients", "traycer-cli", "src", "store", "paths.ts")
  );
  const cliBinDir = path.join(cliInstallHomeDir(config.environment), "bin");
  const hostLog = hostLogPath(config.environment);
  const hostHome = path.dirname(hostLog);

  assertSlotNotActive(slot, hostHome);

  const port = await findAvailablePort(preferredPortForSlot(slot));
  log(`renderer port: ${port}`);

  // Stage the bun wrapper at this run's slot-scoped bin path. The CLI's
  // service registration and the desktop's CLI discovery both find it via
  // the bin-dir convention — no flag or env coupling.
  await stageDevCliWrapper(cliBinDir, slot);
  ensureHostLog(hostLog);

  const slotEnv = buildDevDesktopSlotEnv(slot);

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
  const status = runCli(args, slotEnv);
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
    entries: buildDevDesktopEntries(hostLog, slot, port),
    cwd: REPO_ROOT,
    onTeardown: async () => {
      // Deregister the dev host + service. Leaves ~/.traycer/ user data
      // (credentials, config) intact; the production slot was never touched.
      const code = runCli(buildHostUninstallArgs(), slotEnv);
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
  buildDevDesktopSlotEnv,
  createTeardown,
  parseReleaseArg,
  parseSlotArg,
  resolveDevDesktopSlot,
  preferredPortForSlot,
  findCachedArchive,
  isProcessAlive,
  readHostPidMetadata,
  assertSlotNotActive,
  CLI_ENTRY,
  HOST_ARCHIVE_CACHE_DIR,
};
