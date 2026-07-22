import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../app/logger";
import { runTraycerCliJson, TraycerCliError } from "../cli/traycer-cli";
import { RunnerHostInvoke } from "../../ipc-contracts/ipc-channels";
import type {
  HostAvailableSnapshot,
  HostAvailableVersionEntry,
  HostDoctorReport,
  HostInstalledRecord,
  HostLogsTailResult,
  HostRegistryUpdateState,
  HostRemovalState,
  FreePortAndRestartInput,
} from "../../ipc-contracts/host-management-types";
import type { MutationOutcome } from "../host/host-controller-types";
import {
  clearHostRemovedByUser,
  isHostRemovedByUser,
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
import type { IpcHostController, RunnerIpcBridge } from "./runner-ipc-bridge";

export const LONG_OP_TIMEOUT_MS = 10 * 60_000;
const REGISTRY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

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

/** Every non-"ok" outcome rejects the IPC invoke - matches the legacy
 * CLI-throw contract for the handlers that never had a "keep the old
 * host, surface it for a compat probe" branch. */
function okOrThrow<TOk>(outcome: MutationOutcome<TOk>): TOk {
  if (outcome.kind !== "ok") {
    throw new Error(outcome.message);
  }
  return outcome.value;
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

export function projectDoctorReport(raw: unknown): HostDoctorReport {
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
 * Per-environment (and, for dev, per-slot) registry update cache (Ticket
 * 398e84f4). Each environment owns its own file under `~/.traycer/desktop/` -
 * production has no suffix:
 *
 *   - production → `registry-update-cache.json`
 *   - staging    → `registry-update-cache-staging.json`
 *   - dev        → `registry-update-cache-dev.json`
 *   - dev (slot) → `registry-update-cache-dev-<slot>.json`
 *
 * `installedVersion` in the cache is derived from the active environment's
 * install record, so reusing one environment's cache in another would
 * surface the wrong "installed/latest" comparison on Settings → Host and
 * the tray. Per-environment scoping keeps them isolated.
 *
 * Fixup B5: dev runs are per-worktree ("Dev run slots" D1-D4/D7) - every
 * other piece of dev state (`~/.traycer/{host,cli}/dev-runs/<slot>/...`, see
 * `devDesktopSlotForEnvironment`'s other callers in this file and in
 * `host-paths.ts`) is already slot-scoped so concurrent worktrees never
 * collide. This cache was the one piece left keyed on environment alone -
 * two dev worktrees running `make dev-desktop` simultaneously shared a
 * single `registry-update-cache-dev.json`, so one worktree's registry probe
 * (a different installed/latest pair, since each slot has its own install
 * record) could overwrite the other's cached `updateAvailable` state.
 */
function registryCacheFilePath(): string {
  if (activeEnvironment === "production") {
    return join(desktopCacheDir(), "registry-update-cache.json");
  }
  const devSlot = devDesktopSlotForEnvironment(activeEnvironment, process.env);
  const name =
    devSlot !== null
      ? `registry-update-cache-${activeEnvironment}-${devSlot}.json`
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

// Fixup B1: `updateAvailable` used to be pure registry detection (`latest >
// installed`), so a long session advertised "Update host" the moment the
// registry published a newer version - before any bytes were ever staged,
// violating quiet-until-ready (Tech Plan D3: never advertise an update the
// desktop hasn't actually downloaded yet). It's now projected from
// `HostController`'s own `updateReady` (`staged > installed`, Tech Plan
// "Version identity") - the menu/banner only lights up once there is
// something to actually apply.
function buildUpdateState(
  cache: RegistryUpdateCacheFile,
  updateReady: boolean,
): HostRegistryUpdateState {
  return {
    checkedAt: cache.checkedAt,
    latestVersion: cache.latestVersion,
    installedVersion: cache.installedVersion,
    updateAvailable: updateReady,
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
export async function refreshRegistryUpdateState(
  hostController: IpcHostController,
  opts: {
    readonly force: boolean;
    readonly maxAgeMs: number | null;
  },
): Promise<HostRegistryUpdateState> {
  const run = registryRefreshQueue.then(
    () => refreshRegistryUpdateStateSerial(hostController, opts),
    () => refreshRegistryUpdateStateSerial(hostController, opts),
  );
  registryRefreshQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function refreshRegistryUpdateStateSerial(
  hostController: IpcHostController,
  opts: {
    readonly force: boolean;
    readonly maxAgeMs: number | null;
  },
): Promise<HostRegistryUpdateState> {
  const cache = await readRegistryCache();
  if (!opts.force && cache !== null && cache.reachable) {
    const ageMs = Date.now() - Date.parse(cache.checkedAt);
    const threshold = opts.maxAgeMs ?? REGISTRY_CACHE_TTL_MS;
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < threshold) {
      const status = await hostController.getStatus();
      return buildUpdateState(cache, status.updateReady);
    }
  }
  const fresh = await probeRegistry();
  await writeRegistryCache(fresh);
  const status = await hostController.getStatus();
  const state = buildUpdateState(fresh, status.updateReady);
  if (fresh.reachable) {
    // Fixup B1: stage the eligible update in the background on every
    // successful refresh (comparable `latest > installed`, or the
    // yank-heal reconcile arm when a stage already exists - both decided
    // by `stageLatest`'s own eligibility check) - never awaited here, so a
    // registry check never blocks on a WAN download. The status broadcast
    // (`host-controller-status-broadcast.ts`) picks up the staged version
    // via its own poll once the download lane shows activity; no explicit
    // republish needed here.
    void hostController.stageLatest().catch((err) => {
      log.debug("[host-registry] background stage completion failed", {
        err,
      });
    });
  }
  return state;
}

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

export function registerHostManagementIpc(bridge: RunnerIpcBridge): void {
  bridge.handleInvoke(
    RunnerHostInvoke.traycerHostControllerStatusGet,
    async () => {
      return bridge.options.hostController.getStatus();
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerHostConvergeReady,
    async (_event, raw: unknown) => {
      const force = optionalBoolean(raw, "force");
      return bridge.options.hostController.convergeReady(force);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerHostApplyStaged,
    async (_event, raw: unknown) => {
      await clearHostRemovalIfSet();
      const trigger =
        optionalString(raw, "trigger") === "launch" ? "launch" : "manual";
      const force = optionalBoolean(raw, "force");
      // `applyStaged`'s own preflight reconciles/downloads the eligible
      // stage before applying it - no separate `stageLatest()` call needed
      // here.
      const outcome = await bridge.options.hostController.applyStaged(
        trigger,
        force,
      );
      if (outcome.kind === "ok") {
        // The install record on disk now points at the freshly applied
        // version. Re-probe the registry so the cached `installedVersion`
        // (and `updateAvailable`) reflect it - otherwise the 24h TTL cache
        // keeps the pre-apply snapshot and the Updates row stays stuck
        // advertising the version we just installed. Fire-and-forget: the
        // apply already committed, so a rejection in this secondary probe
        // must never turn a successful outcome into a rejected invoke.
        void refreshRegistryUpdateState(bridge.options.hostController, {
          force: true,
          maxAgeMs: null,
        }).catch((err: unknown) => {
          log.warn("[host-management] registry refresh after apply failed", {
            err,
          });
        });
      }
      return outcome;
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerHostActivateInstalled,
    async (_event, raw: unknown) => {
      const force = optionalBoolean(raw, "force");
      return bridge.options.hostController.activateInstalled(force);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerHostInstallVersion,
    async (_event, raw: unknown) => {
      await clearHostRemovalIfSet();
      const pin = optionalString(raw, "pin") ?? "";
      const force = optionalBoolean(raw, "force");
      const outcome = await bridge.options.hostController.installVersion(
        pin,
        force,
      );
      if (outcome.kind === "ok") {
        // Fire-and-forget for the same reason as `traycerHostApplyStaged`
        // above: the pin already committed, so this secondary probe must
        // never turn a successful outcome into a rejected invoke.
        void refreshRegistryUpdateState(bridge.options.hostController, {
          force: true,
          maxAgeMs: null,
        }).catch((err: unknown) => {
          log.warn(
            "[host-management] registry refresh after installVersion failed",
            { err },
          );
        });
      }
      return outcome;
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerHostUninstall,
    async (_event, raw: unknown) => {
      const all = optionalBoolean(raw, "all");
      return okOrThrow(await bridge.options.hostController.uninstallHost(all));
    },
  );

  // In-app "Remove Traycer" (Settings → General → Danger Zone). Orchestrates
  // the full background-component teardown while preserving all user data -
  // marking removed-by-user first, dropping the macOS SMAppService/BTM login
  // item, and running `host uninstall --all` - all owned by
  // `HostController.removeTraycer()` now. `~/.traycer` user data is never
  // touched (the CLI has no purge path by design).
  bridge.handleInvoke(RunnerHostInvoke.traycerAppUninstall, async () => {
    const result = okOrThrow(
      await bridge.options.hostController.removeTraycer(),
    );

    // Refresh the registry cache so `installedVersion` (now absent) drives
    // `updateAvailable` to false. That makes every update-driven reinstall
    // vector - the launch/quit auto-update reconciles and the tray "update
    // available" affordance - naturally no-op through their existing
    // `updateAvailable` guards. Tolerated: a failed probe must never fail an
    // otherwise-complete uninstall.
    await refreshRegistryUpdateState(bridge.options.hostController, {
      force: true,
      maxAgeMs: null,
    }).catch((err: unknown) => {
      log.warn("[host-management] registry refresh after uninstall failed", {
        err,
      });
    });

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
    okOrThrow(await bridge.options.hostController.respawn());
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

  bridge.handleInvoke(RunnerHostInvoke.traycerServiceRegister, async () => {
    await clearHostRemovalIfSet();
    // Dev-slot CLI argv (the staged wrapper / self-invocation flags, Ticket
    // f0ae4530) is owned by `HostController.registerService()` itself,
    // environment-aware since the controller already carries `environment`.
    return bridge.options.hostController.registerService();
  });

  bridge.handleInvoke(RunnerHostInvoke.traycerServiceDeregister, async () => {
    okOrThrow(await bridge.options.hostController.deregisterService());
  });

  bridge.handleInvoke(
    RunnerHostInvoke.traycerRegistryCheck,
    async (_event, raw: unknown) => {
      const force = optionalBoolean(raw, "force");
      return refreshRegistryUpdateState(bridge.options.hostController, {
        force,
        maxAgeMs: null,
      });
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
      okOrThrow(
        await bridge.options.hostController.freePortAndRestart(pid, port),
      );
      // `ActivateInstalledOk` carries no port/pid/processName - echo the
      // confirmed input back, matching the renderer contract's shape.
      const result: FreePortAndRestartInput = {
        port: port ?? 0,
        pid,
        processName,
      };
      return result;
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
