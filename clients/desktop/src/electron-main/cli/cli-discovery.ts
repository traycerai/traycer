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

const TRAYCER_HOME = join(homedir(), ".traycer");
const CLI_HOME = join(TRAYCER_HOME, "cli");

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

// It must stay literally the same file: the whole point is that a CLI mutation and this desktop-held section exclude each other through ordinary O_CREAT|O_EXCL contention on ONE.
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

export async function stageBundledCliForUpgrade(opts: {
  readonly bundledCliPath: string;
  readonly version: string;
}): Promise<string> {
  await mkdir(resolveCliStagingDir(), { recursive: true, mode: 0o755 });
  const base = cliBinaryName();
  const ext = platform() === "win32" ? ".exe" : "";
  const sanitized = opts.version.replace(/[^A-Za-z0-9._-]/g, "_");
  // Embed platform/arch in the staged filename so two staged binaries for different runtimes never collide in `~/.traycer/cli/staging/`.
  // The upgrade rename target (`stableCliBinaryPath`) is platform-native, so the staged copy must be too - `<name>-<version>-<platform>-<arch>[.exe]`.
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

export function bundledCliArchDir(): string {
  return `${process.platform}-${process.arch}`;
}

const BUNDLED_CLI_VERSION_FILENAME = "version.json";
const BUNDLED_CLI_LOCAL_VERSION = "0.0.0-local";

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

/** We never throw - the caller falls through to PATH / bundled discovery, and self-heal writes a fresh manifest from the bundled CLI. */
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

/** Callers should pass the manifest they already have in scope when known (e.g. cli-reconcile already loads it) so we don't re-read and re-parse on every reconcile. */
export async function writeCliManifestPendingUpgrade(
  pending: NonNullable<CliInstallManifest["pendingUpgrade"]>,
  existingManifest: CliInstallManifest | null,
): Promise<CliInstallManifest | null> {
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
      const tmpPath = `${manifestPath}.next-${process.pid}-${randomUUID()}`;
      await writeFile(tmpPath, JSON.stringify(next, null, 2), "utf8");
      await rename(tmpPath, manifestPath);
      return next;
    },
  );
  if (outcome.kind === "acquired") return outcome.result;
  log.warn("[cli] skipping pendingUpgrade record - the cli-lock is held", {
    lockPath: resolveCliLockPath(),
    holderPid: outcome.holder?.pid ?? null,
  });
  return null;
}

/** We deliberately do NOT write this into the manifest itself - the manifest is owned by the package manager. */
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
 * All matches, not just the first: the name can be squatted, and a squatter sitting ahead of a real CLI must not hide it.
 * The caller vets candidates in order and takes the first that answers `--version`, so a rejected entry costs one (cached) probe rather than the whole PATH lookup.
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

// A probe that RAN and answered wrongly is a different fact from a probe that was KILLED at the deadline, and the two must not share a verdict.
type CliVersionProbe =
  | { readonly kind: "version"; readonly version: string }
  | { readonly kind: "not-a-cli" }
  | { readonly kind: "timeout" };

/** How long a `--version` probe waits, chosen by what the CALLER can afford rather than by what the binary deserves. */
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

// The two verdicts that ARE cached (`version`, `not-a-cli`) are facts about the binary, so once settled they answer every caller whatever its patience.
// A probe still RUNNING is not that: it carries the deadline it was started with, and that deadline is only good enough for a caller willing to wait no longer.
type PathProbeEntry =
  | { readonly kind: "settled"; readonly probe: Promise<CliVersionProbe> }
  | {
      readonly kind: "in-flight";
      readonly deadlineMs: number;
      readonly probe: Promise<CliVersionProbe>;
    };

const pathProbeCache = new Map<string, PathProbeEntry>();

// Every (entry state x caller deadline) pair, stated once so none of them is decided by accident: settled -> answer from it, whatever the deadline.
// in-flight, D < T -> do NOT join: that probe gets killed at D and hands back a `timeout` describing someone else's patience.
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
 * Vet a `traycer` found on PATH before discovery may return it: it must answer `--version` (cached probe).
 * Returns the probed version (plus the inferred npm source, when the path resolves into the npm package) or `null` when the candidate must be ignored.
 */
export async function vetPathCliCandidate(
  binaryPath: string,
  probeTimeoutMs: number,
): Promise<{ readonly version: string; readonly source?: "npm" } | null> {
  const probed = await cachedProbeCliVersion(binaryPath, probeTimeoutMs);
  if (probed.kind !== "version") {
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
 * 4. None - caller surfaces the first-launch / Doctor recovery path.
 * A PATH candidate is only returned after it passes the `--version` vet (`vetPathCliCandidate`, cached per process).
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
  if (config.environment === "production") {
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
 * A copy cannot dangle; staleness is already handled by the reconcile version compare, which re-stages on every app update.
 * The copy is staged beside the slot and renamed over it, so a crash mid-stage never leaves a truncated binary at the stable name.
 */
export async function installBundledCli(opts: {
  readonly bundledCliPath: string;
  readonly version: string;
  readonly source: CliInstallManifest["source"];
}): Promise<BundledCliInstallResult> {
  // Without participating, the two interleave in a way neither can detect: the refresh selects source A, this publishes B plus a manifest naming the slot itself, and the refresh then.
  // Best-effort rather than a gate: installing the bundled CLI is part of app launch and must not fail because another process held a lock.
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
  log.warn("[cli] deferring bundled CLI publish - the cli-lock is held", {
    lockPath: resolveCliLockPath(),
    holderPid: outcome.holder?.pid ?? null,
    holderReason: outcome.holder?.reason ?? null,
  });
  return { path: stableCliBinaryPath(), published: false };
}

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
    const asidePath = await renameCliBinaryAside(stablePath);
    try {
      await copyFile(opts.bundledCliPath, stablePath);
    } catch (error) {
      // Mirror of the CLI's stageWellKnownCliBinary restore: the whole point of the aside is that publishing degrades to stale-but-functional, never to an absent slot the Scheduled Task.
      if (asidePath !== null) {
        await rename(asidePath, stablePath).catch(() => undefined);
      }
      throw error;
    }
    await sweepAsideCliBinaries(stablePath);
  } else {
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

/** Deletion fails while a renamed image is still executing (the host supervisor from before the swap). */
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

export async function isExecutable(path: string): Promise<boolean> {
  const mode = platform() === "win32" ? constants.F_OK : constants.X_OK;
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

/** Callers that need to order two sentinel builds must compare something else (the reconciler compares binary content - {@link cliBinariesDiffer}). */
export function isLocalSentinelVersion(version: string): boolean {
  return version.startsWith("0.0.0");
}

/**
 * Content comparison for two CLI binaries, for the one case version comparison cannot settle: both sides stamped with the local-dev sentinel.
 * Size mismatch short-circuits; equal sizes fall through to a streamed sha256 so two ~100MB SEA binaries never load into memory.
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
 * RC identifiers must participate: stripping them leaves a copied rc.1 CLI installed after Desktop updates to rc.2.
 * Local-dev sentinel handling (review item 6): a bundled `0.0.0-local` version (the placeholder readBundledCliVersion returns when the version marker is absent) MUST sort below any.
 */
export function compareSemver(a: string, b: string): number {
  const aLocal = isLocalSentinelVersion(a);
  const bLocal = isLocalSentinelVersion(b);
  if (aLocal && bLocal) return 0;
  if (aLocal) return -1;
  if (bLocal) return 1;
  return compareHostVersions(a, b);
}

/** An unparseable core triplet yields 0 so we never advertise an update we can't justify. */
export function compareHostVersions(a: string, b: string): number {
  const parse = (v: string): { core: number[]; pre: string[] } | null => {
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
