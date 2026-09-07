import { readFile } from "node:fs/promises";
import {
  compareHostVersions,
  isStrictlyNewerHostVersion,
} from "@traycer-clients/shared/host-version/compare-host-versions";
import { encodeInstallGeneration } from "@traycer-clients/shared/host-version/install-generation";
import { probeHostActivityBusy } from "@traycer-clients/shared/host-client/host-activity-probe";
import type { Layer0UnavailableCause } from "@traycer/protocol/host/lifecycle/layer0-frame";
import type { HostFsLayout } from "./host-paths";
import { readPidMetadataState } from "./host-lifecycle";
import {
  isPublishedHostEndpointReachable,
  type HostEndpointReachabilityProbe,
} from "./host-endpoint-reachability";

export type { HostEndpointReachabilityProbe } from "./host-endpoint-reachability";

// Desktop cannot import the CLI's `HostInstallRecord`/`HostStagedRecord` types (they live in `clients/traycer-cli`, not `clients/shared`, and this ticket must not modify that.

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

export type DesktopHostLayer0Record =
  | { readonly status: "acquired"; readonly attemptId: string }
  | {
      readonly status: "degraded";
      readonly attemptId: string;
      readonly cause: Layer0UnavailableCause;
      readonly evidence: string;
    }
  | { readonly status: "unrecognized"; readonly raw: string };

/** A malformed record, including a degraded record carrying a cause this desktop does not know yet, decodes to `unrecognized` with its raw JSON intact rather than `null`. */
export function decodeHostLayer0Record(
  value: unknown,
): DesktopHostLayer0Record | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isPlainObject(value)) {
    return { status: "unrecognized", raw: JSON.stringify(value) };
  }
  const record = value;
  const attemptId =
    typeof record.attemptId === "string" ? record.attemptId : "";
  if (record.status === "acquired" && attemptId.length > 0) {
    return { status: "acquired", attemptId };
  }
  if (
    record.status === "degraded" &&
    attemptId.length > 0 &&
    isLayer0UnavailableCause(record.cause)
  ) {
    return {
      status: "degraded",
      attemptId,
      cause: record.cause,
      evidence: typeof record.evidence === "string" ? record.evidence : "",
    };
  }
  return { status: "unrecognized", raw: JSON.stringify(record) };
}

type Layer0UnavailableStringCause = Extract<Layer0UnavailableCause, string>;
type Layer0UnavailableObjectCause = Exclude<Layer0UnavailableCause, string>;
type Layer0UnavailableObjectKind = Layer0UnavailableObjectCause["kind"];

type GuardedLayer0UnavailableStringCause =
  | "addon-load-failed"
  | "fs-unsupported"
  | "lock-path-invalid"
  | "sharing-violation-unattested";
type GuardedLayer0UnavailableObjectKind = "os-error";

type AssertNever<TValue extends never> = TValue;

type _Layer0UnavailableStringGuardCoverage = [
  AssertNever<
    Exclude<GuardedLayer0UnavailableStringCause, Layer0UnavailableStringCause>
  >,
  AssertNever<
    Exclude<Layer0UnavailableStringCause, GuardedLayer0UnavailableStringCause>
  >,
];
type _Layer0UnavailableObjectGuardCoverage = [
  AssertNever<
    Exclude<GuardedLayer0UnavailableObjectKind, Layer0UnavailableObjectKind>
  >,
  AssertNever<
    Exclude<Layer0UnavailableObjectKind, GuardedLayer0UnavailableObjectKind>
  >,
];

function isLayer0UnavailableCause(
  value: unknown,
): value is Layer0UnavailableCause {
  if (
    value === ("addon-load-failed" satisfies Layer0UnavailableStringCause) ||
    value === ("fs-unsupported" satisfies Layer0UnavailableStringCause) ||
    value === ("lock-path-invalid" satisfies Layer0UnavailableStringCause) ||
    value ===
      ("sharing-violation-unattested" satisfies Layer0UnavailableStringCause)
  ) {
    return true;
  }
  return (
    isPlainObject(value) &&
    value.kind === ("os-error" satisfies Layer0UnavailableObjectKind) &&
    typeof value.syscall === "string" &&
    typeof value.code === "string" &&
    (typeof value.fsType === "string" || value.fsType === null)
  );
}

export async function readHostLayer0Record(
  layout: HostFsLayout,
): Promise<DesktopHostLayer0Record | null> {
  const parsed = await readJsonFile(layout.pidMetadataFile);
  if (!isPlainObject(parsed)) return null;
  return decodeHostLayer0Record(parsed.layer0);
}

export async function readRunningRuntimeVersion(
  layout: HostFsLayout,
  reachabilityProbe: HostEndpointReachabilityProbe,
): Promise<string | null> {
  return (
    (await readReachableHostIdentity(layout, reachabilityProbe))?.version ??
    null
  );
}

export async function readReachableHostIdentity(
  layout: HostFsLayout,
  reachabilityProbe: HostEndpointReachabilityProbe,
): Promise<{ readonly pid: number; readonly version: string | null } | null> {
  const state = await readPidMetadataState(layout.pidMetadataFile);
  if (state.kind !== "parsed") return null;
  const { snapshot, startIdentity } = state;
  return (await isPublishedHostEndpointReachable(
    snapshot.websocketUrl,
    snapshot.pid,
    startIdentity,
    reachabilityProbe,
  ))
    ? { pid: snapshot.pid, version: snapshot.version }
    : null;
}

/** Incomparable versions (e.g. `local-*` builds) never advertise as ready. */
export function deriveUpdateReady(
  installedVersion: string | null,
  stagedVersion: string | null,
): boolean {
  if (installedVersion === null || stagedVersion === null) return false;
  return isStrictlyNewerHostVersion(stagedVersion, installedVersion);
}

export type HostActivationState =
  | "activated"
  | "pendingActivation"
  | "activationUnknown"
  | "unavailable";

/** Never SemVer-orders runtime stamps. */
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
 * the controller captures it from disk before the cycle").
 * A controller-driven create-and-cycle command (apply/install/ensure) must instead use the fingerprint carried on THAT command's own result, never this disk-derived one.
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
