import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, platform } from "node:os";
import { delimiter, dirname, join, parse } from "node:path";
import { config, isDevBuild } from "../../config";
import { compareHostVersions as compareHostSemanticVersions } from "@traycer-clients/shared/platform/runner-host";
import { environmentSubdir } from "../host/host-paths";
import { devDesktopSlotForEnvironment } from "../host/dev-desktop-slot";
import { log } from "../app/logger";
import devWrapperPaths from "./dev-wrapper-paths.json";

/**
 * Stable per-user CLI install layout (Tech Plan Decision 6 / Data Model),
 * environment-scoped to match the CLI package's `store/paths.ts`:
 *
 *   production → ~/.traycer/cli/         (no suffix)
 *   dev        → ~/.traycer/cli/dev/
 *   dev run    → ~/.traycer/cli/dev-runs/<slot>/ when DEV_DESKTOP_SLOT is set
 *   staging    → ~/.traycer/cli/staging/
 *
 *   <slot>/manifest.json   - install record written by Desktop / CLI / package manager
 *   <slot>/bin/traycer     - stable per-user CLI binary the service manifest points at
 *
 * Both Desktop and the CLI install commands resolve the SAME install paths, so
 * the Desktop's view of `~/.traycer/cli/` stays in lockstep with the CLI's own
 * and a dev Desktop never reads the prod slot's manifest. In multi-run dev,
 * the env-propagated run slot selects the per-run install surface while shared
 * CLI config/credentials remain in the normal dev home.
 */
const TRAYCER_HOME = join(homedir(), ".traycer");
const CLI_HOME = join(TRAYCER_HOME, "cli");

// Resolved on every call (not cached at module load) so a value read before
// `DEV_DESKTOP_SLOT` is set in a test - or, in principle, before Electron's
// startup sequence has fully populated `process.env` - can never linger
// stale for the rest of the process. `config.environment` and
// `DEV_DESKTOP_SLOT` are both fixed for the lifetime of a real process, so
// this has no runtime behavior difference outside tests - it only removes
// the load-order hazard.
function resolveCliSlotHome(): string {
  const devDesktopSlot = devDesktopSlotForEnvironment(
    config.environment,
    process.env,
  );
  return devDesktopSlot === null
    ? environmentSubdir(CLI_HOME, config.environment)
    : join(CLI_HOME, "dev-runs", devDesktopSlot);
}

function resolveCliBinDir(): string {
  return join(resolveCliSlotHome(), "bin");
}

// The CLI upgrade temp/extract area (staged-binary swap), kept distinct from
// the slot root. Named "upgrade-staging" for clarity.
function resolveCliStagingDir(): string {
  return join(resolveCliSlotHome(), "upgrade-staging");
}

function resolveCliManifestPath(): string {
  return join(resolveCliSlotHome(), "manifest.json");
}

function resolveDesktopReconcileStatePath(): string {
  return join(resolveCliSlotHome(), "desktop-reconcile.json");
}

export function cliManifestPath(): string {
  return resolveCliManifestPath();
}

/**
 * Path to the Desktop-owned launch-time reconcile sidecar. The renderer
 * `cliManifest()` IPC merges this into the manifest snapshot so the UI can
 * surface package-manager-owned upgrade hints without Desktop writing into
 * an installer-owned manifest file.
 */
export function desktopReconcileStatePath(): string {
  return resolveDesktopReconcileStatePath();
}

export function cliBinDir(): string {
  return resolveCliBinDir();
}

export function stableCliBinaryPath(): string {
  return join(resolveCliBinDir(), cliBinaryName());
}

export function cliStagingDir(): string {
  return resolveCliStagingDir();
}

/**
 * Copy the bundled CLI binary into a writable Desktop-owned staging area
 * (`~/.traycer/cli/staging/traycer-<version>(.exe)`) so the launch-time
 * reconcile can record a real `pendingUpgrade.stagedBinaryPath` that does
 * not point at packaged app resources or the live (locked) binary. Throws
 * if either the copy itself or the chmod step fails - callers fall back to
 * an upgrade-blocked outcome and skip persisting `pendingUpgrade`.
 */
export async function stageBundledCliForUpgrade(opts: {
  readonly bundledCliPath: string;
  readonly version: string;
}): Promise<string> {
  await mkdir(resolveCliStagingDir(), { recursive: true, mode: 0o755 });
  const base = cliBinaryName();
  const ext = platform() === "win32" ? ".exe" : "";
  const sanitized = opts.version.replace(/[^A-Za-z0-9._-]/g, "_");
  // Embed platform/arch in the staged filename so two staged binaries for
  // different runtimes never collide in `~/.traycer/cli/staging/`. The
  // upgrade rename target (`stableCliBinaryPath`) is platform-native, so
  // the staged copy must be too - `<name>-<version>-<platform>-<arch>[.exe]`.
  const fileName = `${parse(base).name}-${sanitized}-${process.platform}-${process.arch}${ext}`;
  const stagedPath = join(resolveCliStagingDir(), fileName);
  await copyFile(opts.bundledCliPath, stagedPath);
  if (platform() !== "win32") {
    await chmod(stagedPath, 0o755);
  }
  return stagedPath;
}

export function cliBinaryName(): string {
  return platform() === "win32" ? "traycer.exe" : "traycer";
}

/**
 * Platform/arch directory name used by the bundled-CLI staging layout
 * (`resources/cli/<platform>-<arch>/`). NP-7 publishes per-arch binaries
 * (`traycer-darwin-arm64`, `traycer-win32-x64.exe`, ...) and the desktop
 * release workflows rename + stage each one into its arch directory so a
 * universal/multi-arch desktop bundle still has the right binary to run
 * for the current process.
 */
export function bundledCliArchDir(): string {
  return `${process.platform}-${process.arch}`;
}

const BUNDLED_CLI_VERSION_FILENAME = "version.json";
const BUNDLED_CLI_LOCAL_VERSION = "0.0.0-local";

/**
 * Read the bundled CLI version metadata staged next to the CLI binary.
 * The version file lives in the same directory as the binary itself, so
 * we derive its location from {@link resolveBundledCliPath} - that is the
 * single resolver for the bundled-CLI location (release workflows stage
 * the binary under `<resources>/cli/<platform>-<arch>/`, or under the
 * legacy flat `<resources>/cli/`, and the version marker sits beside it).
 *
 * Returns `0.0.0-local` when no metadata file is present - local dev
 * builds stage the SEA binary without a version marker and we don't want
 * a missing file to break newest-wins reconciliation.
 */
export async function readBundledCliVersion(): Promise<string> {
  const bundledPath = await resolveBundledCliPath();
  if (bundledPath !== null) {
    const versionFile = join(
      dirname(bundledPath),
      BUNDLED_CLI_VERSION_FILENAME,
    );
    const parsed = await parseBundledVersionFile(versionFile);
    if (parsed !== null) return parsed;
  }
  return BUNDLED_CLI_LOCAL_VERSION;
}

async function parseBundledVersionFile(path: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn("[cli] bundled CLI version.json is not valid JSON", { path });
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.version !== "string" || obj.version.length === 0) return null;
  return obj.version;
}

/**
 * Shape of `~/.traycer/cli/manifest.json` per the Tech Plan data model.
 * Desktop only reads `version` and `binaryPath`; the rest is preserved
 * verbatim when the manifest is rewritten so external installers
 * (Homebrew / npm / winget / scoop / apt / rpm) can keep their own
 * source metadata without Desktop clobbering it.
 */
export interface CliInstallManifest {
  readonly version: string;
  readonly installedAt: string;
  readonly binaryPath: string;
  readonly source:
    | "desktop"
    | "homebrew"
    | "npm"
    | "winget"
    | "scoop"
    | "apt"
    | "rpm"
    | "manual";
  readonly pendingUpgrade: {
    readonly version: string;
    readonly stagedBinaryPath: string;
    readonly stagedAt: string;
    readonly reason: "binary-locked" | "awaiting-service-restart";
  } | null;
}

/**
 * Result of running CLI discovery. `kind` discriminates the source so
 * downstream callers can decide whether to surface PATH onboarding
 * (Flow 1) or kick off self-heal.
 */
export type CliDiscoveryResult =
  | {
      readonly kind: "manifest";
      readonly binaryPath: string;
      readonly version: string;
    }
  | {
      readonly kind: "path";
      readonly binaryPath: string;
      readonly version: string | null;
      readonly source?: "npm";
    }
  | {
      readonly kind: "bundled";
      readonly binaryPath: string;
    }
  | { readonly kind: "none" };

/**
 * Read the per-user CLI install manifest. Returns `null` if absent or
 * malformed. We never throw - the caller falls through to PATH / bundled
 * discovery, and self-heal writes a fresh manifest from the bundled CLI.
 */
export async function readCliManifest(): Promise<CliInstallManifest | null> {
  let raw: string;
  try {
    raw = await readFile(resolveCliManifestPath(), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn("[cli] install manifest is not valid JSON", {
      path: resolveCliManifestPath(),
    });
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.version !== "string" ||
    typeof obj.binaryPath !== "string" ||
    typeof obj.installedAt !== "string"
  ) {
    log.warn("[cli] install manifest has invalid shape", {
      path: resolveCliManifestPath(),
    });
    return null;
  }
  const source = typeof obj.source === "string" ? obj.source : "manual";
  return {
    version: obj.version,
    installedAt: obj.installedAt,
    binaryPath: obj.binaryPath,
    source: source as CliInstallManifest["source"],
    pendingUpgrade: parsePendingUpgradeField(obj.pendingUpgrade),
  };
}

function parsePendingUpgradeField(
  value: unknown,
): CliInstallManifest["pendingUpgrade"] {
  if (value === null || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (
    typeof obj.version !== "string" ||
    typeof obj.stagedBinaryPath !== "string" ||
    typeof obj.stagedAt !== "string"
  ) {
    return null;
  }
  const reason =
    obj.reason === "binary-locked" || obj.reason === "awaiting-service-restart"
      ? obj.reason
      : "binary-locked";
  return {
    version: obj.version,
    stagedBinaryPath: obj.stagedBinaryPath,
    stagedAt: obj.stagedAt,
    reason,
  };
}

/**
 * Persist a `pendingUpgrade` marker on the existing CLI install manifest.
 * Used by Desktop's launch-time reconciliation when it can't atomically
 * replace a Desktop-owned older CLI (e.g. Windows EBUSY). Preserves every
 * other field so installer-written metadata is not clobbered. Returns the
 * updated manifest, or `null` when no caller-supplied baseline is provided
 * and no manifest exists on disk.
 *
 * Callers should pass the manifest they already have in scope when known
 * (e.g. cli-reconcile already loads it) so we don't re-read and re-parse
 * on every reconcile.
 */
export async function writeCliManifestPendingUpgrade(
  pending: NonNullable<CliInstallManifest["pendingUpgrade"]>,
  existingManifest: CliInstallManifest | null,
): Promise<CliInstallManifest | null> {
  const existing = existingManifest ?? (await readCliManifest());
  if (existing === null) return null;
  const next: CliInstallManifest = { ...existing, pendingUpgrade: pending };
  await mkdir(dirname(resolveCliManifestPath()), { recursive: true });
  await writeFile(
    resolveCliManifestPath(),
    JSON.stringify(next, null, 2),
    "utf8",
  );
  return next;
}

/**
 * Desktop-owned launch reconcile sidecar. Captures the package-manager
 * upgrade hint for the most recent `reconcileCli` outcome when the
 * installed CLI is owned by a package manager and is older than the
 * bundled CLI. We deliberately do NOT write this into the manifest itself
 * - the manifest is owned by the package manager. The
 * `host-management-ipc.ts` handler merges this sidecar into the
 * snapshot returned to the renderer.
 */
export interface DesktopReconcileState {
  readonly packageManagerUpgrade: {
    readonly source: "homebrew" | "npm" | "winget" | "scoop" | "apt" | "rpm";
    readonly installedVersion: string;
    readonly bundledVersion: string;
    readonly upgradeCommand: string;
    readonly recordedAt: string;
  } | null;
}

export async function readDesktopReconcileState(): Promise<DesktopReconcileState | null> {
  let raw: string;
  try {
    raw = await readFile(resolveDesktopReconcileStatePath(), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn("[cli] desktop reconcile state is not valid JSON", {
      path: resolveDesktopReconcileStatePath(),
    });
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const pkg = obj.packageManagerUpgrade;
  if (pkg === null || typeof pkg !== "object") {
    return { packageManagerUpgrade: null };
  }
  const pkgObj = pkg as Record<string, unknown>;
  const source = pkgObj.source;
  if (
    source !== "homebrew" &&
    source !== "npm" &&
    source !== "winget" &&
    source !== "scoop" &&
    source !== "apt" &&
    source !== "rpm"
  ) {
    return { packageManagerUpgrade: null };
  }
  if (
    typeof pkgObj.installedVersion !== "string" ||
    typeof pkgObj.bundledVersion !== "string" ||
    typeof pkgObj.upgradeCommand !== "string" ||
    typeof pkgObj.recordedAt !== "string"
  ) {
    return { packageManagerUpgrade: null };
  }
  return {
    packageManagerUpgrade: {
      source,
      installedVersion: pkgObj.installedVersion,
      bundledVersion: pkgObj.bundledVersion,
      upgradeCommand: pkgObj.upgradeCommand,
      recordedAt: pkgObj.recordedAt,
    },
  };
}

export async function writeDesktopReconcileState(
  state: DesktopReconcileState,
): Promise<void> {
  await mkdir(dirname(resolveDesktopReconcileStatePath()), { recursive: true });
  await writeFile(
    resolveDesktopReconcileStatePath(),
    JSON.stringify(state, null, 2),
    "utf8",
  );
}

/**
 * Locate a `traycer` executable on the user's PATH. Returns `null` when
 * not found.
 */
export async function findCliOnPath(): Promise<string | null> {
  const pathEnv = process.env.PATH;
  if (typeof pathEnv !== "string" || pathEnv.length === 0) return null;
  const binary = cliBinaryName();
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, binary);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function isNpmCliPackagePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return normalized.includes("/node_modules/@traycerai/cli/");
}

async function inferNpmPathSource(
  binaryPath: string,
): Promise<"npm" | undefined> {
  if (isNpmCliPackagePath(binaryPath)) return "npm";
  try {
    const resolved = await realpath(binaryPath);
    return isNpmCliPackagePath(resolved) ? "npm" : undefined;
  } catch {
    return undefined;
  }
}

export async function probeCliVersion(
  binaryPath: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      binaryPath,
      ["--version"],
      { timeout: 2_000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const text = String(stdout).trim();
        const match = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(text);
        resolve(match?.[1] ?? null);
      },
    );
  });
}

/**
 * Absolute path to the CLI binary bundled inside the desktop app's
 * `extraResources/cli/`. NP-7 publishes per-platform/arch binaries; the
 * desktop release workflows stage each one into a matching
 * `cli/<platform>-<arch>/` directory (e.g. `cli/darwin-arm64/traycer`,
 * `cli/win32-x64/traycer.exe`), so a universal/multi-arch desktop bundle
 * can still resolve the correct binary for the current process.
 *
 * Resolution:
 *   - Dev (unpackaged): the `make dev-desktop` orchestrator stages a CLI
 *     wrapper under this run's computed CLI bin dir.
 *   - Packaged: `<resourcesPath>/cli/<platform>-<arch>/<cliBinaryName>`
 *     (NP-7 layout), then `<resourcesPath>/cli/<cliBinaryName>` (legacy flat).
 */
export async function resolveBundledCliPath(): Promise<string | null> {
  if (isDevBuild) {
    const wrapper = devCliWrapperPath();
    return (await isExecutable(wrapper)) ? wrapper : null;
  }
  const binary = cliBinaryName();
  const archDir = bundledCliArchDir();
  const archScoped = join(process.resourcesPath, "cli", archDir, binary);
  if (await isExecutable(archScoped)) return archScoped;
  const flat = join(process.resourcesPath, "cli", binary);
  return (await isExecutable(flat)) ? flat : null;
}

// The dev CLI wrapper path in this run's CLI bin dir.
function devCliWrapperPath(): string {
  const filename =
    process.platform === "win32"
      ? devWrapperPaths.filenameWin32
      : devWrapperPaths.filenamePosix;
  return join(resolveCliBinDir(), filename);
}

/**
 * Resolve the CLI binary Desktop should invoke for subprocess calls.
 *
 * Order in packaged builds:
 *   1. CLI manifest (`<slot>/manifest.json`).
 *   2. `traycer` on PATH.
 *   3. Bundled CLI (`extraResources/cli/<platform>-<arch>/`).
 *   4. None - caller surfaces the first-launch / Doctor recovery path.
 *
 * Dev builds skip the PATH lookup. The dev orchestrator
 * (`scripts/dev-desktop.js`) deliberately stages a wrapper in this run's CLI
 * bin dir that execs the source-tree CLI entry through bun, and that wrapper
 * is what every dev surface (OS service registration, manual CLI invocations
 * from the desktop) is expected to call. A dev workspace inevitably has
 * `node_modules/.bin/traycer` on PATH (bun's bin hoisting), and falling
 * through PATH first would pick the package symlink ahead of the staged
 * wrapper - not what `make dev-desktop` set up, and not the path the service
 * manifest registers. Skipping PATH in dev keeps every CLI call in lockstep
 * with the orchestrator's staging.
 *
 * The paths above are install-surface scoped (`CLI_SLOT_HOME`), so a
 * multi-run dev shell reads its own `~/.traycer/cli/dev-runs/<slot>/...`
 * manifest while keeping shared dev credentials/config outside the run slot.
 *
 * "PATH CLI newer than bundled, trust it" is handled by the caller
 * after a version probe (packaged-build flow); this discovery layer simply
 * returns the most-authoritative source it can find.
 */
export async function discoverCli(): Promise<CliDiscoveryResult> {
  const manifest = await readCliManifest();
  if (manifest !== null && (await isExecutable(manifest.binaryPath))) {
    return {
      kind: "manifest",
      binaryPath: manifest.binaryPath,
      version: manifest.version,
    };
  }
  if (isDevBuild) {
    const bundled = await resolveBundledCliPath();
    if (bundled !== null) {
      return { kind: "bundled", binaryPath: bundled };
    }
    return { kind: "none" };
  }
  // PATH trust is production-only. A `traycer` on PATH carries its OWN baked
  // deploy slot (`config.environment`), so adopting a PATH binary for a
  // non-production build lets a released/prod CLI on the user's PATH (Homebrew,
  // `~/.traycer/cli/bin`) hijack a staging install onto the PRODUCTION host slot
  // (prod cloud, `~/.traycer/host/install`, `ai.traycer.host`). Non-production
  // non-dev slots (e.g. internal `staging`) use their bundled/slot CLI - the
  // same reason the dev slot skips PATH above.
  if (config.environment === "production") {
    const pathCli = await findCliOnPath();
    if (pathCli !== null) {
      const source = await inferNpmPathSource(pathCli);
      const version = source === "npm" ? await probeCliVersion(pathCli) : null;
      return {
        kind: "path",
        binaryPath: pathCli,
        version,
        ...(source !== undefined ? { source } : {}),
      };
    }
  }
  const bundled = await resolveBundledCliPath();
  if (bundled !== null) {
    return { kind: "bundled", binaryPath: bundled };
  }
  return { kind: "none" };
}

/**
 * Stage the bundled CLI into the stable per-user path and write a fresh
 * manifest pointing at it. Used both during first-launch setup and as a
 * silent self-heal step when the installed CLI is missing or corrupt.
 *
 * On POSIX we **symlink** the stable path at the bundled CLI rather than
 * copying it: the stable path (`~/.traycer/cli[/<slot>]/bin/traycer`) is then
 * a space-free, home-relative name the bundle-blind host can put on PATH,
 * while always resolving to the single, version-matched binary inside the
 * .app - no second copy to drift, corrupt, or go stale on app update. The
 * .app's path may contain spaces ("Traycer Staging.app"); that's fine as a
 * symlink target and as a PATH entry, since command resolution doesn't
 * re-split a resolved path. Windows symlinks need privilege we can't assume,
 * so there we fall back to a copy (the home path is space-free anyway).
 *
 * Returns the stable path, or throws if the bundled CLI isn't present (a
 * packaging bug worth surfacing loudly).
 */
export async function installBundledCli(opts: {
  readonly bundledCliPath: string;
  readonly version: string;
  readonly source: CliInstallManifest["source"];
}): Promise<string> {
  await mkdir(resolveCliBinDir(), { recursive: true, mode: 0o755 });
  const stablePath = stableCliBinaryPath();
  if (platform() === "win32") {
    // The slot binary is essentially ALWAYS running on Windows - the host's
    // Scheduled Task launcher (`traycer host start`) executes from this exact
    // path and restarts at every logon, so `rm` would hit the running-image
    // delete lock and permanently wedge the upgrade in the `pendingUpgrade
    // (binary-locked)` loop. Windows does allow RENAMING a running image, so
    // move it aside and copy the new binary into the now-free name; the live
    // supervisor keeps executing the renamed image and the next host start
    // picks up the new bytes. Renamed leftovers are swept once their process
    // exits (same trash pattern as the host installer's `atomicSwap`).
    await sweepAsideCliBinaries(stablePath);
    await renameCliBinaryAside(stablePath);
    await copyFile(opts.bundledCliPath, stablePath);
  } else {
    // Clear any prior staged binary/symlink so symlink() doesn't EEXIST and a
    // stale copy never lingers next to a fresh symlink.
    await rm(stablePath, { force: true });
    await symlink(opts.bundledCliPath, stablePath);
  }
  const manifest: CliInstallManifest = {
    version: opts.version,
    installedAt: new Date().toISOString(),
    binaryPath: stablePath,
    source: opts.source,
    pendingUpgrade: null,
  };
  await mkdir(dirname(resolveCliManifestPath()), { recursive: true });
  await writeFile(
    resolveCliManifestPath(),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
  log.info("[cli] staged bundled CLI to stable per-user path", {
    stablePath,
    version: opts.version,
    source: opts.source,
  });
  return stablePath;
}

/**
 * Move the (possibly running) slot binary out of the stable name so a new
 * copy can take its place. A missing binary (fresh install, self-heal after
 * deletion) is not an error. Anything else - e.g. an AV scanner holding the
 * file without delete sharing, which blocks rename too - propagates to the
 * caller, where the reconcile's existing `binary-locked` staging path takes
 * over as the fallback.
 */
export async function renameCliBinaryAside(stablePath: string): Promise<void> {
  try {
    await rename(stablePath, `${stablePath}.old-${Date.now()}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

/**
 * Best-effort sweep of `<binary>.old-<ts>` leftovers from previous
 * rename-aside installs. Deletion fails while a renamed image is still
 * executing (the host supervisor from before the swap) - those unlock once
 * the host restarts onto the new binary, so each install pass retries the
 * whole set and the trash never outlives one host generation by much.
 */
export async function sweepAsideCliBinaries(stablePath: string): Promise<void> {
  const dir = dirname(stablePath);
  const prefix = `${parse(stablePath).base}.old-`;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => name.startsWith(prefix))
      .map((name) =>
        rm(join(dir, name), { force: true }).catch(() => undefined),
      ),
  );
}

/**
 * Self-heal pass: if the manifest points at a missing/non-executable
 * binary AND the bundled CLI is present and runnable, silently reinstall
 * the bundled CLI to the stable per-user path. Returns the path that is
 * known-good after the pass.
 *
 * If the bundled CLI is absent there's nothing to repair from - caller
 * routes to the first-launch UX which downloads/installs CLI via NP-7
 * (out of scope here; for v1 NP-5 we only handle the bundled-CLI case).
 */
export async function selfHealCliFromBundled(opts: {
  readonly bundledCliPath: string | null;
  readonly bundledVersion: string;
}): Promise<string | null> {
  const manifest = await readCliManifest();
  const stablePath = stableCliBinaryPath();
  const installedOk =
    manifest !== null && (await isExecutable(manifest.binaryPath));
  if (installedOk) {
    return manifest.binaryPath;
  }
  if (opts.bundledCliPath === null) {
    return null;
  }
  log.info("[cli] installed CLI missing/corrupt - reinstalling bundled CLI", {
    manifestBinary: manifest?.binaryPath ?? null,
    stablePath,
  });
  return installBundledCli({
    bundledCliPath: opts.bundledCliPath,
    version: opts.bundledVersion,
    source: "desktop",
  });
}

// POSIX: X_OK access check is atomic - file exists and the user can
// execute it. Windows has no real X bit, so an existence check (F_OK)
// is the strongest probe available. A single access() call replaces
// the earlier statSync+existsSync+accessSync triple and avoids the
// TOCTOU window between the checks.
export async function isExecutable(path: string): Promise<boolean> {
  const mode = platform() === "win32" ? constants.F_OK : constants.X_OK;
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

/**
 * True for the `0.0.0*` local-dev placeholder family (see
 * {@link readBundledCliVersion}): every dogfood/local build stamps it, so
 * two different local builds are version-indistinguishable. Callers that
 * need to order two sentinel builds must compare something else (the
 * reconciler compares binary content - {@link cliBinariesDiffer}).
 */
export function isLocalSentinelVersion(version: string): boolean {
  return version.startsWith("0.0.0");
}

/**
 * Content comparison for two CLI binaries, for the one case version
 * comparison cannot settle: both sides stamped with the local-dev
 * sentinel. Size mismatch short-circuits; equal sizes fall through to a
 * streamed sha256 so two ~100MB SEA binaries never load into memory.
 */
export async function cliBinariesDiffer(
  installedPath: string,
  bundledPath: string,
): Promise<boolean> {
  const [installedStat, bundledStat] = await Promise.all([
    stat(installedPath),
    stat(bundledPath),
  ]);
  if (installedStat.size !== bundledStat.size) return true;
  const [installedDigest, bundledDigest] = await Promise.all([
    sha256File(installedPath),
    sha256File(bundledPath),
  ]);
  return installedDigest !== bundledDigest;
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.once("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * SemVer-ish comparison: returns 1 if `a` > `b`, -1 if `a` < `b`, 0 if
 * equal or unparseable. Used to decide "PATH CLI newer than bundled,
 * trust it". Pre-release suffixes are stripped - channel discrimination
 * isn't part of the v1 contract (review item 7: regression-tested so a
 * future contributor doesn't "fix" the strip without realizing).
 *
 * Local-dev sentinel handling (review item 6): a bundled `0.0.0-local`
 * version (the placeholder readBundledCliVersion returns when the
 * version marker is absent) MUST sort below any real release semver.
 * Otherwise the launch-time reconciliation compares `0.0.0-local`
 * against e.g. `1.5.0`, derives `0` (equal), short-circuits to
 * `trusted-equal`, and silently skips the upgrade. We treat any version
 * string beginning with `0.0.0` as `-Infinity` so it always loses
 * against a real semver but ties with another `0.0.0`-prefixed value.
 */
export function compareSemver(a: string, b: string): number {
  const aLocal = isLocalSentinelVersion(a);
  const bLocal = isLocalSentinelVersion(b);
  if (aLocal && bLocal) return 0;
  if (aLocal) return -1;
  if (bLocal) return 1;
  const parse = (v: string): number[] | null => {
    const main = v.split("-")[0];
    const parts = main.split(".").map((p) => Number.parseInt(p, 10));
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
      return null;
    }
    return parts;
  };
  const ap = parse(a);
  const bp = parse(b);
  if (ap === null || bp === null) return 0;
  for (let i = 0; i < 3; i++) {
    if (ap[i] !== bp[i]) return ap[i] > bp[i] ? 1 : -1;
  }
  return 0;
}

/**
 * Full SemVer precedence comparison (spec §11), pre-release included: returns
 * 1 if `a` > `b`, -1 if `a` < `b`, 0 if equal or unparseable. Build metadata
 * (`+...`) is ignored.
 *
 * This is the host "update available?" comparator. It deliberately does NOT
 * share {@link compareSemver}'s pre-release strip: that strip serves the CLI
 * bundled-vs-PATH trust decision where channel is out of scope, but the host
 * update check needs `1.0.0-rc.1 < 1.0.0` so a release-candidate host upgrades
 * to its GA instead of reading "up to date" forever. An unparseable core
 * triplet yields 0 so we never advertise an update we can't justify.
 */
export const compareHostVersions = compareHostSemanticVersions;
