import type { StreamCloseReason } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { TimerHandle } from "@traycer-clients/shared/host-transport/timer-handle";

/**
 * Backoff for reopening a host stream after a TERMINAL close (the
 * transport session is disposed — `requestReconnect` and wake-time
 * `forceReconnect` are both no-ops on it — so recovery must create a new
 * session). Starts high enough not to hammer a host that is actively
 * rejecting us, caps low enough that a recovered host resumes promptly.
 */
export const HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS = 5_000;
export const HOST_STREAM_REOPEN_MAX_BACKOFF_MS = 300_000;

/**
 * Closes a reopen cannot fix: `caller` is the owner's own teardown,
 * `CLIENT_CLOSED` means the owning stream client itself is gone (the session
 * provider reopens on the replacement client), and `INCOMPATIBLE` is
 * permanent for this host session. Retrying either would loop forever.
 */
export function isReopenableHostStreamClose(
  reason: StreamCloseReason | null,
): boolean {
  if (reason === null || reason.kind !== "fatalError") return false;
  return (
    reason.details.code !== "CLIENT_CLOSED" &&
    reason.details.code !== "INCOMPATIBLE"
  );
}

/** The cloud notifications feed alone has an entitlement refusal that a
 * transport retry cannot solve. Agent activity has no such tier branch. */
export function isReopenableNotificationsStreamClose(
  reason: StreamCloseReason | null,
): boolean {
  return (
    isReopenableHostStreamClose(reason) &&
    reason?.kind === "fatalError" &&
    reason.details.code !== "FREE_TIER_NO_CLOUD_SYNC"
  );
}

export interface HostStreamReopenScheduler {
  /** Arms the reopen timer for a terminal close (no-op for closes a reopen
   * cannot fix, while a reopen is already pending, or after dispose). */
  readonly scheduleAfterClose: (reason: StreamCloseReason | null) => void;
  /** Call on a successful open so the next failure retries promptly. */
  readonly resetBackoff: () => void;
  readonly dispose: () => void;
}

export function createHostStreamReopenScheduler(
  reopen: () => void,
  isReopenable: (reason: StreamCloseReason | null) => boolean,
): HostStreamReopenScheduler {
  let timer: TimerHandle | null = null;
  let backoffMs = HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS;
  let disposed = false;
  return {
    scheduleAfterClose: (reason) => {
      if (disposed || timer !== null || !isReopenable(reason)) {
        return;
      }
      const delayMs = backoffMs;
      backoffMs = Math.min(backoffMs * 2, HOST_STREAM_REOPEN_MAX_BACKOFF_MS);
      timer = globalThis.setTimeout(() => {
        timer = null;
        if (disposed) return;
        reopen();
      }, delayMs);
    },
    resetBackoff: () => {
      backoffMs = HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS;
    },
    dispose: () => {
      disposed = true;
      if (timer !== null) {
        globalThis.clearTimeout(timer);
        timer = null;
      }
    },
  };
}
