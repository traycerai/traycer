import type { StreamCloseReason } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { TimerHandle } from "@traycer-clients/shared/host-transport/timer-handle";

/**
 * Backoff for reopening a notifications stream after a TERMINAL close (the
 * transport session is disposed — `requestReconnect` and wake-time
 * `forceReconnect` are both no-ops on it — so recovery must create a new
 * session). Starts high enough not to hammer a host that is actively
 * rejecting us, caps low enough that a recovered host brings notifications
 * back within minutes.
 */
export const NOTIFICATIONS_STREAM_REOPEN_INITIAL_BACKOFF_MS = 5_000;
export const NOTIFICATIONS_STREAM_REOPEN_MAX_BACKOFF_MS = 300_000;

/**
 * Closes a reopen cannot fix: `caller` is the owner's own teardown,
 * `CLIENT_CLOSED` means the owning stream client itself is gone (the session
 * provider reopens on the replacement client), `INCOMPATIBLE` is permanent
 * for this host session, and `FREE_TIER_NO_CLOUD_SYNC` is the host's
 * deliberate terminal refusal for free-tier users — retrying any of these
 * would loop forever against a permanent answer.
 */
function isReopenableStreamClose(reason: StreamCloseReason | null): boolean {
  if (reason === null || reason.kind !== "fatalError") return false;
  return (
    reason.details.code !== "CLIENT_CLOSED" &&
    reason.details.code !== "INCOMPATIBLE" &&
    reason.details.code !== "FREE_TIER_NO_CLOUD_SYNC"
  );
}

export interface NotificationStreamReopenScheduler {
  /** Arms the reopen timer for a terminal close (no-op for closes a reopen
   * cannot fix, while a reopen is already pending, or after dispose). */
  readonly scheduleAfterClose: (reason: StreamCloseReason | null) => void;
  /** Call on a successful open so the next failure retries promptly. */
  readonly resetBackoff: () => void;
  readonly dispose: () => void;
}

export function createNotificationStreamReopenScheduler(
  reopen: () => void,
): NotificationStreamReopenScheduler {
  let timer: TimerHandle | null = null;
  let backoffMs = NOTIFICATIONS_STREAM_REOPEN_INITIAL_BACKOFF_MS;
  let disposed = false;
  return {
    scheduleAfterClose: (reason) => {
      if (disposed || timer !== null || !isReopenableStreamClose(reason)) {
        return;
      }
      const delayMs = backoffMs;
      backoffMs = Math.min(
        backoffMs * 2,
        NOTIFICATIONS_STREAM_REOPEN_MAX_BACKOFF_MS,
      );
      timer = globalThis.setTimeout(() => {
        timer = null;
        if (disposed) return;
        reopen();
      }, delayMs);
    },
    resetBackoff: () => {
      backoffMs = NOTIFICATIONS_STREAM_REOPEN_INITIAL_BACKOFF_MS;
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
