import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../app/logger";
import {
  runBundledTraycerCliJson,
  runTraycerCliJson,
  TraycerCliError,
} from "../cli/traycer-cli";
import { RunnerHostInvoke } from "../../ipc-contracts/ipc-channels";
import type {
  HostAvailableSnapshot,
  HostAvailableVersionEntry,
  HostDoctorReport,
  HostGetInstallationInfoResponse,
  HostInstalledRecord,
  HostLogsTailResult,
  HostRegistryUpdateState,
  HostRemovalState,
  HostUpdateCheckResponseV11,
  MaintenanceDoctorProjection,
  MaintenanceInstallDispatch,
  DoctorRepairDispatch,
  QueuedDoctorRepair,
  QueuedDoctorRepairResult,
  HostRestartRequestResult,
  MutationKind,
  FreePortAndRestartInput,
} from "../../ipc-contracts/host-management-types";
import {
  hostAvailableManifestSchema,
  hostDoctorIssueSchema,
  hostIncludePreReleasesSourceSchema,
  type HostIncludePreReleasesSource,
} from "@traycer/protocol/host/maintenance/index";
import {
  readHostInstallRecordAtPath,
  readHostStagedRecordAt,
  readStoredCliInstallManifestAtPath,
} from "@traycer/protocol/config/installation";
import {
  backgroundMutationOutcome,
  type GuardedMutationOutcome,
  type LifecycleAdmissionBlock,
  type MutationOutcome,
  type LocalHostMutationIntent,
} from "../host/host-controller-types";
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
import { restartRequestResultFromOutcome } from "./host-ipc";
import { classifyLocalHostIdentity } from "../host/local-host-identity";

export const LONG_OP_TIMEOUT_MS = 10 * 60_000;
const REGISTRY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

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

/** Reading an unchecked filter as absent is what would leave an RC host still listing release candidates after the user unticked the box. */
export function triStateBoolean(
  raw: unknown,
  key: string,
): boolean | undefined {
  if (!isPlainObject(raw)) return undefined;
  const value = raw[key];
  return typeof value === "boolean" ? value : undefined;
}

/** Both lanes below answer the same question as that resolver over the same producer, so they must spell it the same way. */
function availableArgsForOverride(
  includePreReleases: boolean | undefined,
): readonly string[] {
  const base = ["host", "available", "--json"];
  if (includePreReleases === undefined) return base;
  return includePreReleases
    ? [...base, "--include-pre-releases"]
    : [...base, NO_INCLUDE_PRE_RELEASES_FLAG];
}

/** The flag only a CLI new enough to know explicit exclusion will accept. */
const NO_INCLUDE_PRE_RELEASES_FLAG = "--no-include-pre-releases";

/**
 * Positive identification, never a generic catch: retrying an unrelated failure would mask a real fault behind a silent second run.
 * Two signals, both naming the flag, so an unknown OTHER option (a caller bug rather than version skew) does not trigger a retry either: 1. the `--json` envelope's.
 */
function rejectedUnknownFlag(err: unknown): boolean {
  if (!(err instanceof TraycerCliError)) return false;
  const details = isPlainObject(err.details) ? err.details : {};
  if (
    details.commanderCode === "commander.unknownOption" &&
    err.message.includes(NO_INCLUDE_PRE_RELEASES_FLAG)
  ) {
    return true;
  }
  return (
    mentionsUnknownOption(err.message) || mentionsUnknownOption(err.stderrTail)
  );
}

function mentionsUnknownOption(text: string): boolean {
  return (
    text.includes("unknown option") &&
    text.includes(NO_INCLUDE_PRE_RELEASES_FLAG)
  );
}

function readCliInclusion(
  payload: unknown,
  requested: boolean | undefined,
): {
  readonly effectiveIncludePreReleases: boolean;
  readonly includePreReleasesSource: HostIncludePreReleasesSource;
} {
  const record = isPlainObject(payload) ? payload : {};
  const source = hostIncludePreReleasesSourceSchema.safeParse(
    record.includePreReleasesSource,
  );
  const effective = record.includePreReleases;
  if (source.success && typeof effective === "boolean") {
    return {
      effectiveIncludePreReleases: effective,
      includePreReleasesSource: source.data,
    };
  }
  if (requested === undefined) {
    return {
      effectiveIncludePreReleases: false,
      includePreReleasesSource: "stable-default",
    };
  }
  return {
    effectiveIncludePreReleases: requested,
    includePreReleasesSource: requested
      ? "explicit-include"
      : "explicit-exclude",
  };
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
 * Scope first: the lane is exclusive and the caller has ALREADY refused the competing install by the time it asks - this bit never admits anything.
 * On a pre-1.2.0 host the latch releases only on a scope flip or its full 60s timer.
 */
function admissionBlockIsUpdateWork(block: LifecycleAdmissionBlock): boolean {
  if (block.kind === "login-item-refresh") return false;
  if (block.lane.kind === "ensure") {
    const progress = block.lane.progress;
    return (
      progress !== null &&
      (progress.percent !== null ||
        progress.bytes !== null ||
        progress.totalBytes !== null ||
        progress.workUnits !== null)
    );
  }
  return block.lane.kind === "install" || block.lane.kind === "apply";
}

function failureMessageOf<TOk>(outcome: MutationOutcome<TOk>): string | null {
  return outcome.kind === "ok" ? null : outcome.message;
}

/**
 * Every non-"ok" outcome rejects the IPC invoke - matches the legacy CLI-throw contract for the handlers that never had a "keep the old host, surface it for a compat probe" branch.
 * An `abandoned` outcome (the lane-head identity guard refused a user repair) rejects identically: the one guarded caller that reaches this helper - the queued free-port restart.
 */
function okOrThrow<TOk>(outcome: GuardedMutationOutcome<TOk>): TOk {
  if (outcome.kind !== "ok") {
    throw new Error(outcome.message);
  }
  return outcome.value;
}

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

/** - Unpackaged Desktop (`make dev-desktop`, dev environment) sees the dev install record and never falsely reads/mutates the user's production host state - Ticket 29cf341f. */
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

/**
 * Whether this machine's host is still the one the caller meant, with the refusal words when it is not.
 * The scope that built the request can hold a FROZEN id (an explicitly-scoped requester keeps answering with the row it was created for), so the renderer cannot be the one to.
 */
async function checkLocalHostIsStill(
  bridge: RunnerIpcBridge,
  expectedHostId: string,
): Promise<
  { readonly ok: true } | { readonly ok: false; readonly message: string }
> {
  const live = await classifyLocalHostIdentity({
    identityEnrollmentFile: bridge.options.host.identityEnrollmentFile,
    pidMetadataFile: bridge.options.host.pidMetadataFile,
  });
  switch (live.kind) {
    case "named":
      return live.hostId === expectedHostId
        ? { ok: true }
        : { ok: false, message: HOST_CHANGED_MESSAGE };
    case "unverifiable":
      return { ok: false, message: HOST_UNVERIFIED_MESSAGE };
    case "unenrolled":
      return { ok: true };
  }
}

/**
 * Checking only beforehand proves the host was A when we asked - it says nothing about whose bytes came back, and the caller renders those bytes under A's name.
 * So the same question is asked again after the read and a mismatch discards the result rather than attributing another machine's log, report or install record to the scope that.
 */
async function fencedLocalHostRead<T>(
  bridge: RunnerIpcBridge,
  expectedHostId: string,
  read: () => Promise<T>,
): Promise<T> {
  const before = await checkLocalHostIsStill(bridge, expectedHostId);
  if (!before.ok) {
    throw new Error(before.message);
  }
  const value = await read();
  const after = await checkLocalHostIsStill(bridge, expectedHostId);
  if (!after.ok) {
    throw new Error(after.message);
  }
  return value;
}

/**
 * Both repair routes build it: the queued one because its wait is unbounded, and the watched one because its lane test must stay atomic and so cannot afford the sentinel read inline.
 * A lane-head refusal comes back as the `abandoned` arm of the OUTCOME, not as state parked in this factory: two windows submitting the same repair for the same host coalesce into.
 */
function userRepairIntent(
  bridge: RunnerIpcBridge,
  expectedHostId: string,
): LocalHostMutationIntent {
  return {
    kind: "user-repair",
    targetHostId: expectedHostId,
    guard: async () => {
      const identity = await checkLocalHostIsStill(bridge, expectedHostId);
      return identity.ok
        ? { kind: "proceed" }
        : { kind: "abandon", message: identity.message };
    },
  };
}

const HOST_CHANGED_MESSAGE =
  "This computer's host changed while that was open. Reopen Settings and try again.";

const HOST_UNVERIFIED_MESSAGE =
  "This computer's host can't confirm its identity right now. Try again in a moment.";

export function laneBusyRestartMessage(kind: MutationKind): string {
  switch (kind) {
    case "install":
    case "apply":
    case "activate":
    case "ensure":
      return "Traycer is installing an update on this host. Restart it once that finishes.";
    case "register":
    case "deregister":
      return "Traycer is changing this host's background service. Restart it once that finishes.";
    case "uninstallHost":
    case "removeTraycer":
      return "Traycer is removing this host. There is nothing to restart until that finishes.";
    case "respawn":
    case "recoverIfDown":
    case "freePortAndRestart":
      return "This host is already restarting.";
  }
}

export function admissionBlockRestartMessage(
  block: LifecycleAdmissionBlock,
): string {
  switch (block.kind) {
    case "mutation":
      return laneBusyRestartMessage(block.lane.kind);
    case "login-item-refresh":
      return "Traycer is refreshing this host's background service registration. Try again once that finishes.";
  }
}

export function classifyCliShellError(
  err: unknown,
): "cli-unavailable" | "cli-failed" | "invalid-output" {
  if (!(err instanceof TraycerCliError)) return "cli-unavailable";
  if (err.exitCode === 0 && err.code === null) return "invalid-output";
  return "cli-failed";
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

/** Honours the on-disk cache so frequent probes don't spam the registry; never throws. */
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
    void hostController.stageLatest().catch((err) => {
      log.debug("[host-registry] background stage completion failed", {
        err,
      });
    });
  }
  return state;
}

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
      // Narrowed before crossing IPC: the renderer's contract is plain `MutationOutcome`, and a guardless intent cannot be abandoned.
      return backgroundMutationOutcome(
        await bridge.options.hostController.convergeReady(force, {
          kind: "background",
        }),
      );
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
        // Fire-and-forget: the apply already committed, so a rejection in this secondary probe must never turn a successful outcome into a rejected invoke.
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

  // `~/.traycer` user data is never touched (the CLI has no purge path by design).
  bridge.handleInvoke(RunnerHostInvoke.traycerAppUninstall, async () => {
    const result = okOrThrow(
      await bridge.options.hostController.removeTraycer(),
    );

    // Tolerated: a failed probe must never fail an otherwise-complete uninstall.
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
    return restartRequestResultFromOutcome(
      await bridge.options.hostController.respawn({ kind: "background" }),
    );
  });

  bridge.handleInvoke(
    RunnerHostInvoke.traycerHostRestartIfIdle,
    async (_event, raw: unknown): Promise<HostRestartRequestResult> => {
      const expectedHostId = optionalString(raw, "expectedHostId") ?? "";
      const identity = await checkLocalHostIsStill(bridge, expectedHostId);
      if (!identity.ok) {
        return { kind: "declined", message: identity.message };
      }
      // `respawn()` goes through the same exclusive lane as every other intent and queues behind it rather than being refused, so a Settings restart submitted while an install, apply or.
      // `respawn()` registers on the tail synchronously, and building the intent is synchronous too - only its guard runs later, at the head of the lane.
      const block = bridge.options.hostController.lifecycleAdmissionBlock;
      if (block !== null) {
        return {
          kind: "declined",
          message: admissionBlockRestartMessage(block),
        };
      }
      return restartRequestResultFromOutcome(
        await bridge.options.hostController.respawn(
          userRepairIntent(bridge, expectedHostId),
        ),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerHostLogs,
    async (_event, raw: unknown) => {
      const expectedHostId = optionalString(raw, "expectedHostId") ?? "";
      return fencedLocalHostRead(bridge, expectedHostId, async () => {
        const tail = optionalNumber(raw, "tailLines") ?? 200;
        const args = ["host", "logs", "--tail", String(tail)];
        const data = await runTraycerCliJson<unknown>([...args, "--json"]);
        if (!isPlainObject(data)) {
          const empty: HostLogsTailResult = { path: null, tail: "" };
          return empty;
        }
        const result: HostLogsTailResult = {
          path: typeof data.path === "string" ? data.path : null,
          tail: typeof data.tail === "string" ? data.tail : "",
        };
        return result;
      });
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerHostDoctor,
    async (_event, raw: unknown) => {
      const expectedHostId = optionalString(raw, "expectedHostId") ?? "";
      return fencedLocalHostRead(bridge, expectedHostId, async () => {
        const json = await runTraycerCliJson<unknown>([
          "host",
          "doctor",
          "--json",
        ]);
        return projectDoctorReport(json);
      });
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerHostAvailable,
    async (_event, raw: unknown) => {
      const requested = triStateBoolean(raw, "includePreReleases");
      try {
        return projectAvailableSnapshot(
          await runTraycerCliJson<unknown>(availableArgsForOverride(requested)),
        );
      } catch (err) {
        if (requested === false && rejectedUnknownFlag(err)) {
          return projectAvailableSnapshot(
            await runTraycerCliJson<unknown>(
              availableArgsForOverride(undefined),
            ),
          );
        }
        if (isVerifyDisabledForBuild(err)) {
          return emptyAvailableSnapshot();
        }
        throw err;
      }
    },
  );


  bridge.handleInvoke(
    RunnerHostInvoke.traycerMaintenanceUpdateCheck,
    async (_event, raw: unknown): Promise<HostUpdateCheckResponseV11> => {
      const expectedHostId = optionalString(raw, "expectedHostId") ?? "";
      return fencedLocalHostRead(bridge, expectedHostId, async () => {
        const requested = triStateBoolean(raw, "includePreReleases");
        const args = availableArgsForOverride(requested);
        let payload: unknown;
        try {
          payload = await runBundledTraycerCliJson<unknown>(args);
        } catch (err) {
          // The host's own `host.update.check` resolver returns the classified outcome for any non-ok CLI result and never synthesises a manifest, and this lane answers the same wire.
          return { outcome: classifyCliShellError(err) };
        }
        const manifest = hostAvailableManifestSchema.safeParse(
          isPlainObject(payload) ? payload.manifest : undefined,
        );
        if (!manifest.success) {
          log.warn(
            "[host-management] maintenance update-check payload invalid",
            {
              issues: manifest.error.issues.slice(0, 3),
            },
          );
          return { outcome: "invalid-output" };
        }
        return {
          outcome: "ok",
          manifest: manifest.data,
          ...readCliInclusion(payload, requested),
        };
      });
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerMaintenanceDoctor,
    async (_event, raw: unknown): Promise<MaintenanceDoctorProjection> => {
      const expectedHostId = optionalString(raw, "expectedHostId") ?? "";
      return fencedLocalHostRead(bridge, expectedHostId, async () => {
        let payload: unknown;
        try {
          payload = await runBundledTraycerCliJson<unknown>([
            "host",
            "doctor",
            "--json",
          ]);
        } catch (err) {
          return { status: classifyCliShellError(err) };
        }
        // On this lane a report the protocol cannot parse IS the `invalid-output` arm - the same answer the host's resolver gives for the same bytes.
        const issues = hostDoctorIssueSchema
          .array()
          .safeParse(isPlainObject(payload) ? payload.issues : undefined);
        if (!issues.success) {
          log.warn("[host-management] maintenance doctor payload invalid", {
            issues: issues.error.issues.slice(0, 3),
          });
          return { status: "invalid-output" };
        }
        return { status: "ok", issues: issues.data };
      });
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerMaintenanceInstallationInfo,
    async (_event, raw: unknown): Promise<HostGetInstallationInfoResponse> => {
      const expectedHostId = optionalString(raw, "expectedHostId") ?? "";
      return fencedLocalHostRead(bridge, expectedHostId, async () => {
        const layout = activeLayout();
        const installRecord = await readHostInstallRecordAtPath(
          layout.installRecordFile,
        );
        if (installRecord === null) return { status: "unmanaged" };
        const [stagedRecord, cliManifest] = await Promise.all([
          readHostStagedRecordAt(layout.stagedDir),
          readStoredCliInstallManifestAtPath(
            join(cliSlotRootForEnvironment(activeEnvironment), "manifest.json"),
          ),
        ]);
        return { status: "managed", installRecord, stagedRecord, cliManifest };
      });
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerMaintenanceInstallVersion,
    async (_event, raw: unknown): Promise<MaintenanceInstallDispatch> => {
      const version = optionalString(raw, "version") ?? "";
      const force = optionalBoolean(raw, "force");
      const expectedHostId = optionalString(raw, "expectedHostId") ?? "";
      // BEFORE the lane test, never between it and the submission.
      const identity = await checkLocalHostIsStill(bridge, expectedHostId);
      if (!identity.ok) {
        throw new Error(identity.message);
      }
      // The lane is exclusive but it does not refuse a distinct intent - `enqueueMutation` chains it onto `mutationTail`.
      // Main is single-threaded and `installVersion` registers on the tail synchronously, so testing the lane and calling it with NO await in between admits no interleaving.
      const installBlock =
        bridge.options.hostController.lifecycleAdmissionBlock;
      if (installBlock !== null) {
        // WHAT holds the lane decides how the compatibility lane answers.
        // Only real update work may be reported as `already-updating`;
        // anything else is transient contention and says so.
        return {
          kind: "lane-busy",
          updateInFlight: admissionBlockIsUpdateWork(installBlock),
          message: admissionBlockRestartMessage(installBlock),
        };
      }
      const outcome = await bridge.options.hostController.installVersion(
        version,
        force,
      );
      if (outcome.kind === "ok") {
        // Fire-and-forget: the install already committed, so a rejection in this secondary probe must never turn the dispatched outcome into a rejected invoke.
        void refreshRegistryUpdateState(bridge.options.hostController, {
          force: true,
          maxAgeMs: null,
        }).catch((err: unknown) => {
          log.warn(
            "[host-management] registry refresh after maintenance install failed",
            { err },
          );
        });
      }
      return { kind: "dispatched", outcome };
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerDoctorRepairQueued,
    async (_event, raw: unknown): Promise<QueuedDoctorRepairResult> => {
      const repair = optionalString(raw, "repair");
      if (
        repair !== "converge-ready" &&
        repair !== "register-service" &&
        repair !== "restart"
      ) {
        throw new Error(`Unknown doctor repair: ${String(repair)}`);
      }
      const expectedHostId = optionalString(raw, "expectedHostId") ?? "";
      const identity = await checkLocalHostIsStill(bridge, expectedHostId);
      if (!identity.ok) {
        return { kind: "declined", message: identity.message };
      }
      if (repair === "restart") {
        const result = restartRequestResultFromOutcome(
          await bridge.options.hostController.respawn(
            userRepairIntent(bridge, expectedHostId),
          ),
        );
        return result.kind === "declined"
          ? { kind: "declined", message: result.message }
          : { kind: "applied" };
      }
      // This route queues, so "here" can be minutes before the mutation: the host can be replaced or re-enrolled while the repair waits behind an install, and the check above would have.
      const intent = userRepairIntent(bridge, expectedHostId);
      // Widened to `unknown` because the two intents resolve DIFFERENT
      // ok-value types and this handler never reads the value - it only
      // classifies the kind.
      const outcome: GuardedMutationOutcome<unknown> =
        repair === "converge-ready"
          ? await bridge.options.hostController.convergeReady(false, intent)
          : await bridge.options.hostController.registerService(intent);
      // It arrives as the `abandoned` arm of the SHARED settled outcome, so a caller that coalesced onto another window's identical repair classifies it exactly like the caller whose.
      if (outcome.kind === "abandoned") {
        return { kind: "declined", message: outcome.message };
      }
      // Anything else that stopped this repair is a genuine failure and
      // rejects, matching what the renderer did when it called the unfenced
      // methods directly.
      const failure = failureMessageOf(outcome);
      if (failure !== null) {
        throw new Error(failure);
      }
      return { kind: "applied" };
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.traycerDoctorRepairIfIdle,
    async (_event, raw: unknown): Promise<DoctorRepairDispatch> => {
      const expectedHostId = optionalString(raw, "expectedHostId") ?? "";
      const repair = optionalString(raw, "repair");
      if (repair !== "converge-ready" && repair !== "register-service") {
        throw new Error(`Unknown doctor repair: ${String(repair)}`);
      }
      const identity = await checkLocalHostIsStill(bridge, expectedHostId);
      if (!identity.ok) {
        return { kind: "host-changed", message: identity.message };
      }
      // The page cannot gate this on its own - its lifecycle state cannot see a lane the background reconciler armed.
      const block = bridge.options.hostController.lifecycleAdmissionBlock;
      if (block !== null) {
        return {
          kind: "lane-busy",
          message: admissionBlockRestartMessage(block),
        };
      }
      const intent = userRepairIntent(bridge, expectedHostId);
      const outcome: GuardedMutationOutcome<unknown> =
        repair === "converge-ready"
          ? await bridge.options.hostController.convergeReady(false, intent)
          : await bridge.options.hostController.registerService(intent);
      if (outcome.kind === "abandoned") {
        return { kind: "host-changed", message: outcome.message };
      }
      return {
        kind: "dispatched",
        outcome: outcome.kind === "ok" ? { kind: "ok", value: null } : outcome,
      };
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.traycerServiceRegister, async () => {
    await clearHostRemovalIfSet();
    // Narrowed before crossing IPC: the renderer's contract is plain `MutationOutcome`, and a guardless intent cannot be abandoned.
    return backgroundMutationOutcome(
      await bridge.options.hostController.registerService({
        kind: "background",
      }),
    );
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
      // Per the Tech Plan, Desktop maps Doctor fix actions back to CLI subcommands and never invents repairs, so we delegate the kill + restart to `traycer host free-port-and-restart` via.
      const port = optionalNumber(raw, "port");
      const pid = optionalNumber(raw, "pid");
      const processName = optionalString(raw, "processName");
      const expectedHostId = optionalString(raw, "expectedHostId") ?? "";
      const identity = await checkLocalHostIsStill(bridge, expectedHostId);
      if (!identity.ok) {
        throw new Error(identity.message);
      }
      log.info("[host-management] free-port restart confirmed", {
        port,
        pid,
        processName,
      });
      const intent = userRepairIntent(bridge, expectedHostId);
      okOrThrow(
        await bridge.options.hostController.freePortAndRestart(
          pid,
          port,
          intent,
        ),
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

  bridge.handleInvoke(
    RunnerHostInvoke.traycerFreePortAndRestartIfIdle,
    async (_event, raw: unknown): Promise<DoctorRepairDispatch> => {
      const expectedHostId = optionalString(raw, "expectedHostId") ?? "";
      const identity = await checkLocalHostIsStill(bridge, expectedHostId);
      if (!identity.ok) {
        return { kind: "host-changed", message: identity.message };
      }
      const port = optionalNumber(raw, "port");
      const pid = optionalNumber(raw, "pid");
      // `freePortAndRestart` goes through the exclusive lane and QUEUES behind whatever is running, so a confirm that raced a lifecycle write arming in main fires its kill after that.
      // The renderer's own gate cannot close this: it can only refuse on what it last rendered.
      const block = bridge.options.hostController.lifecycleAdmissionBlock;
      if (block !== null) {
        return {
          kind: "lane-busy",
          message: admissionBlockRestartMessage(block),
        };
      }
      log.info("[host-management] free-port restart confirmed (refusing)", {
        port,
        pid,
      });
      const outcome = await bridge.options.hostController.freePortAndRestart(
        pid,
        port,
        userRepairIntent(bridge, expectedHostId),
      );
      if (outcome.kind === "abandoned") {
        return { kind: "host-changed", message: outcome.message };
      }
      return {
        kind: "dispatched",
        outcome: outcome.kind === "ok" ? { kind: "ok", value: null } : outcome,
      };
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.traycerCliManifestRead, async () => {
    // Environment-scope the CLI manifest + reconcile sidecar lookup so dev Desktop never reads the prod manifest (and vice versa).
    const cliSlotRoot = cliSlotRootForEnvironment(activeEnvironment);
    const manifestPath = join(cliSlotRoot, "manifest.json");
    const reconcilePath = join(cliSlotRoot, "desktop-reconcile.json");
    const reconcile = await readReconcileSidecar(reconcilePath);
    let text: string;
    try {
      text = await readFile(manifestPath, { encoding: "utf8" });
    } catch {
      const synthesized = await readSystemSourceMarker();
      if (synthesized === null) return null;
      return { ...synthesized, packageManagerUpgrade: null };
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isPlainObject(parsed)) return parsed;
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

/** Paths and payload must stay in lockstep with the CLI installer; update both call sites together. */
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

export async function readInstalledHostRecordForBoot(): Promise<HostInstalledRecord | null> {
  return readInstalledHostRecord();
}
