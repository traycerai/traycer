import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
  writeFile,
} from "node:fs/promises";
import { homedir, platform } from "node:os";
import { delimiter, dirname, join, parse } from "node:path";
import { config, isDevBuild } from "../../config";
import { environmentSubdir } from "../host/host-paths";
import { devDesktopSlotForEnvironment } from "../host/dev-desktop-slot";
import { log } from "../app/logger";
import { withDesktopCliLock } from "../host/desktop-cli-lock";
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

// The CLI's own `store/paths.ts` `cliLockPath()`, resolved from this side.
// It must stay literally the same file: the whole point is that a CLI
// mutation and this desktop-held section exclude each other through ordinary
// O_CREAT|O_EXCL contention on ONE path.
function resolveCliLockPath(): string {
  return join(resolveCliSlotHome(), ".lock");
}

// Long enough to outlast a CLI-side staging of a ~100 MB binary, which is
// what this would normally be queued behind.
const CLI_SLOT_LOCK_WAIT_MS = 15_000;
const CLI_SLOT_LOCK_POLL_MS = 100;

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
  // Under the CLI lock, with a RE-READ inside it, and the ordering is the
  // whole point. This runs on the blocked-upgrade path, which means another
  // writer was just active on this manifest - and the caller's snapshot is
  // from reconcile START, seconds and one failed publish ago. Writing that
  // snapshot back unlocked can clobber a `cli mark-source` that committed
  // in between, leaving the machine running one installation's bytes under
  // another's manifest: the precise state the lock exists to prevent. The
  // caller's manifest is used only as a fallback when the locked re-read
  // finds nothing (the manifest was deleted since - preserving the old
  // behaviour of still recording the pending upgrade).
  await ensurePrivateDir(resolveCliSlotHome());
  const outcome = await withDesktopCliLock(
    {
      lockPath: resolveCliLockPath(),
      reason: "desktop-record-pending-upgrade",
      waitMs: CLI_SLOT_LOCK_WAIT_MS,
      pollIntervalMs: CLI_SLOT_LOCK_POLL_MS,
    },
    async (): Promise<CliInstallManifest | null> => {
      const existing = (await readCliManifest()) ?? existingManifest;
      if (existing === null) return null;
      const next: CliInstallManifest = { ...existing, pendingUpgrade: pending };
      const manifestPath = resolveCliManifestPath();
      await mkdir(dirname(manifestPath), { recursive: true });
      // Tmp-and-rename, not a bare writeFile: the CLI's `readCliManifest`
      // treats malformed JSON as a hard fault, so a reader catching a
      // half-written manifest would diagnose corruption where there is
      // only an unfinished write.
      const tmpPath = `${manifestPath}.next-${process.pid}-${randomUUID()}`;
      await writeFile(tmpPath, JSON.stringify(next, null, 2), "utf8");
      await rename(tmpPath, manifestPath);
      return next;
    },
  );
  if (outcome.kind === "acquired") return outcome.result;
  // Past the wait: skip. A pendingUpgrade that goes unrecorded costs one
  // launch of delay - the next reconcile recomputes the gap and retries -
  // whereas writing without the lock is exactly the clobber described
  // above. Logged with the real cause so the caller's generic warning is
  // not the only trace.
  log.warn("[cli] skipping pendingUpgrade record - the cli-lock is held", {
    lockPath: resolveCliLockPath(),
    holderPid: outcome.holder?.pid ?? null,
  });
  return null;
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
 * Locate every `traycer` executable on the user's PATH, in PATH order.
 *
 * All matches, not just the first: the name can be squatted, and a
 * squatter sitting ahead of a real CLI must not hide it. The caller vets
 * candidates in order and takes the first that answers `--version`, so a
 * rejected entry costs one (cached) probe rather than the whole PATH
 * lookup. Duplicate PATH entries are collapsed so the same binary is
 * never considered twice.
 */
export async function findCliCandidatesOnPath(): Promise<string[]> {
  const pathEnv = process.env.PATH;
  if (typeof pathEnv !== "string" || pathEnv.length === 0) return [];
  const binary = cliBinaryName();
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, binary);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (await isExecutable(candidate)) {
      candidates.push(candidate);
    }
  }
  return candidates;
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

// A probe that RAN and answered wrongly is a different fact from a probe
// that was KILLED at the deadline, and the two must not share a verdict.
// The failure (oss #872's squatter, a garbage binary) is an immediate exec
// error or nonsense output - condemn it. The timeout is the one shape a
// REAL slow CLI can produce: a packaged `traycer --version` runs its slot
// refresh before commander parses, and on a first launch with a stale slot
// that is a ~100 MB copy - killing it at 2s and calling the binary
// not-a-CLI stages the bundled CLI over a working package-manager install,
// which writes a Desktop-owned manifest that outranks PATH in every later
// discovery. That consequence is permanent, not per-session, which is why
// the caller's deadline (below) matters more than the verdict's cache.
type CliVersionProbe =
  | { readonly kind: "version"; readonly version: string }
  | { readonly kind: "not-a-cli" }
  | { readonly kind: "timeout" };

/**
 * How long a `--version` probe waits, chosen by what the CALLER can afford
 * rather than by what the binary deserves.
 *
 * Impatient (`CLI_INVOCATION_PROBE_TIMEOUT_MS`): discovery on the invocation path runs
 * on every status poll, and an uncached `timeout` verdict costs the full
 * deadline every time. Two seconds is what that path can spend.
 *
 * Patient (`CLI_RECONCILE_PROBE_TIMEOUT_MS`): the launch reconcile runs
 * once, detached (`void timed("deferred", "cli-reconcile", ...)`), and is
 * the only prober whose verdict can hand slot OWNERSHIP to Desktop - a
 * timed-out vet drops the PATH candidate, discovery falls through to the
 * bundled CLI, and installing that writes a Desktop-owned manifest which
 * wins every later discovery. Nothing re-probes PATH after that, so
 * dropping the timeout from the cache buys the retry no chance to happen;
 * the misclassification is permanent, not per-session. The one binary shape
 * that legitimately blows a 2s deadline is a REAL packaged CLI refreshing
 * its ~100 MB slot before commander parses - and it needs to be given the
 * time to finish exactly once, because each killed probe abandons the copy
 * and the next one starts over. Fifteen seconds covers that copy on a slow
 * volume; past it the candidate is treated as unusable and the bundled CLI
 * is staged, because refusing to stage on an unanswerable probe is how the
 * oss #872 squatter bricked first launch.
 */
export const CLI_INVOCATION_PROBE_TIMEOUT_MS = 2_000;
export const CLI_RECONCILE_PROBE_TIMEOUT_MS = 15_000;

export async function probeCliVersion(
  binaryPath: string,
  timeoutMs: number,
): Promise<CliVersionProbe> {
  return new Promise((resolve) => {
    execFile(
      binaryPath,
      ["--version"],
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(error.killed ? { kind: "timeout" } : { kind: "not-a-cli" });
          return;
        }
        const text = String(stdout).trim();
        const match = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(text);
        resolve(
          match?.[1] !== undefined
            ? { kind: "version", version: match[1] }
            : { kind: "not-a-cli" },
        );
      },
    );
  });
}

// Probe results for PATH candidates, cached for the process lifetime and
// keyed by binary path. Discovery runs on every CLI invocation (status
// polls included), and an unresponsive candidate costs the full 2s probe
// timeout each time - the cache bounds that to one probe per binary per
// desktop session. The promise (not the settled value) is cached so
// concurrent discoveries share one exec. Accepted staleness: a PATH binary
// replaced mid-session keeps its verdict until relaunch; the next launch's
// reconcile re-probes and re-governs staging anyway.
//
// A `timeout` verdict is deliberately NOT cached: it describes the probe's
// patience, not the binary, and the very refresh that made the first probe
// slow repairs the slot so the next one is fast. Pinning it would hold the
// misclassification for the whole session.
//
// The two verdicts that ARE cached (`version`, `not-a-cli`) are facts about
// the binary, so once settled they answer every caller whatever its
// patience. A probe still RUNNING is not that: it carries the deadline it
// was started with, and that deadline is only good enough for a caller
// willing to wait no longer. The entry therefore says which of the two it
// is rather than leaving the distinction to a sentinel value.
type PathProbeEntry =
  | { readonly kind: "settled"; readonly probe: Promise<CliVersionProbe> }
  | {
      readonly kind: "in-flight";
      readonly deadlineMs: number;
      readonly probe: Promise<CliVersionProbe>;
    };

const pathProbeCache = new Map<string, PathProbeEntry>();

// Every (entry state x caller deadline) pair, stated once so none of them
// is decided by accident:
//
//   settled                  -> answer from it, whatever the deadline.
//   in-flight, D === T       -> join it.
//   in-flight, D  >  T       -> join, but stop waiting at T. Otherwise a
//                               status poll landing inside the reconcile's
//                               15s probe would stall the invocation path
//                               for all of it.
//   in-flight, D  <  T       -> do NOT join: that probe gets killed at D
//                               and hands back a `timeout` describing
//                               someone else's patience. For the reconcile
//                               that verdict is not recoverable - it drops
//                               the PATH candidate and installs a
//                               Desktop-owned manifest that outranks PATH
//                               from then on. Start a probe that can
//                               actually run for T and let it supersede.
function cachedProbeCliVersion(
  binaryPath: string,
  timeoutMs: number,
): Promise<CliVersionProbe> {
  const cached = pathProbeCache.get(binaryPath);
  if (cached !== undefined) {
    if (cached.kind === "settled") return cached.probe;
    if (cached.deadlineMs === timeoutMs) return cached.probe;
    if (cached.deadlineMs > timeoutMs) {
      return raceProbeDeadline(cached.probe, timeoutMs);
    }
  }
  const probe = probeCliVersion(binaryPath, timeoutMs);
  const entry: PathProbeEntry = {
    kind: "in-flight",
    deadlineMs: timeoutMs,
    probe,
  };
  pathProbeCache.set(binaryPath, entry);
  void probe.then((verdict) => {
    // Only ever replaces its OWN entry. A more patient probe may have
    // superseded this one while it ran, and neither of this probe's
    // outcomes may disturb that: a `timeout` deleting the entry would
    // discard a probe that is still running, and a verdict overwriting it
    // would put the shorter deadline's answer back in front of it.
    if (pathProbeCache.get(binaryPath) !== entry) return;
    if (verdict.kind === "timeout") {
      pathProbeCache.delete(binaryPath);
      return;
    }
    pathProbeCache.set(binaryPath, { kind: "settled", probe });
  });
  return probe;
}

async function raceProbeDeadline(
  probe: Promise<CliVersionProbe>,
  timeoutMs: number,
): Promise<CliVersionProbe> {
  let timer: NodeJS.Timeout | null = null;
  const ownDeadline = new Promise<CliVersionProbe>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  try {
    return await Promise.race([probe, ownDeadline]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export function resetCliProbeCacheForTests(): void {
  pathProbeCache.clear();
}

/**
 * Vet a `traycer` found on PATH before discovery may return it: it must
 * answer `--version` (cached probe). Merely *existing* under the right name
 * is not enough - the name can be squatted by something that is not our
 * CLI at all (oss #872: an AppImage-manager launcher for the desktop app
 * itself), and adopting such a binary both suppresses bundled-CLI staging
 * and breaks every subsequent invocation. Returns the probed version (plus
 * the inferred npm source, when the path resolves into the npm package)
 * or `null` when the candidate must be ignored.
 */
export async function vetPathCliCandidate(
  binaryPath: string,
  probeTimeoutMs: number,
): Promise<{ readonly version: string; readonly source?: "npm" } | null> {
  const probed = await cachedProbeCliVersion(binaryPath, probeTimeoutMs);
  if (probed.kind !== "version") {
    // Both non-answers ignore the candidate for THIS discovery - adopting
    // an unvetted binary is the oss #872 failure either way - but only
    // `not-a-cli` is a verdict about the binary. A `timeout` is uncached
    // (see the cache note above), so a slow-but-real CLI is retried rather
    // than condemned for the session.
    log.warn(
      probed.kind === "timeout"
        ? "[cli] `traycer` on PATH did not answer the version probe in time - skipping it this pass"
        : "[cli] `traycer` on PATH failed the version probe - ignoring it for discovery",
      { binaryPath },
    );
    return null;
  }
  const source = await inferNpmPathSource(binaryPath);
  return source !== undefined
    ? { version: probed.version, source }
    : { version: probed.version };
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
 * A PATH candidate is only returned after it passes the `--version` vet
 * (`vetPathCliCandidate`, cached per process) - a name-squatting binary
 * that cannot answer falls through to the bundled CLI instead of being
 * adopted (oss #872). Version-trust policy beyond that ("PATH CLI newer
 * than bundled, trust it") stays with the caller (cli-reconcile).
 *
 * `probeTimeoutMs` is that vet's deadline, and it is the caller's to choose
 * rather than this function's: falling through to the bundled CLI costs a
 * status poll nothing and costs the launch reconcile the slot's ownership.
 * See `CLI_INVOCATION_PROBE_TIMEOUT_MS` / `CLI_RECONCILE_PROBE_TIMEOUT_MS`.
 */
export async function discoverCli(
  probeTimeoutMs: number,
): Promise<CliDiscoveryResult> {
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
    // Walk PATH in order and take the first candidate that passes the
    // vet. Stopping at the first *executable* instead would let a
    // squatter earlier in PATH hide a real CLI behind it (and report
    // "no CLI anywhere" when the app ships no bundled binary).
    for (const candidate of await findCliCandidatesOnPath()) {
      const vetted = await vetPathCliCandidate(candidate, probeTimeoutMs);
      if (vetted !== null) {
        return { kind: "path", binaryPath: candidate, ...vetted };
      }
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
 * On every platform the stable path (`~/.traycer/cli[/<slot>]/bin/traycer`)
 * is now a **copy** of the bundled CLI, not a symlink into the .app.
 *
 * It used to be a symlink on POSIX (one binary, nothing to drift or go
 * stale on app update) - but that made the slot's validity hostage to the
 * bundle's lifecycle: any bundle remove/replace (uninstall, drag-to-Trash,
 * an updater's rm+cp window, an app rename) left a DANGLING link that
 * `ls`/lstat still show while exec fails ENOENT, and the only healer was
 * the next *successful* app launch - circular exactly when the app is the
 * broken part (field report: "no such file or directory" on a file the
 * user can see). A copy cannot dangle; staleness is already handled by the
 * reconcile version compare, which re-stages on every app update - the
 * same flow Windows (which always copied) has exercised in the field all
 * along. The copy is staged beside the slot and renamed over it, so a
 * crash mid-stage never leaves a truncated binary at the stable name.
 *
 * Returns the stable path and whether THIS call published to it, or throws if
 * the bundled CLI isn't present (a packaging bug worth surfacing loudly).
 *
 * `published: false` means the CLI lock was held past the wait, so nothing
 * was written. The path is the slot's EVENTUAL stable location, not a
 * promise anything is there yet: the lock holder may still be mid-copy on a
 * first install, in which case the path is momentarily absent or incomplete.
 * Callers must check `published` before treating the path as an installed
 * CLI, must not report an install or an upgrade on a deferral, and route it
 * to a retryable outcome instead.
 */
export async function installBundledCli(opts: {
  readonly bundledCliPath: string;
  readonly version: string;
  readonly source: CliInstallManifest["source"];
}): Promise<BundledCliInstallResult> {
  // Under the CLI lock, because this function is not the only writer of the
  // slot it publishes. The CLI's startup refresh re-stages the same path from
  // whatever its manifest names, and takes this same lock to do it. Without
  // participating, the two interleave in a way neither can detect: the
  // refresh selects source A, this publishes B plus a manifest naming the
  // slot itself, and the refresh then publishes A over it - after which the
  // manifest names the slot, so the refresh's own staleness check
  // short-circuits and never notices the bytes are wrong. The machine runs A
  // until Desktop reconciles again.
  //
  // Best-effort rather than a gate: installing the bundled CLI is part of
  // app launch and must not fail because another process held a lock. On
  // contention past the wait it DEFERS - returns without writing - and the
  // caller routes that into a retryable outcome, so a held lock can delay a
  // publish but never turn app launch into an error.
  // The lock file lives IN the slot home, so that directory has to exist
  // before it can be opened - `open(path, "wx")` on a missing parent is
  // ENOENT, not contention. The CLI's own `withCliLock` wrapper ensures the
  // same directory for the same reason; the shared lock module does not.
  await ensurePrivateDir(resolveCliSlotHome());
  const outcome = await withDesktopCliLock(
    {
      lockPath: resolveCliLockPath(),
      reason: "desktop-install-bundled-cli",
      waitMs: CLI_SLOT_LOCK_WAIT_MS,
      pollIntervalMs: CLI_SLOT_LOCK_POLL_MS,
    },
    () => publishBundledCli(opts),
  );
  if (outcome.kind === "acquired") {
    return { path: outcome.result, published: true };
  }
  // Past the wait: defer, unconditionally.
  //
  // Publishing anyway would re-admit the exact interleaving this lock was
  // taken to prevent, and in the case most likely to produce it - a
  // `traycer cli upgrade` holding this lock across a network download that
  // routinely outlasts the wait. Two writers would publish a slot and a
  // manifest in interleaved order, and because a Desktop manifest names the
  // SLOT as its own `binaryPath`, the CLI's staleness check short-circuits on
  // it and never repairs the mismatch: a machine running one installation's
  // bytes under another's manifest, indefinitely.
  //
  // An earlier version of this made an exception when the slot was ABSENT,
  // reasoning that with no installation there was nothing to make
  // inconsistent. That inference is wrong, and the counter-example is the
  // ordinary one: a first-time `cli mark-source` takes this lock, writes its
  // manifest, and only then copies the binary - so the slot is legitimately
  // absent for the whole copy, and "no slot" means "an install is IN
  // PROGRESS" at least as often as it means "no install exists". Publishing
  // into that window and letting the CLI writer rename over the result
  // produces exactly the mismatch above. Absence of the slot is not evidence
  // of safety; only absence of the LOCK is.
  //
  // Deferring is safe against the failure that actually matters here, which
  // is leaving a machine with no CLI at all. A held lock means another writer
  // is publishing one, and if that writer dies the lock is reclaimed on the
  // next attempt by the shared module's holder-liveness check, so the wait
  // cannot become permanent. The caller routes the deferral into an existing
  // retryable outcome and reconcile runs again at the next launch.
  log.warn("[cli] deferring bundled CLI publish - the cli-lock is held", {
    lockPath: resolveCliLockPath(),
    holderPid: outcome.holder?.pid ?? null,
    holderReason: outcome.holder?.reason ?? null,
  });
  return { path: stableCliBinaryPath(), published: false };
}

// Create a directory at 0700, and REPAIR one that already exists.
//
// The mirror of the CLI's `ensurePrivateDir` (clients/traycer-cli,
// src/store/paths.ts), duplicated for the same reason `withDesktopCliLock`
// duplicates `withCliLock`: these two packages share no module, but they do
// share this directory, and a rule only one of them enforces is not enforced.
//
// `mkdir`'s `mode` applies only to directories it creates, so an existing one
// keeps whatever mode its first writer chose - which on any pre-existing
// install is the process umask, 0755. Setting the mode without repairing it
// would harden only machines that have never run Traycer, while every
// installed user keeps a world-traversable slot home - the same directory the
// credentials file lives in.
//
// POSIX only, best-effort, and narrowed to directories that are actually too
// open: installing the bundled CLI happens during app launch and must not
// fail over a directory this process may not even own.
async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (platform() === "win32") return;
  try {
    const current = await stat(path);
    if ((current.mode & 0o077) !== 0) await chmod(path, 0o700);
  } catch {
    return;
  }
}

export interface BundledCliInstallResult {
  // The slot path. Usable whether or not this call wrote to it.
  readonly path: string;
  // Whether this call published the bundled bytes and the manifest. False
  // only when the lock was held and a usable slot already existed.
  readonly published: boolean;
}

async function publishBundledCli(opts: {
  readonly bundledCliPath: string;
  readonly version: string;
  readonly source: CliInstallManifest["source"];
}): Promise<string> {
  // 0700, matching the CLI's `ensureCliInstallHomeDir`.
  await ensurePrivateDir(resolveCliBinDir());
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
    // Copy FIRST, then sweep. The previous order (sweep, rename-aside,
    // copy) had a failure shape whose second attempt destroyed the
    // machine's last good CLI: a failed copy left the slot ABSENT with the
    // old binary parked at `.old-<ts>`, and the NEXT publish's sweep then
    // deleted that aside - the only surviving copy - before failing the
    // copy again. Sweeping only after a successful publish means the aside
    // from a failed attempt survives until some attempt actually lands.
    const asidePath = await renameCliBinaryAside(stablePath);
    try {
      await copyFile(opts.bundledCliPath, stablePath);
    } catch (error) {
      // Mirror of the CLI's stageWellKnownCliBinary restore: the whole
      // point of the aside is that publishing degrades to
      // stale-but-functional, never to an absent slot the Scheduled Task
      // has nothing to launch from.
      if (asidePath !== null) {
        await rename(asidePath, stablePath).catch(() => undefined);
      }
      throw error;
    }
    await sweepAsideCliBinaries(stablePath);
  } else {
    // Atomic replace: rename() over the slot also swallows a legacy
    // symlink from the pre-copy era in one step.
    //
    // The staging name is per-invocation. A single fixed `.staging` path is
    // shared mutable state between concurrent installers - an updater or a
    // relaunch racing the running app resolves to the SAME stable slot - and
    // interleaving there defeats the whole point of staging: B's copy can be
    // mid-write when A chmods and renames, so A publishes a truncated binary
    // onto the stable path. rename() is only atomic with respect to a source
    // nobody else is writing.
    // Hyphen separators, matching the CLI's `stageWellKnownCliBinary`
    // convention (`.staging-<pid>-<uuid>`) on purpose: the CLI's
    // `sweepSlotLeftovers` collects `.staging-` orphans by prefix with an
    // age gate, and it is the only sweeper of this directory that handles
    // staging leftovers at all. The previous dot-separated spelling made a
    // hard-killed Electron's half-copied ~100 MB orphan invisible to every
    // sweep forever.
    const staging = `${stablePath}.staging-${process.pid}-${randomUUID()}`;
    try {
      await copyFile(opts.bundledCliPath, staging);
      await chmod(staging, 0o755);
      await rename(staging, stablePath);
    } catch (error) {
      // A unique name means nothing else can adopt this leftover, so it has
      // to be swept here or it accumulates beside the slot.
      await rm(staging, { force: true });
      throw error;
    }
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
 * copy can take its place, returning where it went so a failed publish can
 * restore it. A missing binary (fresh install, self-heal after deletion) is
 * not an error and yields `null` - there is nothing to restore. Anything
 * else - e.g. an AV scanner holding the file without delete sharing, which
 * blocks rename too - propagates to the caller, where the reconcile's
 * existing `binary-locked` staging path takes over as the fallback.
 */
export async function renameCliBinaryAside(
  stablePath: string,
): Promise<string | null> {
  const asidePath = `${stablePath}.old-${Date.now()}`;
  try {
    await rename(stablePath, asidePath);
    return asidePath;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
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
export function compareHostVersions(a: string, b: string): number {
  const parse = (v: string): { core: number[]; pre: string[] } | null => {
    // Reject anything that isn't a full SemVer triplet up front: lenient
    // Number.parseInt would otherwise smuggle malformed input through (e.g.
    // "1.2.3abc" → [1,2,3]) and skew the comparison, breaking the documented
    // "unparseable => 0" contract.
    const semver =
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
    if (!semver.test(v)) return null;
    const withoutBuild = v.split("+")[0];
    const dash = withoutBuild.indexOf("-");
    const core = (dash === -1 ? withoutBuild : withoutBuild.slice(0, dash))
      .split(".")
      .map((p) => Number.parseInt(p, 10));
    const preRaw = dash === -1 ? "" : withoutBuild.slice(dash + 1);
    return { core, pre: preRaw === "" ? [] : preRaw.split(".") };
  };
  const ap = parse(a);
  const bp = parse(b);
  if (ap === null || bp === null) return 0;
  for (let i = 0; i < 3; i++) {
    if (ap.core[i] !== bp.core[i]) return ap.core[i] > bp.core[i] ? 1 : -1;
  }
  // Equal core triplet: a version carrying a pre-release ranks below the same
  // version without one (1.0.0-rc.1 < 1.0.0).
  if (ap.pre.length === 0 && bp.pre.length === 0) return 0;
  if (ap.pre.length === 0) return 1;
  if (bp.pre.length === 0) return -1;
  return comparePreRelease(ap.pre, bp.pre);
}

/**
 * Compares two non-empty dot-separated pre-release identifier lists per SemVer
 * §11: numeric identifiers compare numerically and rank below alphanumeric
 * ones, alphanumeric identifiers compare in ASCII order, and a longer list
 * outranks a shorter one when all preceding identifiers are equal.
 */
function comparePreRelease(a: string[], b: string[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    const ai = a[i];
    const bi = b[i];
    const aNumeric = /^\d+$/.test(ai);
    const bNumeric = /^\d+$/.test(bi);
    if (aNumeric && bNumeric) {
      const an = Number.parseInt(ai, 10);
      const bn = Number.parseInt(bi, 10);
      if (an !== bn) return an > bn ? 1 : -1;
    } else if (aNumeric) {
      return -1;
    } else if (bNumeric) {
      return 1;
    } else if (ai !== bi) {
      return ai > bi ? 1 : -1;
    }
  }
  return 0;
}
