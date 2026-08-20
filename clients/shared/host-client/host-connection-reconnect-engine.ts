import type { StreamCloseReason } from "../host-transport/i-stream-session";
import type { TimerHandle } from "../host-transport/timer-handle";

/**
 * THE per-lease reconnect engine (connection-registry §6, redesign P4.1).
 *
 * The audit found thirteen independent client retry mechanisms. Three of them
 * existed only because stream ownership was scattered across stores and hooks,
 * so each owner grew its own pacing:
 *
 *  - **R9** stream-client rebuild backoff, duplicated in the app-wide stream
 *    provider and the per-host binding hook;
 *  - **R10** terminal-close reopen scheduler, constructed independently by
 *    four notification/activity stores;
 *  - **R12** chat-session wake retry, with its own private episode window.
 *
 * They are not merged into one shared timer - that would be a behavior change,
 * and a bad one: a notifications close would pace an agent-activity reopen,
 * and two hosts' failures would pace each other. What is unified is OWNERSHIP.
 * One engine per host lease hands out independent LANES, so the policy - the
 * constants, the streak rules, the terminal-close classification, the episode
 * window - exists once and is reached one way, while each stream still fails
 * and recovers on its own schedule.
 *
 * That is what makes the acceptance checkable: "exactly one reconnection
 * policy per transport kind" is a statement about where the policy LIVES, and
 * the probe that keeps it honest re-scatters ownership (giving each store its
 * own engine) and must fail.
 */

// ---------------------------------------------------------------------------
// R9 - rebuild pacing
// ---------------------------------------------------------------------------

/**
 * A client that survives at least this long before closing underneath its
 * owner is considered to have genuinely worked - its close resets the rebuild
 * backoff. Anything shorter is a "quick close": the rebuild likely dials
 * straight into the same failure.
 */
const REBUILD_HEALTHY_LIFETIME_MS = 30_000;
const REBUILD_BACKOFF_BASE_MS = 1_000;
const REBUILD_BACKOFF_MAX_MS = 30_000;

/**
 * Rebuild pacing for a stream-client liveness guard - the "a CLOSED client
 * must be replaced, not left dead until the window reloads" loop.
 *
 * Without it that loop is hot: a terminal-class close (incompatible protocol,
 * plan restriction, a host too old for the negotiated method) ends every fresh
 * dial the same way, so rebuild -> grant mint -> relay dial -> handshake ->
 * same fatal -> rebuild, one full cycle per round trip, indefinitely.
 */
export interface StreamRebuildPacer {
  /**
   * Start a served client's lifetime clock; call where the client is built.
   *
   * `transportIdentity` names the endpoint this client dials, and a change in
   * it clears the streak. A streak measures "dialing THIS thing keeps
   * failing", which says nothing about the next machine: carried across a
   * pick, an older host's terminal-class closes would pace the first stumble
   * on a healthy one by up to the full ceiling, for no reason the person
   * could see.
   */
  readonly markBuilt: (nowMs: number, transportIdentity: string | null) => void;
  /**
   * How long to wait before the rebuild this close triggers, and the reason
   * this is a mutating read: it also advances (or resets) the quick-close
   * streak, so it must be called exactly once per close.
   */
  readonly nextRebuildDelayMs: (nowMs: number) => number;
}

function createStreamRebuildPacer(): StreamRebuildPacer {
  let quickCloses = 0;
  let builtAt = 0;
  let identity: string | null = null;
  return {
    markBuilt: (nowMs: number, transportIdentity: string | null): void => {
      // Only a move BETWEEN two known endpoints clears the streak. Adopting
      // the first identity must not, or the guard's opening observation - a
      // client already closed before anything was ever built, which is
      // counted deliberately - would be erased by the very rebuild it
      // triggers.
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
      // The FIRST quick close still rebuilds immediately - the guard's whole
      // point is instant recovery from the closed-client wedge. Backoff kicks
      // in from the second consecutive quick close, which is what a
      // terminal-class fatal looks like and a one-off wedge does not.
      if (quickCloses <= 1) return 0;
      return Math.min(
        REBUILD_BACKOFF_MAX_MS,
        REBUILD_BACKOFF_BASE_MS * 2 ** (quickCloses - 2),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// R10 - terminal-close reopen lanes
// ---------------------------------------------------------------------------

/**
 * Backoff for reopening a host stream after a TERMINAL close (the transport
 * session is disposed - `requestReconnect` and wake-time `forceReconnect` are
 * both no-ops on it - so recovery must create a new session). Starts high
 * enough not to hammer a host that is actively rejecting us, caps low enough
 * that a recovered host resumes promptly.
 */
export const HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS = 5_000;
export const HOST_STREAM_REOPEN_MAX_BACKOFF_MS = 300_000;

/**
 * Closes a reopen cannot fix: `caller` is the owner's own teardown,
 * `CLIENT_CLOSED` means the owning stream client itself is gone (the session
 * provider reopens on the replacement client), and `INCOMPATIBLE` is permanent
 * for this host session. Retrying either would loop forever.
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

/**
 * One stream's reopen schedule. Independent of its siblings on purpose: these
 * are different logical streams over one host, and folding them onto a shared
 * timer would let a notifications refusal pace an agent-activity recovery.
 */
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

// ---------------------------------------------------------------------------
// R12 - wake episode
// ---------------------------------------------------------------------------

/**
 * One physical wake fans out as several pulses: the desktop shell fires the
 * resume AND unlock-screen bridges, and the `online` event lands after its own
 * ~250ms debounce. A live session absorbs that (`forceReconnect` is cheap and
 * idempotent), but a retry is a full stream-client rebuild, and a permanently
 * fatal session (e.g. INCOMPATIBLE) re-closes fast enough to be re-attempted
 * by every pulse. Attempts inside this window are skipped, folding the burst
 * into one dial per wake.
 */
export const WAKE_RETRY_EPISODE_MS = 5_000;

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export interface HostReconnectEngine {
  /**
   * A fresh rebuild pacer for ONE stream-client owner. Per owner rather than
   * per host, because the streak measures "rebuilding THIS client keeps
   * failing"; the shared thing is the policy, not the counter.
   */
  readonly createRebuildPacer: () => StreamRebuildPacer;
  /** A fresh reopen lane for one logical stream. */
  readonly openReopenLane: (
    reopen: () => void,
    isReopenable: (reason: StreamCloseReason | null) => boolean,
  ) => ReopenLane;
  /**
   * R12's episode gate, owned here so there is ONE wake-episode window rather
   * than a private `Map` inside the chat-session subscriber. `key` scopes the
   * episode to whatever the caller retries (a chat-session handle); the
   * WINDOW is the engine's.
   *
   * Returns true when this caller may attempt a retry for this wake, and
   * stamps the episode. False means a sibling pulse of the same physical wake
   * already took the attempt.
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
 * The PROCESS-scoped engine, for the reconnect subjects that are genuinely not
 * host-scoped (redesign P4.1, ruling D1).
 *
 * R12's chat-session wake retry is the case this exists for: a
 * `ChatSessionStoreHandle` carries no `hostId`, and the wake subscriber walks
 * the module-global chat-session registry deduping per HANDLE, process-wide.
 * Scoping its episode window per host would change which retries coalesce on a
 * wake - a behavior change this consolidation is not allowed to make - and
 * would mean threading a host id onto the chat store's public shape to buy
 * nothing the acceptance asks for.
 *
 * So: **"collapsed into the per-lease reconnect engine" is true of R9 and R10,
 * and deliberately NOT of R12.** What R12 gets is the fold that actually
 * mattered - one `WAKE_RETRY_EPISODE_MS`, one claim/query API, its private
 * bookkeeping deleted - with the instance scoped to its own subject. Ownership
 * is unified; the scope follows the subject rather than the sentence.
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
