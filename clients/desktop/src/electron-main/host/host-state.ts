import { readFile } from "node:fs/promises";
import {
  compareHostVersions,
  isStrictlyNewerHostVersion,
} from "@traycer-clients/shared/host-version/compare-host-versions";
import { encodeInstallGeneration } from "@traycer-clients/shared/host-version/install-generation";
import { probeHostActivityBusy } from "@traycer-clients/shared/host-client/host-activity-probe";
import type { HostFsLayout } from "./host-paths";
import { readPidMetadataState } from "./host-lifecycle";
import {
  isPublishedHostEndpointReachable,
  type HostEndpointReachabilityProbe,
} from "./host-endpoint-reachability";

export type { HostEndpointReachabilityProbe } from "./host-endpoint-reachability";

// Observed on-disk state readers + derived readiness/activation logic for
// `HostController` (Host Update Layer Redesign Tech Plan, "Desktop main:
// HostController" > "State model"). Desktop cannot import the CLI's
// `HostInstallRecord`/`HostStagedRecord` types (they live in
// `clients/traycer-cli`, not `clients/shared`, and this ticket must not
// modify that workspace) - these are desktop-local mirrors of the on-disk
// JSON shapes the CLI writes, read directly rather than duplicating the
// CLI's own reader/writer logic.

export type HostInstallPlatform = "darwin" | "win32" | "linux";
export type HostInstallArch = "arm64" | "x64";

export interface DesktopHostInstallRecord {
  readonly installId: string | null;
  readonly version: string;
  readonly runtimeVersion: string | null;
  readonly installedAt: string;
  readonly archiveSha256: string | null;
  readonly platform: HostInstallPlatform | null;
  readonly arch: HostInstallArch | null;
}

export interface DesktopHostStagedRecord {
  readonly stageId: string | null;
  readonly version: string;
  readonly runtimeVersion: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJsonFile(path: string): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Reads `install.json` directly. Tolerant (returns `null` on any structural
 * defect, mirroring the CLI's own reconcile-oriented tolerant readers) - a
 * missing/malformed install record just means "not installed" for the
 * controller's derivation, not a hard failure.
 */
export async function readDesktopHostInstallRecord(
  layout: HostFsLayout,
): Promise<DesktopHostInstallRecord | null> {
  const parsed = await readJsonFile(layout.installRecordFile);
  if (!isPlainObject(parsed)) return null;
  if (typeof parsed.version !== "string") return null;
  if (typeof parsed.installedAt !== "string") return null;
  return {
    installId: typeof parsed.installId === "string" ? parsed.installId : null,
    version: parsed.version,
    runtimeVersion:
      typeof parsed.runtimeVersion === "string" ? parsed.runtimeVersion : null,
    installedAt: parsed.installedAt,
    archiveSha256:
      typeof parsed.archiveSha256 === "string" ? parsed.archiveSha256 : null,
    platform:
      parsed.platform === "darwin" ||
      parsed.platform === "win32" ||
      parsed.platform === "linux"
        ? parsed.platform
        : null,
    arch: parsed.arch === "arm64" || parsed.arch === "x64" ? parsed.arch : null,
  };
}

/** Reads `staged.json` directly. Tolerant, same rationale as above. */
export async function readDesktopHostStagedRecord(
  layout: HostFsLayout,
): Promise<DesktopHostStagedRecord | null> {
  const parsed = await readJsonFile(layout.stagedRecordFile);
  if (!isPlainObject(parsed)) return null;
  if (typeof parsed.version !== "string") return null;
  return {
    stageId: typeof parsed.stageId === "string" ? parsed.stageId : null,
    version: parsed.version,
    runtimeVersion:
      typeof parsed.runtimeVersion === "string" ? parsed.runtimeVersion : null,
  };
}

/**
 * The runtime identity the live host is currently publishing, or `null`
 * when there is no reachable running host. Fixup A3: `readPidMetadataState`
 * is a STRUCTURAL parse only (pid.json well-formed) - it says nothing about
 * whether the process it names is still alive. A crash/OOM/Task-Manager
 * kill leaves a stale-but-well-formed `pid.json` behind, which a
 * structural-only read reports as "running" - the exact bug that made
 * `recoverIfDown` skip restarting a genuinely dead host (it read this same
 * function and short-circuited to `ok`). Every "is the host running"
 * decision in `HostController` (`getStatus`, `recoverIfDown`,
 * `convergeReadyPackagedMac`, `applyPendingLoginItemRevisionIfIdle`) goes
 * through this one function, so a real liveness probe here fixes all of
 * them at once: the pid must belong to a live OS process AND the websocket
 * endpoint must actually accept a connection, matching the same two checks
 * `HostLifecycle.reloadSnapshot`'s `toReachableSnapshot` already applies to
 * the renderer-facing snapshot. `reachabilityProbe` is threaded in (not
 * imported directly) so tests can substitute a deterministic stub instead
 * of depending on a real TCP listener bound to the fixture's `websocketUrl`
 * - production callers pass `canReachHostWebsocketUrl` from `./host-lifecycle`.
 */
export async function readRunningRuntimeVersion(
  layout: HostFsLayout,
  reachabilityProbe: HostEndpointReachabilityProbe,
): Promise<string | null> {
  const state = await readPidMetadataState(layout.pidMetadataFile);
  if (state.kind !== "parsed") return null;
  const { snapshot, startedAt } = state;
  return (await isPublishedHostEndpointReachable(
    snapshot.websocketUrl,
    snapshot.pid,
    startedAt,
    reachabilityProbe,
  ))
    ? snapshot.version
    : null;
}

/**
 * Registry-domain readiness: comparable `staged > installed`. Incomparable
 * versions (e.g. `local-*` builds) never advertise as ready - the same
 * comparator both the CLI and this controller consume, so update/apply
 * decisions never diverge (Tech Plan, "Version identity").
 */
export function deriveUpdateReady(
  installedVersion: string | null,
  stagedVersion: string | null,
): boolean {
  if (installedVersion === null || stagedVersion === null) return false;
  return isStrictlyNewerHostVersion(stagedVersion, installedVersion);
}

export type HostActivationState =
  "activated" | "pendingActivation" | "activationUnknown" | "unavailable";

/**
 * Runtime-domain activation state, equality-only (Tech Plan, "Version
 * identity" > "Unknown runtime identity"). Never SemVer-orders runtime
 * stamps. `unavailable` (no live running identity) is `convergeReady`'s
 * domain - every surface gates activation-debt UI on the other three
 * reachable values.
 */
export function deriveActivationState(
  installedRuntimeVersion: string | null,
  runningRuntimeVersion: string | null,
): HostActivationState {
  if (runningRuntimeVersion === null) return "unavailable";
  if (installedRuntimeVersion === null) return "activationUnknown";
  return installedRuntimeVersion === runningRuntimeVersion
    ? "activated"
    : "pendingActivation";
}

/**
 * The attested install-generation fingerprint for a record captured from
 * disk (the `activateInstalled` / pre-existing-record path, per the Tech
 * Plan's "stamp-runtime CAS": "when activating a pre-existing record...
 * the controller captures it from disk before the cycle"). A
 * controller-driven create-and-cycle command (apply/install/ensure) must
 * instead use the fingerprint carried on THAT command's own result, never
 * this disk-derived one - see `host-controller.ts`.
 */
export function attestedInstallGenerationFromDisk(
  record: DesktopHostInstallRecord,
): string {
  return encodeInstallGeneration({
    installId: record.installId,
    installedAt: record.installedAt,
    archiveSha256: record.archiveSha256,
    version: record.version,
  });
}

/** Re-exported so callers of this module don't need a second import for the
 * registry-domain comparator (used directly by a couple of ordering edges
 * outside plain "is X ready" checks, e.g. the yank-vs-apply guard). */
export { compareHostVersions, isStrictlyNewerHostVersion };

/**
 * The running host's full identity triple straight off `pid.json`,
 * including `startedAt` - `HostLifecycle`'s `DesktopLocalHostSnapshot` (the
 * renderer-facing projection) deliberately drops that field, but
 * `host stamp-runtime`'s CAS needs it verbatim as `--observed-started-at`
 * (paired with the observed pid/runtime-version) to attest the fresh
 * process it is backfilling against. Read directly here rather than
 * widening the renderer-facing snapshot type for one internal caller.
 */
export interface RunningHostIdentity {
  readonly pid: number;
  readonly version: string;
  readonly startedAt: string;
}

export async function readRunningHostIdentity(
  layout: HostFsLayout,
): Promise<RunningHostIdentity | null> {
  const parsed = await readJsonFile(layout.pidMetadataFile);
  if (!isPlainObject(parsed)) return null;
  if (
    typeof parsed.pid !== "number" ||
    typeof parsed.version !== "string" ||
    typeof parsed.startedAt !== "string"
  ) {
    return null;
  }
  return {
    pid: parsed.pid,
    version: parsed.version,
    startedAt: parsed.startedAt,
  };
}

export type HostBusyVerdict = "no-host" | "idle" | "busy";

/**
 * Desktop-side mirror of the CLI's `assertHostNotBusy` restart-verdict probe
 * (`host/busy-check.ts`) - deliberately duplicated rather than imported:
 * this ticket must not modify `clients/traycer-cli/`, and the probe itself
 * (`probeHostActivityBusy`) already lives in `clients/shared` so both sides
 * share the actual HTTP check; only the "is there a live host to protect at
 * all" liveness gate is repeated here. Used by the desktop-held lock
 * sections (packaged-macOS activation/removal) immediately before a
 * disruptive SMAppService cycle, mirroring the CLI's in-lock busy probe on
 * CLI-owned platforms.
 */
export async function probeHostBusyVerdict(
  layout: HostFsLayout,
): Promise<HostBusyVerdict> {
  const identity = await readRunningHostIdentity(layout);
  if (identity === null) return "no-host";
  const websocketUrl = await readWebsocketUrl(layout);
  if (websocketUrl === null) return "no-host";
  return (await probeHostActivityBusy(websocketUrl)) ? "busy" : "idle";
}

async function readWebsocketUrl(layout: HostFsLayout): Promise<string | null> {
  const parsed = await readJsonFile(layout.pidMetadataFile);
  if (!isPlainObject(parsed)) return null;
  return typeof parsed.websocketUrl === "string" ? parsed.websocketUrl : null;
}
