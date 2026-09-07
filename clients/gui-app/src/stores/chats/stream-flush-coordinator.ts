/**
 * One scheduler for every streaming chat. Deadline never flushes a visible store;
 * it hands off to rAF plus fallback so a starved rAF keeps the original fallback time.
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

/** Flushes synchronously inside `requestFlush`. */
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
  /** When the store registered; the hidden tier counts from here before the first flush. */
  readonly registeredAt: number;
  /** `null` until the first flush: a visible store's first flush is never held back. */
  lastFlushAt: number | null;
  active: boolean;
}

/**
 * What woke the tick. A `deadline` timer hands visible stores off to a frame
 * (see the module comment); `frame` and `fallback` flush everything due.
 */
type TickSource = "frame" | "fallback" | "deadline";

export function createStreamFlushCoordinator(
  timers: StreamFlushTimers,
): StreamFlushCoordinator {
  // Insertion order doubles as deterministic flush order.
  const entries = new Set<RegistrationState>();
  let frameHandle: number | null = null;
  let timerHandle: number | null = null;
  let timerDueAt: number | null = null;
  /** When the fallback for the pending frame is due; non-null exactly while a frame is pending. */
  let fallbackDueAt: number | null = null;

  function disarm(): void {
    if (frameHandle !== null) {
      timers.cancelFrame(frameHandle);
      frameHandle = null;
    }
    fallbackDueAt = null;
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
    return (entry.lastFlushAt ?? entry.registeredAt) + HIDDEN_FLUSH_INTERVAL_MS;
  }

  function isEntryDue(entry: RegistrationState, now: number): boolean {
    if (!entry.hasPending()) return false;
    return now >= dueAt(entry);
  }

  /**
   * One timer at a time, always the earliest deadline asked for: an earlier armed timer is kept
   * (every timer's tick re-arms whatever it did not cover), a later one is replaced.
   */
  function armTimer(source: "fallback" | "deadline", dueTime: number): void {
    const now = timers.now();
    const due = Math.max(dueTime, now);
    if (timerHandle !== null) {
      if (timerDueAt !== null && timerDueAt <= due) return;
      timers.clearTimer(timerHandle);
      timerHandle = null;
    }
    timerDueAt = due;
    timerHandle = timers.setTimer(() => tick(source), due - now);
  }

  /** A frame, paired with the fallback that stands in for it while rAF is starved. */
  function armFrame(): void {
    if (frameHandle === null) {
      frameHandle = timers.requestFrame(() => tick("frame"));
    }
    if (fallbackDueAt === null) {
      fallbackDueAt = timers.now() + FRAME_TIMEOUT_FALLBACK_MS;
    }
    armTimer("fallback", fallbackDueAt);
  }

  /** Arms for one entry: a frame if it is due now, else a deadline at its due time. */
  function armFor(entry: RegistrationState, now: number): void {
    const due = dueAt(entry);
    if (due <= now && entry.visible) {
      armFrame();
      return;
    }
    armTimer("deadline", due);
  }

  function rearm(): void {
    const now = timers.now();
    let frameNeeded = false;
    let earliestDeadline: number | null = null;
    for (const entry of entries) {
      if (!entry.hasPending()) continue;
      const due = dueAt(entry);
      if (entry.visible && due <= now) {
        frameNeeded = true;
        continue;
      }
      earliestDeadline =
        earliestDeadline === null ? due : Math.min(earliestDeadline, due);
    }
    if (frameNeeded) armFrame();
    else fallbackDueAt = null;
    // Armed even beside a frame: a hidden store's deadline must not wait for
    // a frame that a throttled rAF may never deliver.
    if (earliestDeadline !== null) armTimer("deadline", earliestDeadline);
  }

  function tick(source: TickSource): void {
    // A deadline tick stands in for neither the frame nor its fallback: the
    // frame is re-requested in `rearm` and the fallback keeps its due time.
    const preservedFallbackDueAt = source === "deadline" ? fallbackDueAt : null;
    disarm();
    fallbackDueAt = preservedFallbackDueAt;
    const now = timers.now();
    for (const entry of entries) {
      if (!isEntryDue(entry, now)) continue;
      // A visible store flushes on a frame (or the fallback standing in for
      // one); its floor deadline only re-arms that pairing, in `rearm`.
      if (source === "deadline" && entry.visible) continue;
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
        registeredAt: timers.now(),
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
          // Re-arm for the new tier: a newly-visible store with a buffered tail paints on the next frame (or
          // as soon as its floor allows) instead of waiting out the hidden interval, and a newly-hidden one
          if (entry.hasPending()) armFor(entry, timers.now());
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
