import { readFile } from "node:fs/promises";
import {
  canReachHostWebsocketUrl,
  isCurrentHostWebsocketUrl,
  sleep,
} from "./host-lifecycle";
import { isPublishedHostEndpointReachable } from "./host-endpoint-reachability";
import { TraycerCliError } from "../cli/traycer-cli";

// Host-readiness + CLI-error helpers used by the post-auth host-ensure
// flow (ipc/host-ensure-ipc.ts). The CLI's `host ensure` can report
// success the moment the service is registered/started, but the OS service
// manager still has to spawn the host and have it publish its pid metadata
// + bind its WS port.
// We poll that on-disk source of truth before telling the renderer the
// host is ready, so the gate never flips to "ready" against a host that
// hasn't actually bound its port yet.

// Sized to absorb a slow shell init + native-module/Prisma load on first
// spawn (mirrors HostLifecycle.HOST_READY_TIMEOUT_MS).
export const HOST_READY_TIMEOUT_MS = 60_000;
export const HOST_READY_POLL_MS = 250;

export type HostReadinessResult =
  | {
      readonly ready: true;
      readonly version: string;
      readonly pid: number;
      readonly startedAt: string;
      readonly reason: "ready";
    }
  | {
      readonly ready: false;
      readonly version: null;
      readonly pid: null;
      readonly startedAt: null;
      readonly reason: string;
    };

// Poll the environment-scoped pid metadata file until the host publishes a
// well-formed, reachable websocket URL or the timeout elapses. `pidPath`
// and `pollIntervalMs` are explicit so callers (and tests) control the
// filesystem dependency.
//
// `skipPid` is the respawn path's hook to distinguish the new host from
// the still-running old one: SMAppService's `unregister` is asynchronous
// to launchd's teardown, so for a brief window after we kick the cycle
// the old process is still bound to its port and its still-on-disk
// pid.json still validates. Passing the pre-respawn pid here makes the
// poll skip matching snapshots so we only return `ready` once the new
// host has actually published. Callers in the install/sign-in flow,
// where there cannot be a stale pid yet, pass `null`.
export async function waitForHostReady(
  timeoutMs: number,
  pidPath: string,
  pollIntervalMs: number,
  skipPid: number | null,
): Promise<HostReadinessResult> {
  const deadline = Date.now() + timeoutMs;
  let lastReason = "pid metadata never appeared";
  while (Date.now() < deadline) {
    const snapshot = await readPidMetadataForReady(pidPath);
    if (snapshot === null) {
      lastReason = "pid metadata not yet published";
    } else if (skipPid !== null && snapshot.pid === skipPid) {
      lastReason = `old host pid ${skipPid} still bound; waiting for replacement`;
    } else if (!isCurrentHostWebsocketUrl(snapshot.websocketUrl)) {
      lastReason = `websocket URL ${snapshot.websocketUrl} does not match the committed host WS shape`;
    } else if (
      !(await isPublishedHostEndpointReachable(
        snapshot.websocketUrl,
        snapshot.pid,
        snapshot.startedAt,
        canReachHostWebsocketUrl,
      ))
    ) {
      lastReason = `websocket URL ${snapshot.websocketUrl} is not yet reachable as the published host process`;
    } else {
      return {
        ready: true,
        version: snapshot.version,
        pid: snapshot.pid,
        startedAt: snapshot.startedAt,
        reason: "ready",
      };
    }
    await sleep(pollIntervalMs);
  }
  return {
    ready: false,
    version: null,
    pid: null,
    startedAt: null,
    reason: lastReason,
  };
}

// Distinct from host-lifecycle's `readPidMetadata`: readiness does not
// require `hostId` to be present yet - a freshly spawned host can publish
// its port/version before the full identity record, and we only need
// version/pid/websocketUrl to confirm the WS endpoint is up.
async function readPidMetadataForReady(path: string): Promise<{
  readonly version: string;
  readonly pid: number;
  readonly websocketUrl: string;
  readonly startedAt: string;
} | null> {
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
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.version !== "string" ||
    typeof obj.pid !== "number" ||
    typeof obj.websocketUrl !== "string" ||
    typeof obj.startedAt !== "string"
  ) {
    return null;
  }
  return {
    version: obj.version,
    pid: obj.pid,
    websocketUrl: obj.websocketUrl,
    startedAt: obj.startedAt,
  };
}

// Shape of the `traycer host install`/`ensure` terminal payload we
// inspect for a service-registration failure. Mirrors the CLI producers
// (commands/host-install.ts, commands/host-ensure.ts).
export interface HostEnsureResultPayload {
  readonly version?: string;
  readonly serviceLifecycle?: {
    readonly priorServiceState?: string;
    readonly stoppedBeforeSwap?: boolean;
    readonly postSwapAction?: string;
    readonly postSwapError?: string | null;
  } | null;
}

export interface ServiceLifecycleSnapshot {
  readonly priorServiceState: string | null;
  readonly postSwapAction: string | null;
  readonly postSwapError: string | null;
}

export function readServiceLifecycle(
  payload: HostEnsureResultPayload | null | undefined,
): ServiceLifecycleSnapshot {
  const lifecycle = payload?.serviceLifecycle ?? null;
  if (lifecycle === null || typeof lifecycle !== "object") {
    return {
      priorServiceState: null,
      postSwapAction: null,
      postSwapError: null,
    };
  }
  const postSwapErrorRaw = lifecycle.postSwapError;
  const postSwapError =
    typeof postSwapErrorRaw === "string" && postSwapErrorRaw.length > 0
      ? postSwapErrorRaw
      : null;
  return {
    priorServiceState:
      typeof lifecycle.priorServiceState === "string"
        ? lifecycle.priorServiceState
        : null,
    postSwapAction:
      typeof lifecycle.postSwapAction === "string"
        ? lifecycle.postSwapAction
        : null,
    postSwapError,
  };
}

export type HostEnsureErrorKind =
  | "offline"
  | "signature"
  | "host-not-ready"
  | "service-registration"
  | "host-busy"
  | "unknown";

export interface HostEnsureError {
  readonly kind: HostEnsureErrorKind;
  readonly message: string;
  readonly code: string | null;
}

// Map a CLI failure into a stable, renderer-friendly error. The renderer
// surfaces `message` in the host gate's unavailable/Doctor card.
export function categorizeHostCliError(err: unknown): HostEnsureError {
  if (err instanceof TraycerCliError) {
    if (
      err.code === "E_NETWORK" ||
      err.code === "E_OFFLINE" ||
      err.code === "E_DOWNLOAD_FAILED" ||
      err.code === "E_REGISTRY_UNREACHABLE"
    ) {
      return {
        kind: "offline",
        message:
          "Traycer needs to download the host to finish setting up. Check your network connection and try again.",
        code: err.code,
      };
    }
    if (
      err.code === "E_SIGNATURE_INVALID" ||
      err.code === "E_CHECKSUM_MISMATCH" ||
      err.code === "E_HOST_VERIFY_FAILED"
    ) {
      return {
        kind: "signature",
        message:
          "The downloaded host failed verification (signature, checksum, or size mismatch). This is a security check - please reinstall Traycer or contact support.",
        code: err.code,
      };
    }
    if (err.code === "E_HOST_BUSY") {
      return {
        kind: "host-busy",
        message:
          "The host has work in progress, so it was not restarted. Checking whether this build can keep using it…",
        code: err.code,
      };
    }
    return { kind: "unknown", message: err.message, code: err.code };
  }
  return {
    kind: "unknown",
    message: err instanceof Error ? err.message : String(err),
    code: null,
  };
}
