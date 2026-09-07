import type { StreamCloseReason } from "../host-transport/i-stream-session";
import type { TimerHandle } from "../host-transport/timer-handle";

/** The per-lease reconnect engine (connection-registry §6, redesign P4.1). */

 // --------------------------------------------------------------------------- R9 - rebuild pacing ---------------------------------------------------------------------------

/**
 * A client that survives at least this long before closing underneath its owner is considered to have genuinely worked - its close resets the rebuild backoff.
 */
const REBUILD_HEALTHY_LIFETIME_MS = 30_000;
const REBUILD_BACKOFF_BASE_MS = 1_000;
const REBUILD_BACKOFF_MAX_MS = 30_000;

/**
 * Rebuild pacing for a stream-client liveness guard - the "a closed client must be replaced, not left dead until the window reloads" loop.
 */
export interface StreamRebuildPacer {
  /** Start a served client's lifetime clock; call where the client is built. */
  readonly markBuilt: (nowMs: number, transportIdentity: string | null) => void;
  /**
   * How long to wait before the rebuild this close triggers, and the reason this is a mutating read: it also advances (or resets) the quick-close streak, so it must be called exactly once per close.
   */
  readonly nextRebuildDelayMs: (nowMs: number) => number;
}

function createStreamRebuildPacer(): StreamRebuildPacer {
  let quickCloses = 0;
  let builtAt = 0;
  let identity: string | null = null;
  return {
    markBuilt: (nowMs: number, transportIdentity: string | null): void => {
      // Only a move between two known endpoints clears the streak.
      // Adopting the first identity must not, or the guard's opening observation - a client already closed before anything was ever built, which is counted deliberately - would be erased by the very rebuild it triggers.
      if (identity !== null && transportIdentity !== identity) {
        quickCloses = 0;
      }
      identity = transportIdentity;
      builtAt = nowMs;
    },
    nextRebuildDelayMs: (nowMs: number): number => {
      if (nowMs - builtAt >= REBUILD_HEALTHY_LIFETIME_MS) {
        quickCloses = 0;
      } else {
        quickCloses += 1;
      }
      // The first quick close still rebuilds immediately - the guard's whole point is instant recovery from the closed-client wedge.
      if (quickCloses <= 1) return 0;
      return Math.min(
        REBUILD_BACKOFF_MAX_MS,
        REBUILD_BACKOFF_BASE_MS * 2 ** (quickCloses - 2),
      );
    },
  };
}

 // --------------------------------------------------------------------------- R10 - terminal-close reopen lanes ---------------------------------------------------------------------------

/**
 * Backoff for reopening a host stream after a terminal close (the transport session is disposed - `requestReconnect` and wake-time `forceReconnect` are both no-ops on it - so recovery must create a new session).
 */
export const HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS = 5_000;
export const HOST_STREAM_REOPEN_MAX_BACKOFF_MS = 300_000;

export function isReopenableHostStreamClose(
  reason: StreamCloseReason | null,
): boolean {
  if (reason === null || reason.kind !== "fatalError") return false;
  return (
    reason.details.code !== "CLIENT_CLOSED" &&
    reason.details.code !== "INCOMPATIBLE"
  );
}

/**
 * The cloud notifications feed alone has an entitlement refusal that a
 * transport retry cannot solve. Agent activity has no such tier branch.
 */
export function isReopenableNotificationsStreamClose(
  reason: StreamCloseReason | null,
): boolean {
  return (
    isReopenableHostStreamClose(reason) &&
    reason?.kind === "fatalError" &&
    reason.details.code !== "FREE_TIER_NO_CLOUD_SYNC"
  );
}

export interface ReopenLane {
  /**
   * Arms the reopen timer for a terminal close (no-op for closes a reopen
   * cannot fix, while a reopen is already pending, or after dispose).
   */
  readonly scheduleAfterClose: (reason: StreamCloseReason | null) => void;
  /** Call on a successful open so the next failure retries promptly. */
  readonly resetBackoff: () => void;
  readonly dispose: () => void;
}

 // --------------------------------------------------------------------------- R12 - wake episode ---------------------------------------------------------------------------

/**
 * One physical wake fans out as several pulses: the desktop shell fires the resume and unlock-screen bridges, and the `online` event lands after its own ~250ms debounce.
 */
export const WAKE_RETRY_EPISODE_MS = 5_000;

// --------------------------------------------------------------------------- The engine ---------------------------------------------------------------------------

export interface HostReconnectEngine {
  /**
   * A fresh rebuild pacer for one stream-client owner.
   * Per owner rather than per host, because the streak measures "rebuilding this client keeps failing"; the shared thing is the policy, not the counter.
   */
  readonly createRebuildPacer: () => StreamRebuildPacer;
  /** A fresh reopen lane for one logical stream. */
  readonly openReopenLane: (
    reopen: () => void,
    isReopenable: (reason: StreamCloseReason | null) => boolean,
  ) => ReopenLane;
  /**
   * R12's episode gate, owned here so there is one wake-episode window rather than a private `Map` inside the chat-session subscriber.
   */
  readonly claimWakeEpisode: (key: object, nowMs: number) => boolean;
  /** Was `key`'s episode stamped within the window ending at `nowMs`? */
  readonly isWithinWakeEpisode: (key: object, nowMs: number) => boolean;
  /** Drops every lane and episode. Called when the host's record is dropped. */
  readonly dispose: () => void;
}

export function createHostReconnectEngine(): HostReconnectEngine {
  const lanes = new Set<ReopenLane>();
  // Keyed by the caller's own object so a retired session's episode is
  // collectable with it rather than pinned by a string id nobody clears.
  const episodes = new WeakMap<object, number>();
  let disposed = false;

  const openReopenLane = (
    reopen: () => void,
    isReopenable: (reason: StreamCloseReason | null) => boolean,
  ): ReopenLane => {
    let timer: TimerHandle | null = null;
    let backoffMs = HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS;
    let laneDisposed = false;
    const lane: ReopenLane = {
      scheduleAfterClose: (reason) => {
        if (
          disposed ||
          laneDisposed ||
          timer !== null ||
          !isReopenable(reason)
        ) {
          return;
        }
        const delayMs = backoffMs;
        backoffMs = Math.min(backoffMs * 2, HOST_STREAM_REOPEN_MAX_BACKOFF_MS);
        timer = globalThis.setTimeout(() => {
          timer = null;
          if (disposed || laneDisposed) return;
          reopen();
        }, delayMs);
      },
      resetBackoff: () => {
        backoffMs = HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS;
      },
      dispose: () => {
        laneDisposed = true;
        if (timer !== null) {
          globalThis.clearTimeout(timer);
          timer = null;
        }
        lanes.delete(lane);
      },
    };
    lanes.add(lane);
    return lane;
  };

  return {
    createRebuildPacer: createStreamRebuildPacer,
    openReopenLane,
    claimWakeEpisode: (key, nowMs) => {
      const last = episodes.get(key);
      if (last !== undefined && nowMs - last < WAKE_RETRY_EPISODE_MS) {
        return false;
      }
      episodes.set(key, nowMs);
      return true;
    },
    isWithinWakeEpisode: (key, nowMs) => {
      const last = episodes.get(key);
      return last !== undefined && nowMs - last < WAKE_RETRY_EPISODE_MS;
    },
    dispose: () => {
      disposed = true;
      for (const lane of [...lanes]) {
        lane.dispose();
      }
      lanes.clear();
    },
  };
}

/**
 * The process-scoped engine, for the reconnect subjects that are genuinely not host-scoped (redesign P4.1, ruling D1).
 * Ownership is unified; the scope follows the subject rather than the sentence.
 */
let processEngine: HostReconnectEngine | null = null;

export function processReconnectEngine(): HostReconnectEngine {
  processEngine ??= createHostReconnectEngine();
  return processEngine;
}

/** Test-only: drops the process engine so suites do not share episodes. */
export function resetProcessReconnectEngineForTest(): void {
  processEngine?.dispose();
  processEngine = null;
}
