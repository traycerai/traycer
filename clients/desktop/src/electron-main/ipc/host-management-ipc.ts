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
  HostUpdateCheckResponse,
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

/**
 * Whether an admission block represents UPDATE work.
 *
 * Scope first: the lane is exclusive and the caller has ALREADY refused the
 * competing install by the time it asks - this bit never admits anything.
 * It picks between two presentations of that refusal: `true` becomes the
 * protocol's `already-updating` (an informational toast that ARMS the
 * Overview's accepted-update latch), `false` a retryable refusal carrying
 * the lane's message. On a pre-1.2.0 host the latch releases only on a
 * scope flip or its full 60s timer - the `host.status.updateProgress`
 * frame that normally frees it is a field these hosts never publish - so a
 * wrong `true` is a minute-long lock of the page's update and lifecycle
 * controls, while a wrong `false` is an error-styled toast whose text
 * (`laneBusyRestartMessage`) still names the update. That asymmetry sets
 * the rule: answer `true` only when the lane work can OUTLAST the latch it
 * arms, so the lock is protecting a swap that is genuinely still running.
 *
 *  - `install` / `apply` qualify by definition: version-moving, and
 *    minutes-long against the 60s window.
 *  - `ensure` qualifies only with NUMERIC progress evidence. Its service
 *    branches (`runServiceRegister`, `runStart`, the repair retry) narrate
 *    through the same null-metric `host-provision` events without touching
 *    the version, and its no-op fast path returns before any progress at
 *    all; only the version-moving path reports numbers - the staging
 *    download's `bytes`/`totalBytes`/`percent`, the extract's `workUnits` -
 *    and those are its long windows. Null-metric moments inside a real
 *    install (source resolution, the locked promote) fall to the retryable
 *    side, the cheap direction.
 *  - `activate` does NOT qualify, deliberately. The lane cannot say which
 *    arm triggered it: the genuine update tail (pendingActivation) and the
 *    legacy stamp-repair (`activationUnknown` - a record with
 *    `runtimeVersion: null`, which launch converge activates with NO update
 *    staged, on exactly this pre-1.2.0 population) are one kind at
 *    admission. Both are a seconds-long service cycle either way - work the
 *    60s latch would outlive many times over, guarding a swap that already
 *    finished while the page sits locked.
 *
 * Every other kind (register, deregister, respawn, recoverIfDown,
 * freePortAndRestart, uninstallHost, removeTraycer) and the login-item
 * refresh take the same exclusive lane without ever touching the version.
 * Listed positively so a NEW `MutationKind` defaults to "not an update".
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

/**
 * The failure message of a non-ok outcome, or `null` when it succeeded.
 *
 * Lets a Doctor repair route inspect an outcome WITHOUT throwing yet, after
 * it has already narrowed away the `abandoned` arm - what is left non-ok is
 * a genuine failure and gets the error path.
 */
function failureMessageOf<TOk>(outcome: MutationOutcome<TOk>): string | null {
  return outcome.kind === "ok" ? null : outcome.message;
}

/**
 * Every non-"ok" outcome rejects the IPC invoke - matches the legacy
 * CLI-throw contract for the handlers that never had a "keep the old
 * host, surface it for a compat probe" branch. An `abandoned` outcome (the
 * lane-head identity guard refused a user repair) rejects identically: the
 * one guarded caller that reaches this helper - the queued free-port
 * restart - REFUSES its early identity check with a throw too, so early and
 * late refusals present alike there by construction.
 */
function okOrThrow<TOk>(outcome: GuardedMutationOutcome<TOk>): TOk {
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

/**
 * Whether this machine's host is still the one the caller meant, with the
 * refusal words when it is not.
 *
 * Every handler below acts on "the local host" implicitly — the channel
 * carries no host id — so a request aimed at A lands on its replacement B
 * without this. The scope that built the request can hold a FROZEN id (an
 * explicitly-scoped requester keeps answering with the row it was created
 * for), so the renderer cannot be the one to notice; main classifies the same
 * durable identity `lastKnownLocalHostId` projects, in the same order.
 *
 * The two anonymous classifications go OPPOSITE ways, and the split is the
 * fence's whole strength:
 *
 *  - `unverifiable` REFUSES. The enrollment record exists but cannot answer —
 *    which is what a re-enrollment or replacement mid-write looks like, the
 *    exact window where "assume no change" would submit A's install against
 *    B. Refusing here still terminates: the tray/menu respawn and the copied
 *    terminal commands stay reachable, and the condition clears when the
 *    record settles.
 *  - `unenrolled` ALLOWS. Nothing on this machine has ever named a host (a
 *    legacy install predating the record, with no pid file left) — there is
 *    no identity machinery a replacement could have gone through, and this is
 *    exactly the down-legacy-host state the repair handlers exist for.
 *
 * Awaited BEFORE any lane test, never between one and its submission: this
 * reads files, and an await there would reopen the window the lane test
 * exists to close.
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
 * Run a host-scoped READ under an identity fence that spans the whole read,
 * not just its start.
 *
 * Every one of these shells out to the CLI, so seconds pass between the
 * question and the answer. Checking only beforehand proves the host was A
 * when we asked - it says nothing about whose bytes came back, and the caller
 * renders those bytes under A's name. So the same question is asked again
 * after the read and a mismatch discards the result rather than attributing
 * another machine's log, report or install record to the scope that froze A.
 *
 * Throwing on the second check is the same contract as the first: callers
 * already surface a failed read as an error, whereas returning empty content
 * would read as "this host has nothing to show".
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
 * The `user-repair` reprovision intent for a Doctor lifecycle fix.
 *
 * The guard is the SAME identity question `checkLocalHostIsStill` answers
 * at the handler, deferred to the head of the mutation lane. Both repair
 * routes build it: the queued one because its wait is unbounded, and the
 * watched one because its lane test must stay atomic and so cannot afford the
 * sentinel read inline. Asking twice is deliberate - the handler's check
 * refuses cheaply and immediately, and this one refuses a job whose target
 * moved while it waited.
 *
 * A lane-head refusal comes back as the `abandoned` arm of the OUTCOME, not
 * as state parked in this factory: two windows submitting the same repair
 * for the same host coalesce into one controller job, and only that job's
 * intent ever runs - a closure armed here would be live for one waiter and
 * dead for the rest, which would then misread the shared result as a genuine
 * failure and count it toward the Doctor console's recurrence lock. The
 * settled outcome is the only channel every coalesced waiter sees.
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

/**
 * Why a watched restart was refused, in the words of whatever holds the lane.
 *
 * The message is the whole value of the refusal — `declined` renders as plain
 * information, so a generic "busy" would leave someone re-clicking a button
 * that keeps saying no. Naming the operation says how long to wait instead.
 */
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

/**
 * `laneBusyRestartMessage` widened to every admission block: the words for
 * whatever lifecycle work caused a watched request to be refused, whichever
 * tail it runs on.
 */
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

/**
 * Classify a `runBundledTraycerCliJson` rejection into the wire taxonomy the
 * host's own maintenance resolvers produce from the same CLI, so the GUI's
 * local fallback renders the same words for the same fault on either lane.
 *
 * The mapping leans on `cli/traycer-cli.ts`'s throw shapes:
 *  - a PLAIN `Error` is thrown only by invocation resolution — for this lane,
 *    `resolveBundledTraycerCliInvocation` found no bundled CLI under app
 *    resources — which is the host taxonomy's `cli-unavailable` (no CLI on
 *    this machine to shell);
 *  - `exitCode === 0 && code === null` is the "ran to a clean exit but emitted
 *    no terminal result line" arm: a CLI speaking a shape this build cannot
 *    read, the taxonomy's `invalid-output`;
 *  - every other `TraycerCliError` (error envelope, crash, timeout) is the CLI
 *    running and not completing — `cli-failed`.
 */
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
      // `background`, which keeps this channel byte-identical: it carries no
      // `expectedHostId` to guard with and has never cleared the removal
      // sentinel, so it still short-circuits on a removed host. That is the
      // right contract for its caller - the provisioning controller, which
      // converges on behalf of the app rather than of a click. The Doctor
      // repairs that DO mean "give me the host back" pass `user-repair`.
      // Narrowed before crossing IPC: the renderer's contract is plain
      // `MutationOutcome`, and a guardless intent cannot be abandoned.
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

  // Deliberately NOT `okOrThrow`: a busy/deferred respawn outcome resolves
  // as a `declined` result the renderer presents as information - see
  // `restartRequestResultFromOutcome`. `background` because this legacy
  // channel carries no `expectedHostId` to build a guard from - it restarts
  // the local host as a role, whatever currently fills it.
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
      // The refusing twin of the handler above, for a restart someone is
      // WATCHING. `respawn()` goes through the same exclusive lane as every
      // other intent and queues behind it rather than being refused, so a
      // Settings restart submitted while an install, apply or service cycle
      // is running would fire its kill after that finished — against a host in
      // a state the person never saw, and typically one the update just
      // restarted anyway.
      //
      // Same atomicity rule as `maintenance:installVersion`: test admission
      // and submit with NO await in between, because a read that crosses an
      // await is already history. `respawn()` registers on the tail
      // synchronously, and building the intent is synchronous too - only its
      // guard runs later, at the head of the lane.
      const block = bridge.options.hostController.lifecycleAdmissionBlock;
      if (block !== null) {
        return {
          kind: "declined",
          message: admissionBlockRestartMessage(block),
        };
      }
      // `user-repair` even though an admitted job runs at the head of an
      // EMPTY lane: admission to execution still crosses a microtask
      // boundary, and this channel names a specific host, so the guard
      // re-asks the identity question there. `abandoned` renders as the
      // same `declined` the check above resolves.
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
      // Fenced like the maintenance projections, and for the same reason: this
      // reads THIS machine's log, so a scope frozen on host A that has since
      // been replaced would render B's log — its paths, ports and workspace
      // names — under A's name. The fence SPANS the CLI call: `traycer host
      // logs` takes long enough for A to be replaced while it runs, and the
      // tail that comes back would be B's.
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
      // Fenced like the log read: the report describes THIS machine, and its
      // issues carry the port/pid the repairs act on, so attributing a
      // replacement host's report to the scope that froze its predecessor
      // hands out another machine's repair inputs.
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

  // ── The maintenance-RPC projections ────────────────────────────────────
  // These three answer the v1.2.0 `host.*` maintenance RPCs for the GUI's
  // local fallback (a local host ≤ 1.1.11 negotiated the family away), so
  // each resolves the PROTOCOL response shape rather than a renderer mirror.
  // Failure classification lives here in main — an invoke rejection loses
  // its error shape at the context-bridge boundary, so the renderer could
  // never rebuild the taxonomy from a rethrow. The projections mirror the
  // host's own resolvers over the same producers: the bundled CLI's JSON and
  // the shared on-disk install records (read with the protocol's own
  // schema-strict readers, so a field the wire contract requires can never
  // be silently dropped or fabricated in between). "Bundled" is load-bearing:
  // these shell `runBundledTraycerCliJson`, never the discovered
  // manifest/PATH CLI the general-purpose handlers above resolve — a stale or
  // keyless manual install would otherwise stay authoritative and disable
  // this repair lane while a healthy version-matched CLI sits in resources
  // (the same D7 rule `HostController` follows for host mutations).

  bridge.handleInvoke(
    RunnerHostInvoke.traycerMaintenanceUpdateCheck,
    async (_event, raw: unknown): Promise<HostUpdateCheckResponse> => {
      const expectedHostId = optionalString(raw, "expectedHostId") ?? "";
      return fencedLocalHostRead(bridge, expectedHostId, async () => {
        const includePreReleases = optionalBoolean(raw, "includePreReleases");
        const args = [
          "host",
          "available",
          "--json",
          ...(includePreReleases ? ["--include-pre-releases"] : []),
        ];
        let payload: unknown;
        try {
          payload = await runBundledTraycerCliJson<unknown>(args);
        } catch (err) {
          // Every failure classifies, including a build without trusted registry
          // keys. Deliberately NOT `traycerHostAvailable`'s
          // `emptyAvailableSnapshot()` normalisation: that lane's consumer reads
          // an empty snapshot as "nothing to install", while a protocol manifest
          // with `latest: ""` reaches a consumer that reads `latest` as a real
          // version — it renders `v is available, but <host> can't install it.`
          // whenever the installed version is unknown. The host's own
          // `host.update.check` resolver returns the classified outcome for any
          // non-ok CLI result and never synthesises a manifest, and this lane
          // answers the same wire contract, so it classifies too.
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
        return { outcome: "ok", manifest: manifest.data };
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
        // Schema-strict, unlike `projectDoctorReport` above, whose tolerant
        // coercions make a malformed payload indistinguishable from a clean
        // bill of health. On this lane a report the protocol cannot parse IS
        // the `invalid-output` arm — the same answer the host's resolver gives
        // for the same bytes.
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
        // Byte-for-byte the host resolver's `readInstallationInfo`, pointed at
        // the desktop's own path authority for the same files: a missing
        // install record IS the unmanaged/tree-run state, a corrupt one throws
        // (never mistaken for "not installed"), and the staged sidecar stays
        // best-effort tolerant. `readInstalledHostRecord` above is deliberately
        // NOT reused: its lossy defaults (`archiveSha256: ""`,
        // `installedAt` from mtime) would fabricate wire fields.
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
      // ATOMIC test-and-submit, and the reason this is a separate channel from
      // `traycerHostInstallVersion`. The lane is exclusive but it does not
      // refuse a distinct intent — `enqueueMutation` chains it onto
      // `mutationTail` — so a caller that tests the lane in one IPC round trip
      // and submits in the next can be overtaken by the banner, the tray or
      // the background reconciler, and its install lands right after theirs.
      //
      // Main is single-threaded and `installVersion` registers on the tail
      // synchronously, so testing the lane and calling it with NO await in
      // between admits no interleaving. Do not insert one: an `await
      // clearHostRemovalIfSet()` here (as the sibling handler does) would
      // reopen exactly the window this exists to close — `installVersion`
      // clears the removed-by-user sentinel inside the mutation body anyway.
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
        // Same forced re-probe as `traycerHostInstallVersion` above, for the
        // same stale-cache reason: the install record on disk now names the
        // new version, and without `force` the pre-install cache — reachable
        // and minutes old — would keep serving the OLD `installedVersion`
        // (and `updateAvailable`) for the rest of the 24h TTL, so the tray
        // and Updates row keep advertising the version this dispatch just
        // installed. Fire-and-forget: the install already committed, so a
        // rejection in this secondary probe must never turn the dispatched
        // outcome into a rejected invoke.
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
      // The recovery console's route. It QUEUES deliberately — see
      // `QueuedDoctorRepair` — so there is no `lifecycleAdmissionBlock` test
      // here, and that is the ONLY thing it gives up. Identity is still
      // decided before anything is enqueued: this console can outlive the host
      // it names, and a queued repair that lands on a replacement is a write
      // nobody asked for.
      const expectedHostId = optionalString(raw, "expectedHostId") ?? "";
      const identity = await checkLocalHostIsStill(bridge, expectedHostId);
      if (!identity.ok) {
        return { kind: "declined", message: identity.message };
      }
      if (repair === "restart") {
        // Queued like its two siblings, so the identity question rides the
        // intent to the head of the lane: this restart can wait minutes
        // behind an install, and a zero-argument respawn firing then would
        // force-restart whatever host holds the slot by that time, killing
        // sessions on a host nobody asked about. The host's own refusal
        // (busy work, removed-by-user, lock contention) and the guard's late
        // refusal are both informational, and
        // `restartRequestResultFromOutcome` is the one place that taxonomy
        // lives - it renders `abandoned` as the same `declined` the
        // pre-enqueue check above resolves.
        const result = restartRequestResultFromOutcome(
          await bridge.options.hostController.respawn(
            userRepairIntent(bridge, expectedHostId),
          ),
        );
        return result.kind === "declined"
          ? { kind: "declined", message: result.message }
          : { kind: "applied" };
      }
      // Clicking Install host or Register service on a Doctor report IS an
      // explicit user-driven reprovision - the same gesture as the Updates
      // row's own install - so the removal sentinel has to come off, and the
      // identity has to still hold when the job actually runs.
      //
      // Both now happen at the HEAD OF THE LANE rather than here. This route
      // queues, so "here" can be minutes before the mutation: the host can be
      // replaced or re-enrolled while the repair waits behind an install, and
      // the check above would have proved nothing about the host that
      // ultimately gets written. `user-repair` carries the same identity
      // question as a guard and the controller asks it again once admitted.
      // Restart is deliberately NOT a reprovision and keeps its own
      // removed-by-user deferral.
      const intent = userRepairIntent(bridge, expectedHostId);
      // Widened to `unknown` because the two intents resolve DIFFERENT
      // ok-value types and this handler never reads the value - it only
      // classifies the kind.
      const outcome: GuardedMutationOutcome<unknown> =
        repair === "converge-ready"
          ? await bridge.options.hostController.convergeReady(false, intent)
          : await bridge.options.hostController.registerService(intent);
      // A guard refusal is NOT a failure. It arrives as the `abandoned` arm
      // of the SHARED settled outcome, so a caller that coalesced onto
      // another window's identical repair classifies it exactly like the
      // caller whose intent ran - rendered the same way as the pre-enqueue
      // check above, and never counted toward the console's recurrence lock,
      // which would let a merely-renamed host disable Doctor after three
      // clicks.
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
      // The Doctor sheet's two LIFECYCLE repairs, refused rather than queued
      // for the same reason a watched restart is: `convergeReady` converges to
      // LATEST and `registerService` adds a service cycle, so either one
      // landing after a pinned install overrides the version the person
      // actually chose. The page cannot gate this on its own — its lifecycle
      // state cannot see a lane the background reconciler armed.
      //
      // Atomic: the lane test and the submission have no await between them.
      // The sentinel clear that this repair also needs is NOT done here for
      // exactly that reason - it reads disk, and an await between the test
      // and the submit reopens the window the test exists to close. It rides
      // the `user-repair` intent into the controller instead, which runs it
      // once admitted. `traycerHostInstallVersion` documents the same rule
      // one handler up.
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
      // Same rule as the queued twin: a late identity refusal is reported as
      // the identity refusal it is, using the dispatch shape this channel
      // already has for one caught before submission - and it rides the
      // SHARED outcome, so a coalesced waiter classifies it identically.
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
    // Dev-slot CLI argv (the staged wrapper / self-invocation flags, Ticket
    // f0ae4530) is owned by `HostController.registerService()` itself,
    // environment-aware since the controller already carries `environment`.
    //
    // `background` even though this IS user-driven: the clear it needs
    // already happened on the line above, and this channel carries no
    // `expectedHostId` to build a guard from. Passing the intent would change
    // an unfenced legacy route this PR does not otherwise touch.
    // Narrowed before crossing IPC: the renderer's contract is plain
    // `MutationOutcome`, and a guardless intent cannot be abandoned.
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
      // Flow 4 step 7: confirmation is the renderer's responsibility - by
      // the time we get here the user has already approved killing the
      // foreign process. Per the Tech Plan, Desktop maps Doctor fix
      // actions back to CLI subcommands and never invents repairs, so we
      // delegate the kill + restart to `traycer host free-port-and-restart`
      // via NDJSON instead of calling `process.kill` from main.
      const port = optionalNumber(raw, "port");
      const pid = optionalNumber(raw, "pid");
      const processName = optionalString(raw, "processName");
      // The port and pid above describe the machine AS THE REPORT SAW IT, and
      // the approval was given for that host. If this computer's host has been
      // replaced since, the same numbers name whatever now holds the port, so
      // the repair is refused rather than aimed at a host nobody approved.
      // Queueing behind the lane stays deliberate here (see the contract) —
      // this is the down-host recovery route, and identity is a separate
      // question from timing.
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
      // The check above refuses cheaply and immediately; this one refuses a
      // job whose target moved while it queued. `pid` and `port` were
      // recorded against the host as it was at confirm time, so of all the
      // queued repairs this is the one that most needs re-asking: the
      // consequence of getting it wrong is killing a process nobody named.
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
      // The refusing twin of the handler above, for the Doctor sheet someone
      // is WATCHING. `freePortAndRestart` goes through the exclusive lane and
      // QUEUES behind whatever is running, so a confirm that raced a lifecycle
      // write arming in main fires its kill after that write finishes —
      // against a host in a state the person never saw. The renderer's own
      // gate cannot close this: it can only refuse on what it last rendered.
      //
      // Same atomicity rule as the other `*IfIdle` handlers: test admission
      // and submit with NO await in between.
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
      // Reported as the identity refusal it is, using the shape this channel
      // already has for one caught before submission. Without this the SAME
      // mismatch reads as `host-changed` when the handler catches it and as a
      // failed dispatch when the lane head does. The `abandoned` arm rides
      // the SHARED outcome, so a coalesced waiter classifies it identically.
      //
      // The queued twin above deliberately needs no branch: its early check
      // THROWS, and `okOrThrow` throws the late `abandoned` too, so early
      // and late refusals already look alike there.
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
