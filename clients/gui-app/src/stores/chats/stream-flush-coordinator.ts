/**
 * Global coalescing scheduler for streaming chat store flushes.
 *
 * Every chat session store buffers its `blockDelta` frames locally and folds
 * them into one `set()` per flush (see `chat-session-store.ts`). This module
 * decides WHEN those flushes run. One coordinator serves every store in the
 * renderer, so N concurrently-streaming chats cost O(1) scheduler callbacks
 * per frame instead of N independent `requestAnimationFrame` registrations.
 *
 * Tick sources - two timers race, whichever fires first runs the tick and
 * cancels the other:
 *
 * - `requestAnimationFrame`: the cadence while the window is visible and a
 *   visible store is due. The flush lands on a frame boundary.
 * - a `setTimeout` fallback (`FRAME_TIMEOUT_FALLBACK_MS`): rAF does not fire
 *   while the window is hidden/minimized, which previously let buffered
 *   deltas accumulate for the whole duration of a long uninterrupted stream.
 *   The timeout keeps draining buffers at a slow cadence with no
 *   `visibilitychange` listeners.
 * - a `setTimeout` at the next due time, when every pending store is inside
 *   its interval (a hidden store's slow tier, or a visible store's floor).
 *
 * Visibility tiers - each registration carries a visibility flag reported
 * from the React layer (chat is visible when ANY surface rendering it is
 * visible; default visible so an unreported store never starves):
 *
 * - visible: flushes on the next frame, then no more often than
 *   `VISIBLE_FLUSH_MIN_INTERVAL_MS`. Every flush is a React commit of the
 *   streaming row plus a style/layout/paint pass, and each of those allocates
 *   Blink-heap garbage; on a 120 Hz display an uncapped rAF cadence cost
 *   ~1 MB/s of that per streaming chat. ~30 flushes/s is well past what a
 *   reader can perceive at token cadence and a quarter of the work.
 * - hidden (`display:none` keep-alive tab, backgrounded pane): flushes only
 *   when `HIDDEN_FLUSH_INTERVAL_MS` has elapsed since its last flush. Passive
 *   consumers (epic-sidebar progress, notification triggers) stay live at the
 *   slow cadence while the per-token render work for invisible streams drops
 *   to ~2 writes/second.
 */

/** Fallback tick delay while rAF is starved (hidden/minimized window). */
export const FRAME_TIMEOUT_FALLBACK_MS = 500;

/** Minimum interval between flushes for stores with no visible surface. */
export const HIDDEN_FLUSH_INTERVAL_MS = 500;

/** Minimum interval between two flushes of a visible store (~30 Hz). */
export const VISIBLE_FLUSH_MIN_INTERVAL_MS = 32;

/**
 * Timer seam. Production uses rAF + window timeouts (see
 * `BROWSER_STREAM_FLUSH_TIMERS`); tests inject fake timers.
 */
export interface StreamFlushTimers {
  readonly now: () => number;
  readonly requestFrame: (run: () => void) => number;
  readonly cancelFrame: (handle: number) => void;
  readonly setTimer: (run: () => void, delayMs: number) => number;
  readonly clearTimer: (handle: number) => void;
}

/** What a chat session store exposes to the coordinator. */
export interface StreamFlushRegistrationInput {
  /** Applies the buffered deltas in one `set()`. Identity-stable on no-op. */
  readonly flush: () => void;
  /** Whether the store currently has buffered, unapplied deltas. */
  readonly hasPending: () => boolean;
}

/** Per-store handle returned by `register`. */
export interface StreamFlushLease {
  /** Arms the next tick. Called once per buffered delta; cheap when armed. */
  readonly requestFlush: () => void;
  /** Reports the rolled-up surface visibility for this store. */
  readonly setVisible: (visible: boolean) => void;
  /** Drops the registration; pending buffers are the store's to discard. */
  readonly unregister: () => void;
}

export interface StreamFlushCoordinator {
  readonly register: (input: StreamFlushRegistrationInput) => StreamFlushLease;
}

/**
 * Flushes synchronously inside `requestFlush`. Test seam mirroring the old
 * `IMMEDIATE_STREAM_FLUSH_SCHEDULER`: assertions observe the applied delta on
 * the same tick, with no timers involved.
 */
export const IMMEDIATE_STREAM_FLUSH_COORDINATOR: StreamFlushCoordinator = {
  register: (input) => ({
    requestFlush: () => {
      input.flush();
    },
    setVisible: () => {},
    unregister: () => {},
  }),
};

interface RegistrationState {
  readonly flush: () => void;
  readonly hasPending: () => boolean;
  visible: boolean;
  /** `null` until the first flush: a visible store's first flush is never held back. */
  lastFlushAt: number | null;
  active: boolean;
}

export function createStreamFlushCoordinator(
  timers: StreamFlushTimers,
): StreamFlushCoordinator {
  // Insertion order doubles as deterministic flush order.
  const entries = new Set<RegistrationState>();
  let frameHandle: number | null = null;
  let timerHandle: number | null = null;
  let timerDueAt: number | null = null;

  function disarm(): void {
    if (frameHandle !== null) {
      timers.cancelFrame(frameHandle);
      frameHandle = null;
    }
    if (timerHandle !== null) {
      timers.clearTimer(timerHandle);
      timerHandle = null;
      timerDueAt = null;
    }
  }

  /** Earliest time this entry may flush again; `-Infinity` for a visible store that never has. */
  function dueAt(entry: RegistrationState): number {
    if (entry.visible) {
      return entry.lastFlushAt === null
        ? Number.NEGATIVE_INFINITY
        : entry.lastFlushAt + VISIBLE_FLUSH_MIN_INTERVAL_MS;
    }
    // A hidden store that never flushed waits out a full interval from
    // registration, so a hidden stream never fans out on its first delta.
    return (entry.lastFlushAt ?? 0) + HIDDEN_FLUSH_INTERVAL_MS;
  }

  function isEntryDue(entry: RegistrationState, now: number): boolean {
    if (!entry.hasPending()) return false;
    return now >= dueAt(entry);
  }

  function armFrame(): void {
    if (frameHandle !== null) return;
    frameHandle = timers.requestFrame(tick);
    // An already-armed earlier timer is kept - firing sooner is harmless and
    // re-arming on every per-token requestFlush would churn timers.
    if (timerHandle === null) {
      timerDueAt = timers.now() + FRAME_TIMEOUT_FALLBACK_MS;
      timerHandle = timers.setTimer(tick, FRAME_TIMEOUT_FALLBACK_MS);
    }
  }

  function armTimerAt(dueTime: number): void {
    // Frame mode already ticks sooner than any timed deadline.
    if (frameHandle !== null) return;
    if (timerHandle !== null) {
      if (timerDueAt !== null && timerDueAt <= dueTime) return;
      timers.clearTimer(timerHandle);
      timerHandle = null;
    }
    const delay = Math.max(0, dueTime - timers.now());
    timerDueAt = timers.now() + delay;
    timerHandle = timers.setTimer(tick, delay);
  }

  /** Arms for one entry: a frame if it is due now, else a timer at its due time. */
  function armFor(entry: RegistrationState, now: number): void {
    const due = dueAt(entry);
    if (due <= now) {
      if (entry.visible) armFrame();
      else armTimerAt(now);
      return;
    }
    armTimerAt(due);
  }

  function rearm(): void {
    const now = timers.now();
    let earliestDueAt: number | null = null;
    for (const entry of entries) {
      if (!entry.hasPending()) continue;
      const due = dueAt(entry);
      if (entry.visible && due <= now) {
        armFrame();
        return;
      }
      earliestDueAt =
        earliestDueAt === null ? due : Math.min(earliestDueAt, due);
    }
    if (earliestDueAt !== null) {
      armTimerAt(Math.max(earliestDueAt, now));
    }
  }

  function tick(): void {
    disarm();
    const now = timers.now();
    for (const entry of entries) {
      if (!isEntryDue(entry, now)) continue;
      entry.lastFlushAt = now;
      entry.flush();
    }
    rearm();
  }

  return {
    register: (input) => {
      const entry: RegistrationState = {
        flush: input.flush,
        hasPending: input.hasPending,
        visible: true,
        lastFlushAt: null,
        active: true,
      };
      entries.add(entry);
      return {
        requestFlush: () => {
          if (!entry.active || !entry.hasPending()) return;
          armFor(entry, timers.now());
        },
        setVisible: (visible) => {
          if (!entry.active || entry.visible === visible) return;
          entry.visible = visible;
          // A newly-visible store with a buffered tail should paint on the
          // next frame (or as soon as its floor allows), not wait out the
          // hidden-tier interval.
          if (visible && entry.hasPending()) armFor(entry, timers.now());
        },
        unregister: () => {
          if (!entry.active) return;
          entry.active = false;
          entries.delete(entry);
          if (entries.size === 0) disarm();
        },
      };
    },
  };
}

/** Production timers: rAF cadence with a real-time timeout fallback. */
export const BROWSER_STREAM_FLUSH_TIMERS: StreamFlushTimers = {
  now: () => performance.now(),
  requestFrame: (run) => requestAnimationFrame(() => run()),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
  setTimer: (run, delayMs) => window.setTimeout(run, delayMs),
  clearTimer: (handle) => window.clearTimeout(handle),
};
