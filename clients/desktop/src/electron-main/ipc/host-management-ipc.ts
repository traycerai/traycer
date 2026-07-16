import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative } from "node:path";
import { log } from "../app/logger";
import { compareHostVersions } from "../cli/cli-discovery";
import rawDevWrapperPaths from "../cli/dev-wrapper-paths.json";
import {
  runTraycerCliJson,
  streamTraycerCliJson,
  TraycerCliError,
  type NdjsonEvent,
} from "../cli/traycer-cli";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import type {
  HostAvailableSnapshot,
  HostAvailableVersionEntry,
  HostDoctorReport,
  HostInstallResult,
  HostInstalledRecord,
  HostLogsTailResult,
  HostOperationKind,
  HostOperationStatus,
  HostProgressEvent,
  HostRegistryUpdateState,
  HostRemovalState,
  HostUninstallResult,
  TraycerUninstallResult,
  FreePortAndRestartInput,
} from "../../ipc-contracts/host-management-types";
import {
  hostManagesHostLoginItem,
  unregisterHostLoginItem,
} from "../app/host-login-item";
import {
  clearHostRemovedByUser,
  isHostRemovedByUser,
  markHostRemovedByUser,
} from "../host/host-removal-state";
import {
  environmentSubdir,
  getHostFsLayout,
  type Environment,
  type HostFsLayout,
} from "../host/host-paths";
import { devDesktopSlotForEnvironment } from "../host/dev-desktop-slot";
import {
  readHostNameSettings,
  writeHostNameSettings,
} from "../host/host-display-name";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

export const LONG_OP_TIMEOUT_MS = 10 * 60_000;
const REGISTRY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
type HostRegistryUpdateStateListener = (state: HostRegistryUpdateState) => void;
const registryUpdateStateListeners = new Set<HostRegistryUpdateStateListener>();

export function onHostRegistryUpdateStateChange(
  listener: HostRegistryUpdateStateListener,
): () => void {
  registryUpdateStateListeners.add(listener);
  return () => {
    registryUpdateStateListeners.delete(listener);
  };
}

function emitHostRegistryUpdateState(state: HostRegistryUpdateState): void {
  for (const listener of registryUpdateStateListeners) {
    try {
      listener(state);
    } catch (err) {
      log.warn("[host-management] registry update listener failed", err);
    }
  }
}

/**
 * Active host environment for this Desktop process. Set at boot via
 * `setActiveEnvironment(config.environment)`. Every host-management IPC
 * handler threads this through so:
 *
 *   - Settings → Host reads the installed-record file from the active
 *     environment's `~/.traycer/host[/dev|/staging]/install/install.json`,
 *     not a hardcoded production path.
 *   - CLI subprocess calls resolve the environment-scoped CLI (its slot is
 *     baked into the build, so no slot flag is passed) and read/write the
 *     environment-scoped pid/log/install paths, so a dev Desktop never
 *     mutates the production host's state or its service registration.
 *
 * Defaults to `"production"` so test-only callers that construct a bridge
 * without setting the environment get production paths.
 */
let activeEnvironment: Environment = "production";

export function setActiveEnvironment(environment: Environment): void {
  activeEnvironment = environment;
  log.debug("[host-management] active environment set", { environment });
}

export function getActiveEnvironment(): Environment {
  return activeEnvironment;
}

function activeLayout(): HostFsLayout {
  return getHostFsLayout(activeEnvironment);
}

function cliSlotRootForEnvironment(environment: Environment): string {
  const cliRoot = join(homedir(), ".traycer", "cli");
  const devSlot = devDesktopSlotForEnvironment(environment, process.env);
  if (devSlot !== null) return join(cliRoot, "dev-runs", devSlot);
  return environmentSubdir(cliRoot, environment);
}

interface DevWrapperPaths {
  readonly segments: readonly string[];
  readonly filenamePosix: string;
  readonly filenameWin32: string;
}

/**
 * Defensive parser for the bundled `dev-wrapper-paths.json`. We import
 * it as a JSON module (TS will type-check the literal at build time),
 * but a future hand-edit / corrupt commit could leave the file with
 * the wrong shape. Validate the shape explicitly so the failure mode
 * at module load is a clear "dev-wrapper-paths.json is malformed"
 * rather than an opaque `undefined.join` downstream.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseDevWrapperPaths(raw: unknown): DevWrapperPaths {
  if (!isRecord(raw)) {
    throw new Error("dev-wrapper-paths.json is malformed: not an object");
  }
  const segments = raw.segments;
  if (
    !Array.isArray(segments) ||
    !segments.every((s): s is string => typeof s === "string" && s.length > 0)
  ) {
    throw new Error(
      "dev-wrapper-paths.json is malformed: `segments` must be a non-empty array of non-empty strings",
    );
  }
  const filenamePosix = raw.filenamePosix;
  if (typeof filenamePosix !== "string" || filenamePosix.length === 0) {
    throw new Error(
      "dev-wrapper-paths.json is malformed: `filenamePosix` must be a non-empty string",
    );
  }
  const filenameWin32 = raw.filenameWin32;
  if (typeof filenameWin32 !== "string" || filenameWin32.length === 0) {
    throw new Error(
      "dev-wrapper-paths.json is malformed: `filenameWin32` must be a non-empty string",
    );
  }
  return { segments, filenamePosix, filenameWin32 };
}

const devWrapperPaths: DevWrapperPaths =
  parseDevWrapperPaths(rawDevWrapperPaths);

/**
 * Absolute path to the dev CLI wrapper staged by `make dev-desktop`
 * (see `scripts/dev-desktop.js`). The wrapper exec's the working-tree
 * `traycer-cli/src/index.ts` via bun so the OS service plist resolves
 * to a stable executable path even though the dev environment has no
 * packaged SEA binary on disk.
 *
 * The run slot selects the CLI root; `dev-wrapper-paths.json` supplies the
 * platform filename so this module and `scripts/dev-desktop.js` stay in
 * lockstep on the wrapper executable name.
 */
function devCliWrapperPath(): string {
  const filename =
    process.platform === "win32"
      ? devWrapperPaths.filenameWin32
      : devWrapperPaths.filenamePosix;
  return join(cliSlotRootForEnvironment(activeEnvironment), "bin", filename);
}

/**
 * Path-safety check used before passing the dev CLI wrapper to a
 * subprocess as `--cli-bin <path>` (review item 13). The wrapper must
 * live under the user's `~/.traycer/` tree - anything outside it (a
 * symlink, an env-mutated wrapper, a `..` traversal) is rejected so a
 * compromised env can't trick the CLI install path into hand-registering
 * an attacker-controlled binary. We normalize first to collapse `..`
 * segments before computing the relative path.
 */
function isUnderTraycerHome(candidate: string): boolean {
  const traycerHome = join(homedir(), ".traycer");
  const normalized = normalize(candidate);
  const rel = relative(traycerHome, normalized);
  if (rel.length === 0) return true;
  if (rel.startsWith("..")) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

/**
 * Extra args for the dev-slot `host service install` so reregister resolves
 * the dev CLI wrapper that `make dev-desktop` staged under this run's CLI bin
 * dir. Production (`activeEnvironment === "production"`) returns an empty list
 * so packaged Desktop keeps using the CLI install manifest at
 * `~/.traycer/cli/manifest.json`.
 *
 * The CLI's `resolveServiceCliInvocation` discovers that wrapper via the
 * well-known bin-dir convention without any flag - passing
 * `--allow-self-invocation` is the safety net for the case where
 * `make dev-desktop` hasn't staged the wrapper yet (the CLI then
 * registers its own `process.execPath` against the dev service rather
 * than throwing `SERVICE_CLI_PATH_UNRESOLVED`).
 *
 * Note: an older revision passed `--cli-bin <wrapper>` here. The CLI
 * removed that flag (the bin-dir convention subsumed it - see
 * `traycer-cli/src/service/cli-binary.ts`'s `override` field comment),
 * so we now only pass `--allow-self-invocation`. `devCliWrapperPath()` /
 * `isUnderTraycerHome()` are kept for the warning log only.
 */
async function devServiceInstallExtras(): Promise<string[]> {
  if (activeEnvironment !== "dev") return [];
  const wrapper = devCliWrapperPath();
  if (!isUnderTraycerHome(wrapper)) {
    log.warn(
      "[host-management] dev CLI wrapper path is outside ~/.traycer - relying on --allow-self-invocation",
      { wrapper },
    );
  }
  return ["--allow-self-invocation"];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function optionalString(raw: unknown, key: string): string | null {
  if (!isPlainObject(raw)) return null;
  const value = raw[key];
  return typeof value === "string" ? value : null;
}

export function optionalBoolean(raw: unknown, key: string): boolean {
  if (!isPlainObject(raw)) return false;
  return raw[key] === true;
}

function optionalNumber(raw: unknown, key: string): number | null {
  if (!isPlainObject(raw)) return null;
  const value = raw[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableString(raw: unknown, key: string): string | null {
  if (!isPlainObject(raw)) return null;
  const value = raw[key];
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  throw new Error(`${key} must be a string or null`);
}

/**
 * Canonical cross-surface "is a host mutation running" snapshot (Ticket:
 * host-update-race-conditions). Main is the single writer; every renderer
 * window reads it via `traycerHostOperationStatusGet` on mount and
 * `hostOperationStatusChange` thereafter.
 *
 * This is also the single-flight guard: `trackHostOperation` below rejects a
 * second concurrent call synchronously (no `await` between the null-check and
 * the set) instead of letting a second `traycer host …` subprocess spawn and
 * lose the race on `cli-lock`'s file mutex. That turns the user-visible "two
 * clicks -> CLI_LOCK_BUSY on the loser, stale UI on the winner" bug into a
 * same-process no-op, and makes `cli-lock` a pure backstop for a genuinely
 * separate process (a terminal `traycer host update` racing the desktop) -
 * not the mechanism the UI relies on for correctness.
 */
let currentOperationStatus: HostOperationStatus | null = null;

export function getHostOperationStatus(): HostOperationStatus | null {
  return currentOperationStatus;
}

function setHostOperationStatus(
  bridge: RunnerIpcBridge,
  status: HostOperationStatus | null,
): void {
  currentOperationStatus = status;
  bridge.fanOut(RunnerHostEvent.hostOperationStatusChange, status);
}

/**
 * Single seam every long-running CLI-backed operation (install / update /
 * register-service / ensure) funnels through. Owns the single-flight guard,
 * the canonical status broadcast (start / each progress tick / settle), and
 * the legacy per-`operationId` `cliOperationProgress` fan-out that the
 * preload's `withOperationListener` still reads.
 */
async function trackHostOperation<T>(
  bridge: RunnerIpcBridge,
  kind: HostOperationKind,
  operationId: string,
  run: (onEvent: (event: NdjsonEvent) => void) => Promise<T>,
): Promise<T> {
  if (currentOperationStatus !== null) {
    throw new Error(
      `Another host operation (${currentOperationStatus.kind}) is already in progress`,
    );
  }
  const startedAt = new Date().toISOString();
  setHostOperationStatus(bridge, {
    operationId,
    kind,
    stage: null,
    percent: null,
    bytes: null,
    totalBytes: null,
    message: null,
    startedAt,
  });
  const onEvent = (event: NdjsonEvent): void => {
    if (event.type !== "progress") return;
    const payload: HostProgressEvent = {
      operationId,
      stage: event.stage,
      percent: event.percent,
      bytes: event.bytes,
      totalBytes: event.totalBytes,
      message: event.message,
    };
    bridge.fanOut(RunnerHostEvent.cliOperationProgress, payload);
    setHostOperationStatus(bridge, {
      operationId,
      kind,
      stage: event.stage,
      percent: event.percent,
      bytes: event.bytes,
      totalBytes: event.totalBytes,
      message: event.message,
      startedAt,
    });
  };
  try {
    return await run(onEvent);
  } finally {
    // Always clears, success or failure, so a rejected operation never
    // leaves every surface permanently disabled.
    setHostOperationStatus(bridge, null);
  }
}

export function streamCliWithProgress(
  args: readonly string[],
  operationId: string,
  kind: HostOperationKind,
  timeoutMs: number,
  bridge: RunnerIpcBridge,
): Promise<unknown> {
  // The wrapper guarantees `--json`; non-progress envelopes are absorbed
  // by streamTraycerCliJson which only resolves on a terminal `result`
  // event (ok → data, error → TraycerCliError reject).
  return trackHostOperation(bridge, kind, operationId, (onEvent) =>
    streamTraycerCliJson<unknown>({
      args,
      onEvent,
      env: null,
      timeoutMs,
    }).then((result: { readonly data: unknown }) => result.data),
  );
}

/**
 * Maps `traycer host available --json` payload to the renderer-facing
 * `HostAvailableSnapshot`. The CLI returns the entire registry manifest
 * plus an inferred `platformKey`; we project per-platform asset state out so
 * the Settings → Host Available Versions table can render rows directly.
 */
function projectAvailableSnapshot(raw: unknown): HostAvailableSnapshot {
  if (!isPlainObject(raw)) {
    throw new Error("host available: malformed response");
  }
  const manifest = isPlainObject(raw.manifest) ? raw.manifest : null;
  if (manifest === null) {
    throw new Error("host available: missing manifest");
  }
  const platformKey =
    typeof raw.platformKey === "string" ? raw.platformKey : "";
  const manifestUrl =
    typeof raw.manifestUrl === "string" ? raw.manifestUrl : "";
  const versionsRaw = Array.isArray(manifest.versions) ? manifest.versions : [];
  const versions: HostAvailableVersionEntry[] = versionsRaw
    .filter(isPlainObject)
    .map((entry) => {
      const platformsRaw = isPlainObject(entry.platforms)
        ? entry.platforms
        : {};
      const assetRaw = isPlainObject(platformsRaw[platformKey])
        ? platformsRaw[platformKey]
        : null;
      return {
        version: typeof entry.version === "string" ? entry.version : "",
        releasedAt:
          typeof entry.releasedAt === "string" ? entry.releasedAt : "",
        releaseNotesUrl:
          typeof entry.releaseNotesUrl === "string"
            ? entry.releaseNotesUrl
            : "",
        yanked: entry.yanked === true,
        deprecationReason:
          typeof entry.deprecationReason === "string"
            ? entry.deprecationReason
            : null,
        platformAsset:
          assetRaw === null
            ? null
            : {
                available: assetRaw.available === true,
                unavailableReason:
                  typeof assetRaw.unavailableReason === "string"
                    ? assetRaw.unavailableReason
                    : null,
                url: typeof assetRaw.url === "string" ? assetRaw.url : "",
                sizeBytes:
                  typeof assetRaw.sizeBytes === "number"
                    ? assetRaw.sizeBytes
                    : 0,
                sha256:
                  typeof assetRaw.sha256 === "string" ? assetRaw.sha256 : "",
                signatureUrl:
                  typeof assetRaw.signatureUrl === "string"
                    ? assetRaw.signatureUrl
                    : "",
                publicKeyId:
                  typeof assetRaw.publicKeyId === "string"
                    ? assetRaw.publicKeyId
                    : "",
              },
      };
    });
  return {
    generatedAt:
      typeof manifest.generatedAt === "string" ? manifest.generatedAt : "",
    latest: typeof manifest.latest === "string" ? manifest.latest : "",
    platformKey,
    manifestUrl,
    versions,
  };
}

function projectDoctorReport(raw: unknown): HostDoctorReport {
  const ranAt = new Date().toISOString();
  if (!isPlainObject(raw) || !Array.isArray(raw.issues)) {
    return { issues: [], ranAt };
  }
  return {
    ranAt,
    issues: raw.issues.filter(isPlainObject).map((issue) => ({
      code: typeof issue.code === "string" ? issue.code : "UNKNOWN",
      severity:
        issue.severity === "info" ||
        issue.severity === "warning" ||
        issue.severity === "error" ||
        issue.severity === "fatal"
          ? issue.severity
          : "warning",
      title: typeof issue.title === "string" ? issue.title : "",
      message: typeof issue.message === "string" ? issue.message : "",
      fixAction: typeof issue.fixAction === "string" ? issue.fixAction : null,
      terminalCommand:
        typeof issue.terminalCommand === "string"
          ? issue.terminalCommand
          : null,
      details: isPlainObject(issue.details) ? issue.details : null,
    })),
  };
}

/**
 * Locates the installed-host record on disk for the active environment.
 *
 * The CLI installer writes `install.json` to the environment/run-scoped host
 * install dir - `~/.traycer/host/install/install.json` for prod,
 * `~/.traycer/host/dev/install/install.json` for legacy/no-slot dev, and
 * `~/.traycer/host/dev-runs/<slot>/install/install.json` for multi-run dev
 * (see `hostInstallRecordPath` in `traycer-cli/src/store/paths.ts`).
 * Desktop reads the environment-matching record directly so:
 *
 *   - Packaged Desktop (prod environment) sees the production install
 *     record, keeping the Installed Host card on Settings → Host
 *     accurate even when the host itself is down.
 *   - Unpackaged Desktop (`make dev-desktop`, dev environment) sees the dev
 *     install record and never falsely reads/mutates the user's
 *     production host state - Ticket 29cf341f.
 *
 * The hardcoded prod path is gone; the path comes from the active
 * environment's `HostFsLayout.installRecordFile`.
 */
async function readInstalledHostRecord(): Promise<HostInstalledRecord | null> {
  const recordPath = activeLayout().installRecordFile;
  let text: string;
  try {
    text = await readFile(recordPath, { encoding: "utf8" });
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed)) return null;
    const sourceRaw = isPlainObject(parsed.source) ? parsed.source : null;
    const stats = await stat(recordPath);
    const arch =
      parsed.arch === "arm64" || parsed.arch === "x64" ? parsed.arch : null;
    const platform =
      parsed.platform === "darwin" ||
      parsed.platform === "win32" ||
      parsed.platform === "linux"
        ? parsed.platform
        : null;
    if (arch === null || platform === null) {
      return null;
    }
    return {
      version: typeof parsed.version === "string" ? parsed.version : "0.0.0",
      installedAt:
        typeof parsed.installedAt === "string"
          ? parsed.installedAt
          : stats.mtime.toISOString(),
      executablePath:
        typeof parsed.executablePath === "string" ? parsed.executablePath : "",
      source:
        sourceRaw === null
          ? { kind: "registry", value: "" }
          : {
              kind: sourceRaw.kind === "local-file" ? "local-file" : "registry",
              value: typeof sourceRaw.value === "string" ? sourceRaw.value : "",
            },
      archiveSha256:
        typeof parsed.archiveSha256 === "string" ? parsed.archiveSha256 : "",
      signatureKeyId:
        typeof parsed.signatureKeyId === "string" ? parsed.signatureKeyId : "",
      sizeBytes: typeof parsed.sizeBytes === "number" ? parsed.sizeBytes : 0,
      signatureVerifiedAt:
        typeof parsed.signatureVerifiedAt === "string"
          ? parsed.signatureVerifiedAt
          : null,
      platform,
      arch,
    };
  } catch (err) {
    log.warn("[host-management] failed to read install record", err);
    return null;
  }
}

interface RegistryUpdateCacheFile {
  readonly checkedAt: string;
  readonly latestVersion: string | null;
  readonly installedVersion: string | null;
  readonly reachable: boolean;
  readonly errorMessage: string | null;
}

let registryRefreshQueue: Promise<void> = Promise.resolve();

function desktopCacheDir(): string {
  return join(homedir(), ".traycer", "desktop");
}

/**
 * Per-environment registry update cache (Ticket 398e84f4). Each environment
 * owns its own file under `~/.traycer/desktop/` - production has no suffix:
 *
 *   - production → `registry-update-cache.json`
 *   - staging    → `registry-update-cache-staging.json`
 *   - dev        → `registry-update-cache-dev.json`
 *
 * `installedVersion` in the cache is derived from the active environment's
 * install record, so reusing one environment's cache in another would
 * surface the wrong "installed/latest" comparison on Settings → Host and
 * the tray. Per-environment scoping keeps them isolated.
 */
function registryCacheFilePath(): string {
  const name =
    activeEnvironment === "production"
      ? "registry-update-cache.json"
      : `registry-update-cache-${activeEnvironment}.json`;
  return join(desktopCacheDir(), name);
}

async function readRegistryCache(): Promise<RegistryUpdateCacheFile | null> {
  const path = registryCacheFilePath();
  let text: string;
  try {
    text = await readFile(path, { encoding: "utf8" });
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed)) {
      log.warn("[host-management] registry cache has invalid shape", { path });
      return null;
    }
    if (typeof parsed.checkedAt !== "string") {
      log.warn("[host-management] registry cache missing checkedAt", { path });
      return null;
    }
    // Defence-in-depth: even though the filename is environment-scoped, also
    // gate on the `environment` field embedded in the snapshot. If an older
    // build (or a manual edit) put the wrong environment in this file, treat
    // the entry as absent rather than projecting it through.
    if (
      typeof parsed.environment === "string" &&
      parsed.environment !== activeEnvironment
    ) {
      log.debug(
        "[host-management] ignored registry cache for other environment",
        {
          path,
          cacheEnvironment: parsed.environment,
          activeEnvironment,
        },
      );
      return null;
    }
    return {
      checkedAt: parsed.checkedAt,
      latestVersion:
        typeof parsed.latestVersion === "string" ? parsed.latestVersion : null,
      installedVersion:
        typeof parsed.installedVersion === "string"
          ? parsed.installedVersion
          : null,
      reachable: parsed.reachable === true,
      errorMessage:
        typeof parsed.errorMessage === "string" ? parsed.errorMessage : null,
    };
  } catch (err) {
    log.warn("[host-management] registry cache read failed", err);
    return null;
  }
}

async function writeRegistryCache(
  snapshot: RegistryUpdateCacheFile,
): Promise<void> {
  const path = registryCacheFilePath();
  try {
    await mkdir(desktopCacheDir(), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ ...snapshot, environment: activeEnvironment }, null, 2),
      { encoding: "utf8" },
    );
  } catch (err) {
    log.warn("[host-management] registry cache write failed", err);
  }
}

function buildUpdateState(
  cache: RegistryUpdateCacheFile,
): HostRegistryUpdateState {
  // An update is only available when the installed host is *older* than the
  // registry's latest. `compareHostVersions` orders by full SemVer precedence,
  // including pre-releases: `1.0.0-rc.1 < 1.0.0`, so a release-candidate host
  // upgrades to its GA (a plain `!==` or a pre-release-stripping compare reads
  // rc and GA as equal and leaves the host stranded on the rc). It also keeps a
  // host *newer* than the registry pointer (a local/staging build ahead of GA,
  // or a stale cache that never re-read the post-update install record) reading
  // as "up to date" rather than advertising a phantom downgrade.
  const updateAvailable =
    cache.reachable &&
    cache.installedVersion !== null &&
    cache.latestVersion !== null &&
    compareHostVersions(cache.installedVersion, cache.latestVersion) < 0;
  return {
    checkedAt: cache.checkedAt,
    latestVersion: cache.latestVersion,
    installedVersion: cache.installedVersion,
    updateAvailable,
    reachable: cache.reachable,
    errorMessage: cache.errorMessage,
  };
}

// `E_HOST_VERIFY_FAILED` means the CLI couldn't find trusted registry
// signing keys for this build. That can happen by design (dev / local
// builds carry no keys) or as a release-engineering bug (a staging or
// production build that should have had `TRAYCER_EMBEDDED_HOST_PUBKEYS`
// baked in but didn't - see `traycer-cli/scripts/set-deploy-target.cjs`).
// Either way there's nothing the end user can do from Settings → Host,
// so we normalise it as "no updates available" rather than leaking the
// verbose CLI stderr into the Updates row in any environment. When the
// build was supposed to carry keys (staging / production), we still
// surface the condition to logs so release engineering sees it.
const VERIFY_DISABLED_CODE = "E_HOST_VERIFY_FAILED";

function isVerifyDisabledForBuild(err: unknown): boolean {
  if (!(err instanceof TraycerCliError)) return false;
  if (err.code !== VERIFY_DISABLED_CODE) return false;
  if (activeEnvironment !== "dev") {
    log.warn(
      "[host-management] registry probe rejected with E_HOST_VERIFY_FAILED on a build that should carry trusted pubkeys - normalising as 'no updates available' in the UI, but release engineering should investigate",
      { environment: activeEnvironment, message: err.message },
    );
  }
  return true;
}

async function probeRegistry(): Promise<RegistryUpdateCacheFile> {
  const checkedAt = new Date().toISOString();
  try {
    const snapshot = projectAvailableSnapshot(
      await runTraycerCliJson<unknown>(["host", "available", "--json"]),
    );
    const installed = await readInstalledHostRecord();
    const installedVersion = installed?.version ?? null;
    return {
      checkedAt,
      latestVersion: availableLatestVersion(snapshot),
      installedVersion,
      reachable: true,
      errorMessage: null,
    };
  } catch (err) {
    const installed = await readInstalledHostRecord();
    const installedVersion = installed?.version ?? null;
    if (isVerifyDisabledForBuild(err)) {
      // Pin `latestVersion = installedVersion` so `buildUpdateState`'s
      // diff yields `updateAvailable: false` - the Updates row reads
      // "Up to date" instead of a generic error chip.
      return {
        checkedAt,
        latestVersion: installedVersion,
        installedVersion,
        reachable: true,
        errorMessage: null,
      };
    }
    const message =
      err instanceof TraycerCliError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    log.debug("[host-management] registry probe failed (silent)", { message });
    return {
      checkedAt,
      latestVersion: null,
      installedVersion,
      reachable: false,
      errorMessage: message,
    };
  }
}

function availableLatestVersion(
  snapshot: HostAvailableSnapshot,
): string | null {
  if (snapshot.latest.length === 0) {
    return null;
  }
  const latest = snapshot.versions.find(
    (entry) => entry.version === snapshot.latest,
  );
  if (latest === undefined) {
    return null;
  }
  if (latest.platformAsset === null || !latest.platformAsset.available) {
    return null;
  }
  return latest.version;
}

// Empty `HostAvailableSnapshot` used by handlers that need to render a
// "no versions" state without inventing a failure (e.g. dev builds where
// the registry probe is intentionally disabled).
function emptyAvailableSnapshot(): HostAvailableSnapshot {
  return {
    generatedAt: "",
    latest: "",
    platformKey: "",
    manifestUrl: "",
    versions: [],
  };
}

/**
 * Public entry point - Desktop boot calls this once at launch (Flow 6
 * "Discovery via Desktop"), and the periodic/resume re-check calls it on a
 * tighter cadence (Ticket: host-update-race-conditions). Honours the on-disk
 * cache so frequent probes don't spam the registry; never throws.
 *
 * `maxAgeMs` overrides the freshness bound the cache is checked against -
 * `null` means the default `REGISTRY_CACHE_TTL_MS` (24h, the launch/manual
 * behaviour). The periodic/resume callers pass a much shorter bound so a
 * long-running session (or a machine that was asleep across a release)
 * notices a newer version without waiting out the full 24h TTL or requiring
 * a relaunch. Irrelevant when `force` is `true` (the cache is bypassed
 * entirely), but still required so every call site states its intent
 * explicitly.
 */
export async function refreshRegistryUpdateState(opts: {
  readonly force: boolean;
  readonly maxAgeMs: number | null;
}): Promise<HostRegistryUpdateState> {
  const run = registryRefreshQueue.then(
    () => refreshRegistryUpdateStateSerial(opts),
    () => refreshRegistryUpdateStateSerial(opts),
  );
  registryRefreshQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function refreshRegistryUpdateStateSerial(opts: {
  readonly force: boolean;
  readonly maxAgeMs: number | null;
}): Promise<HostRegistryUpdateState> {
  const cache = await readRegistryCache();
  if (!opts.force && cache !== null && cache.reachable) {
    const ageMs = Date.now() - Date.parse(cache.checkedAt);
    const threshold = opts.maxAgeMs ?? REGISTRY_CACHE_TTL_MS;
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < threshold) {
      const state = buildUpdateState(cache);
      emitHostRegistryUpdateState(state);
      return state;
    }
  }
  const fresh = await probeRegistry();
  await writeRegistryCache(fresh);
  const state = buildUpdateState(fresh);
  emitHostRegistryUpdateState(state);
  return state;
}

function projectUninstallResult(
  raw: unknown,
  requested: { readonly all: boolean },
): HostUninstallResult {
  if (!isPlainObject(raw)) {
    return {
      removedInstallDir: false,
      deregisteredService: false,
    };
  }
  return {
    removedInstallDir:
      raw.removedInstallDir === true || raw.removedRecord === true,
    deregisteredService:
      raw.deregisteredService === true ||
      raw.serviceUninstalled === true ||
      (requested.all && raw.serviceUninstalled !== false),
  };
}

// Project the CLI's `host uninstall --all` payload into the in-app removal
// summary. `--all` always requests service deregistration, so a CLI that
// An explicit user-driven (re)provision - install host, update host, register
// service - means the user wants the host back on this device. Clear the
// removal sentinel so the host stops being treated as removed; otherwise the
// host would come back but the gate would still show the removed surface and
// `ensureHost` would keep short-circuiting. No-op (and no disk write) when the
// device was not removed.
async function clearHostRemovalIfSet(): Promise<void> {
  if (await isHostRemovedByUser()) {
    await clearHostRemovedByUser();
  }
}

function projectFreePortAndRestartResult(
  raw: unknown,
  fallback: FreePortAndRestartInput,
): FreePortAndRestartInput {
  if (!isPlainObject(raw)) return fallback;
  const port =
    typeof raw.port === "number" && Number.isFinite(raw.port)
      ? raw.port
      : fallback.port;
  const pid =
    typeof raw.pid === "number" && Number.isFinite(raw.pid)
      ? raw.pid
      : fallback.pid;
  const processName =
    typeof raw.processName === "string"
      ? raw.processName
      : fallback.processName;
  return { port, pid, processName };
}

function projectInstallResult(raw: unknown): HostInstallResult {
  if (!isPlainObject(raw)) {
    throw new Error("host install: malformed result");
  }
  const sourceRaw = isPlainObject(raw.source) ? raw.source : null;
  const lifecycleRaw = isPlainObject(raw.serviceLifecycle)
    ? raw.serviceLifecycle
    : null;
  return {
    version: typeof raw.version === "string" ? raw.version : "",
    installedAt: typeof raw.installedAt === "string" ? raw.installedAt : "",
    executablePath:
      typeof raw.executablePath === "string" ? raw.executablePath : "",
    source:
      sourceRaw === null
        ? { kind: "registry", value: "" }
        : {
            kind: sourceRaw.kind === "local-file" ? "local-file" : "registry",
            value: typeof sourceRaw.value === "string" ? sourceRaw.value : "",
          },
    archiveSha256:
      typeof raw.archiveSha256 === "string" ? raw.archiveSha256 : "",
    signatureKeyId:
      typeof raw.signatureKeyId === "string" ? raw.signatureKeyId : "",
    sizeBytes: typeof raw.sizeBytes === "number" ? raw.sizeBytes : 0,
    previousVersion:
      typeof raw.previousVersion === "string" ? raw.previousVersion : null,
    serviceLifecycle:
      lifecycleRaw === null
        ? {
            priorServiceState: "not-installed",
            stoppedBeforeSwap: false,
            postSwapAction: "none",
            postSwapError: null,
          }
        : {
            priorServiceState:
              lifecycleRaw.priorServiceState === "running" ||
              lifecycleRaw.priorServiceState === "stopped" ||
              lifecycleRaw.priorServiceState === "not-installed" ||
              lifecycleRaw.priorServiceState === "externally-managed"
                ? lifecycleRaw.priorServiceState
                : "not-installed",
            stoppedBeforeSwap: lifecycleRaw.stoppedBeforeSwap === true,
            postSwapAction: narrowPostSwapAction(lifecycleRaw.postSwapAction),
            postSwapError:
              typeof lifecycleRaw.postSwapError === "string"
                ? lifecycleRaw.postSwapError
                : null,
          },
  };
}

type PostSwapAction = "install" | "restart" | "start" | "none";

/**
 * Project the CLI-reported `postSwapAction` into the Desktop union. A
 * legitimately absent field (the CLI didn't run a post-swap step) maps to
 * `"none"` silently. An *unknown* string is the interesting case: it means
 * the CLI emitted a value Desktop doesn't recognise - a version skew
 * between CLI and Desktop. We collapse it to `"none"` so the renderer
 * stays well-formed but log a warning with the raw value so the drift
 * shows up in support bundles instead of disappearing silently.
 */
export function narrowPostSwapAction(raw: unknown): PostSwapAction {
  if (raw === "install") return "install";
  if (raw === "restart") return "restart";
  if (raw === "start") return "start";
  // An explicit "none" is routine (e.g. an externally-managed/SMAppService
  // label where the CLI deliberately leaves the service alone) - it must not
  // trip the version-skew warning below.
  if (raw === "none") return "none";
  if (raw === undefined) return "none";
  log.warn(
    "[host-management] unknown postSwapAction value from CLI - collapsing to 'none'",
    { raw },
  );
  return "none";
}

export function registerHostManagementIpc(bridge: RunnerIpcBridge): void {
  bridge.disposeFns.push(
    onHostRegistryUpdateStateChange((state) => {
      bridge.fanOut(RunnerHostEvent.hostRegistryUpdateStateChange, state);
    }),
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerHostInstall,
    async (_event, raw: unknown) => {
      await clearHostRemovalIfSet();
      const version = optionalString(raw, "version");
      const operationId = optionalString(raw, "operationId") ?? randomUUID();
      const args = [
        "host",
        "install",
        ...(version !== null && version !== "latest" ? [version] : ["latest"]),
      ];
      const data = await streamCliWithProgress(
        args,
        operationId,
        "install",
        LONG_OP_TIMEOUT_MS,
        bridge,
      );
      // The install record on disk now points at the freshly installed
      // version. Re-probe the registry so the cached `installedVersion`
      // (and `updateAvailable`) reflect it - otherwise the 24h TTL cache
      // keeps the launch-time snapshot and the Updates row / banner stay
      // stuck advertising the version we just installed.
      await refreshRegistryUpdateState({ force: true, maxAgeMs: null });
      return projectInstallResult(data);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerHostUpdate,
    async (_event, raw: unknown) => {
      await clearHostRemovalIfSet();
      const operationId = optionalString(raw, "operationId") ?? randomUUID();
      const data = await streamCliWithProgress(
        ["host", "update"],
        operationId,
        "update",
        LONG_OP_TIMEOUT_MS,
        bridge,
      );
      await refreshRegistryUpdateState({ force: true, maxAgeMs: null });
      return projectInstallResult(data);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerHostUninstall,
    async (_event, raw: unknown) => {
      const all = optionalBoolean(raw, "all");
      const args = ["host", "uninstall"];
      if (all) args.push("--all");
      const data = await runTraycerCliJson<unknown>(args);
      return projectUninstallResult(data, { all });
    },
  );

  // In-app "Remove Traycer" (Settings → General → Danger Zone). Orchestrates
  // the full background-component teardown while preserving all user data:
  //   1. mark the device removed-by-user FIRST, so a crash mid-uninstall
  //      still suppresses auto-reinstall on the next launch;
  //   2. on macOS shipped builds, drop the SMAppService / BTM login item the
  //      desktop owns (the CLI's `host uninstall --all` cannot - it only
  //      boots out the launchd plist, leaving BTM to respawn the host);
  //   3. run `host uninstall --all` to stop + deregister the service and
  //      remove the host install. `~/.traycer` user data is never touched
  //      (the CLI has no purge path by design).
  bridge.handleInvoke(RunnerHostInvoke.traycerAppUninstall, async () => {
    await markHostRemovedByUser();

    let removedLoginItem = false;
    if (await hostManagesHostLoginItem()) {
      await unregisterHostLoginItem();
      removedLoginItem = true;
    }

    const data = await runTraycerCliJson<unknown>([
      "host",
      "uninstall",
      "--all",
    ]);
    const uninstalled = projectUninstallResult(data, { all: true });

    // Refresh the registry cache so `installedVersion` (now absent) drives
    // `updateAvailable` to false. That makes every update-driven reinstall
    // vector - the launch/quit auto-update reconciles and the tray "update
    // available" affordance - naturally no-op through their existing
    // `updateAvailable` guards. Tolerated: a failed probe must never fail an
    // otherwise-complete uninstall.
    await refreshRegistryUpdateState({
      force: true,
      maxAgeMs: null,
    }).catch((err: unknown) => {
      log.warn("[host-management] registry refresh after uninstall failed", {
        err,
      });
    });

    const result: TraycerUninstallResult = {
      removedHost: uninstalled.removedInstallDir,
      deregisteredService: uninstalled.deregisteredService,
      removedLoginItem,
    };
    log.info("[host-management] in-app uninstall complete", { ...result });
    return result;
  });

  bridge.handleInvoke(
    RunnerHostInvoke.traycerHostRemovalGet,
    async (): Promise<HostRemovalState> => {
      return { removedByUser: await isHostRemovedByUser() };
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.traycerHostRemovalClear, async () => {
    await clearHostRemovedByUser();
  });

  bridge.handleInvoke(RunnerHostInvoke.traycerHostInstalled, async () => {
    return readInstalledHostRecord();
  });

  bridge.handleInvoke(RunnerHostInvoke.traycerHostRestart, async () => {
    await runTraycerCliJson<unknown>(["host", "restart", "--json"]);
  });

  bridge.handleInvoke(
    RunnerHostInvoke.traycerHostLogs,
    async (_event, raw: unknown) => {
      const tail = optionalNumber(raw, "tailLines") ?? 200;
      const args = ["host", "logs", "--tail", String(tail)];
      const data = await runTraycerCliJson<unknown>([...args, "--json"]);
      if (!isPlainObject(data)) {
        const result: HostLogsTailResult = { path: null, tail: "" };
        return result;
      }
      const result: HostLogsTailResult = {
        path: typeof data.path === "string" ? data.path : null,
        tail: typeof data.tail === "string" ? data.tail : "",
      };
      return result;
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.traycerHostDoctor, async () => {
    const raw = await runTraycerCliJson<unknown>(["host", "doctor", "--json"]);
    return projectDoctorReport(raw);
  });

  bridge.handleInvoke(
    RunnerHostInvoke.traycerHostAvailable,
    async (_event, raw: unknown) => {
      const includePreReleases = optionalBoolean(raw, "includePreReleases");
      const args = [
        "host",
        "available",
        "--json",
        ...(includePreReleases ? ["--include-pre-releases"] : []),
      ];
      try {
        const result = await runTraycerCliJson<unknown>(args);
        return projectAvailableSnapshot(result);
      } catch (err) {
        // Dev builds reject this command with `E_HOST_VERIFY_FAILED`
        // because no trusted signing keys are bundled. Surface that as an
        // empty version list rather than leaking the CLI's stderr to the
        // Settings → Host "Pick a different version" row, where there
        // is no user action that can recover from it. Production builds
        // carry the keys, so the same error there still propagates.
        if (isVerifyDisabledForBuild(err)) {
          return emptyAvailableSnapshot();
        }
        throw err;
      }
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerServiceRegister,
    async (_event, raw: unknown) => {
      await clearHostRemovalIfSet();
      const operationId = optionalString(raw, "operationId") ?? randomUUID();
      // Dev environment needs the staged wrapper / self-invocation flags so
      // service reregister works without a per-run dev manifest
      // (Ticket f0ae4530). Prod returns []; this never widens prod's
      // host service install argv.
      const args = [
        "host",
        "service",
        "install",
        ...(await devServiceInstallExtras()),
      ];
      await streamCliWithProgress(
        args,
        operationId,
        "register-service",
        LONG_OP_TIMEOUT_MS,
        bridge,
      );
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.traycerServiceDeregister, async () => {
    await runTraycerCliJson<unknown>(["host", "service", "uninstall"]);
  });

  bridge.handleInvoke(
    RunnerHostInvoke.traycerRegistryCheck,
    async (_event, raw: unknown) => {
      const force = optionalBoolean(raw, "force");
      return refreshRegistryUpdateState({ force, maxAgeMs: null });
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerHostOperationStatusGet,
    async () => {
      return getHostOperationStatus();
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerFreePortAndRestart,
    async (_event, raw: unknown) => {
      // Flow 4 step 7: confirmation is the renderer's responsibility - by
      // the time we get here the user has already approved killing the
      // foreign process. Per the Tech Plan, Desktop maps Doctor fix
      // actions back to CLI subcommands and never invents repairs, so we
      // delegate the kill + restart to `traycer host free-port-and-restart`
      // via NDJSON instead of calling `process.kill` from main.
      const port = optionalNumber(raw, "port");
      const pid = optionalNumber(raw, "pid");
      const processName = optionalString(raw, "processName");
      log.info("[host-management] free-port restart confirmed", {
        port,
        pid,
        processName,
      });
      const args = ["host", "free-port-and-restart"];
      if (pid !== null) args.push("--pid", String(pid));
      if (port !== null) args.push("--port", String(port));
      const data = await runTraycerCliJson<unknown>(args);
      return projectFreePortAndRestartResult(data, {
        port: port ?? 0,
        pid,
        processName,
      });
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.traycerCliManifestRead, async () => {
    // Environment-scope the CLI manifest + reconcile sidecar lookup so dev
    // Desktop never reads the prod manifest (and vice versa). Layout
    // mirrors `cliManifestPath()` in
    // `clients/traycer-cli/src/store/paths.ts`:
    //   prod    → ~/.traycer/cli/manifest.json
    //   dev     → ~/.traycer/cli/dev/manifest.json
    //   dev run → ~/.traycer/cli/dev-runs/<slot>/manifest.json
    // The desktop-reconcile sidecar is Desktop-owned and lives next to
    // the manifest, so it follows the same environment layout.
    const cliSlotRoot = cliSlotRootForEnvironment(activeEnvironment);
    const manifestPath = join(cliSlotRoot, "manifest.json");
    const reconcilePath = join(cliSlotRoot, "desktop-reconcile.json");
    const reconcile = await readReconcileSidecar(reconcilePath);
    let text: string;
    try {
      text = await readFile(manifestPath, { encoding: "utf8" });
    } catch {
      // No per-user manifest. Mirror the CLI's prod-only Linux system
      // marker fallback (`readSystemSourceMarker` in
      // `traycer-cli/src/manifest/cli-manifest.ts`) so Settings → Host
      // doesn't show "no install record" for an apt/rpm-installed CLI
      // that has yet to write its in-home manifest. The schema is
      // duplicated here intentionally - see `readSystemSourceMarker`
      // below for the rationale.
      const synthesized = await readSystemSourceMarker();
      if (synthesized === null) return null;
      return { ...synthesized, packageManagerUpgrade: null };
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isPlainObject(parsed)) return parsed;
      // Project the manifest into the renderer-facing shape, splicing in
      // any Desktop-owned launch-time hint (e.g. "your homebrew traycer
      // is older than the bundled CLI - `brew upgrade traycer`"). The
      // hint is only attached when the manifest still matches the version
      // the hint was recorded against, so a stale sidecar can't shadow a
      // freshly upgraded package.
      const manifestVersion =
        typeof parsed.version === "string" ? parsed.version : null;
      const hint = projectPackageManagerHint(reconcile, manifestVersion);
      return { ...parsed, packageManagerUpgrade: hint };
    } catch (err) {
      log.warn("[host-management] cli manifest read failed", err);
      return null;
    }
  });

  bridge.handleInvoke(RunnerHostInvoke.traycerHostNameGet, async () => {
    return readHostNameSettings(activeLayout());
  });

  bridge.handleInvoke(
    RunnerHostInvoke.traycerHostNameSet,
    async (_event, raw: unknown) => {
      const settings = await writeHostNameSettings(
        activeLayout(),
        nullableString(raw, "customName"),
      );
      await bridge.options.host.reloadSnapshotFromDisk();
      return settings;
    },
  );
}

/**
 * Linux-only, prod-environment-only fallback that mirrors the CLI's
 * `readSystemSourceMarker` (see
 * `clients/traycer-cli/src/manifest/cli-manifest.ts`). When no
 * per-user manifest exists yet (typical right after an unattended apt /
 * rpm install before the first `traycer` invocation) but a system marker
 * is present, synthesize a partial manifest snapshot so the Settings →
 * Host CLI section stays in lockstep with what `traycer cli show`
 * would report.
 *
 * The schema is intentionally duplicated rather than imported - Desktop
 * and the CLI ship as separate processes/bundles, and the CLI's source
 * tree is not a build-time dependency of the desktop main bundle. Any
 * change to the marker payload must update both call sites. Restricted
 * to `activeEnvironment === "production"` because dev never installs via
 * a system package manager, and to `process.platform === "linux"`
 * because the marker paths are Linux-specific.
 */
const SYSTEM_SOURCE_MARKER_APT = "/var/lib/traycer/source.apt";
const SYSTEM_SOURCE_MARKER_RPM = "/var/lib/traycer/source.rpm";

interface SystemMarkerSnapshot {
  readonly version: string;
  readonly installedAt: string;
  readonly binaryPath: string;
  readonly source: "apt" | "rpm";
  readonly pendingUpgrade: null;
}

async function readSystemSourceMarker(): Promise<SystemMarkerSnapshot | null> {
  if (process.platform !== "linux") return null;
  if (activeEnvironment !== "production") return null;
  const candidates: ReadonlyArray<{
    readonly path: string;
    readonly source: "apt" | "rpm";
  }> = [
    { path: SYSTEM_SOURCE_MARKER_APT, source: "apt" },
    { path: SYSTEM_SOURCE_MARKER_RPM, source: "rpm" },
  ];
  for (const { path, source } of candidates) {
    let raw: string;
    try {
      raw = await readFile(path, { encoding: "utf8" });
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log.warn("[host-management] system source marker is not valid JSON", {
        path,
      });
      continue;
    }
    if (!isPlainObject(parsed)) continue;
    const binaryPath =
      typeof parsed.binaryPath === "string" ? parsed.binaryPath : null;
    const version = typeof parsed.version === "string" ? parsed.version : null;
    if (
      binaryPath === null ||
      binaryPath.length === 0 ||
      version === null ||
      version.length === 0
    ) {
      continue;
    }
    return {
      version,
      // The marker has no recorded install timestamp; epoch zero matches
      // the CLI's synthesized manifest so renderer comparisons stay
      // consistent across the two surfaces.
      installedAt: new Date(0).toISOString(),
      binaryPath,
      source,
      pendingUpgrade: null,
    };
  }
  return null;
}

async function readReconcileSidecar(
  path: string,
): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readFile(path, { encoding: "utf8" });
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch (err) {
    log.warn("[host-management] desktop-reconcile read failed", err);
    return null;
  }
}

function projectPackageManagerHint(
  reconcile: Record<string, unknown> | null,
  manifestVersion: string | null,
): Record<string, unknown> | null {
  if (reconcile === null) return null;
  const pkg = reconcile.packageManagerUpgrade;
  if (!isPlainObject(pkg)) return null;
  // If the manifest now reports a version >= the version we recorded the
  // hint against, the user has upgraded since launch - drop the stale hint.
  if (
    typeof pkg.installedVersion === "string" &&
    manifestVersion !== null &&
    manifestVersion !== pkg.installedVersion
  ) {
    return null;
  }
  return pkg;
}

/**
 * Convenience getter used by the tray and main-process registry check.
 * Exposed alongside the IPC handlers so the boot path doesn't have to
 * re-implement projection logic.
 */
export async function readInstalledHostRecordForBoot(): Promise<HostInstalledRecord | null> {
  return readInstalledHostRecord();
}
