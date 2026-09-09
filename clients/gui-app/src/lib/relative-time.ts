import { useSyncExternalStore } from "react";

const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
// Where the compact ladder stops counting weeks and shows a date instead.
const COMPACT_WEEKS_CUTOFF_MS = 4 * WEEK_MS;

/**
 * A shared ticking clock: one `setInterval` for every component subscribed to
 * it, so a popover with 20 rows pays one timer - not 20. `tick` increments on
 * each fire; `useSyncExternalStore` wakes only the components that subscribed
 * to THIS clock, so sibling rows reading a different cadence (or none) are not
 * re-rendered.
 *
 * Both cadences share this lifecycle so a sampling or cleanup fix applies to
 * each of them.
 */
interface SharedClock {
  /** For `useSyncExternalStore`'s subscribe argument. Starts the interval on
   *  the first listener and stops it when the last one leaves. */
  readonly subscribe: (listener: () => void) => () => void;
  /** Monotonic tick count - the store snapshot, not a time. */
  readonly getSnapshot: () => number;
  /** The instant sampled at construction, subscription, or the last fire. */
  readonly sampledNow: () => number;
}

/**
 * Exported for the subscribe-cost pin in `__tests__/relative-time.test.ts`.
 * Whether a mass mount costs a linear or a quadratic number of listener calls
 * is a property of THIS function; counting through React would measure the
 * scheduler's batching instead, and batching is exactly what would hide it.
 * Production has the two instances constructed below and no others.
 */
export function createSharedClock(intervalMs: number): SharedClock {
  let tick = 0;
  let intervalHandle: number | null = null;
  // Sampled at construction so the first render of a consumer has a valid
  // value before `useSyncExternalStore`'s subscribe effect runs. Re-sampled on
  // every interval fire and whenever the clock is (re)started.
  let sampledNow = Date.now();
  const listeners = new Set<() => void>();
  let refreshGeneration = 0;
  let pendingRefreshGeneration: number | null = null;
  let lastNotifiedTick = tick;

  const notifyListeners = (): void => {
    lastNotifiedTick = tick;
    for (const listener of listeners) {
      listener();
    }
  };

  const notifySubscriptionRefresh = (): void => {
    if (pendingRefreshGeneration !== null) return;
    const generation = ++refreshGeneration;
    pendingRefreshGeneration = generation;
    // One immediate sweep preserves correction of an already-mounted sibling.
    // Further subscriptions refresh their snapshot synchronously, but share
    // one trailing sweep of the final sample at the next microtask checkpoint.
    // N mounts therefore cost at most two sweeps, even across N milliseconds.
    queueMicrotask(() => {
      if (pendingRefreshGeneration !== generation) return;
      pendingRefreshGeneration = null;
      if (lastNotifiedTick !== tick) notifyListeners();
    });
    notifyListeners();
  };

  const startIfNeeded = (): void => {
    if (intervalHandle !== null) return;
    sampledNow = Date.now();
    intervalHandle = window.setInterval(() => {
      tick += 1;
      sampledNow = Date.now();
      notifyListeners();
    }, intervalMs);
  };

  const stopIfIdle = (): void => {
    if (listeners.size > 0) return;
    // A queued microtask cannot be cancelled. Invalidate its generation so it
    // cannot notify a later batch after this clock has stopped and restarted.
    pendingRefreshGeneration = null;
    if (intervalHandle === null) return;
    window.clearInterval(intervalHandle);
    intervalHandle = null;
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      // Capture BEFORE startIfNeeded: its resample would otherwise hide the
      // change from the snapshot guard and leave the first render one tick
      // stale. The comparison must use the sample that render actually saw.
      const sampleTheRenderSaw = sampledNow;
      startIfNeeded();
      // A new subscriber's FIRST render already happened, and it read whatever
      // sample the last fire (or module load) left behind - up to one whole
      // interval old. That is a visible error at both cadences: a grace card
      // mounting 900ms into the second clock's tick renders a countdown 900ms
      // high (a 5s window paints "6s"), and a row mounting 50s into the minute
      // clock's renders "Just now" for something a minute old.
      //
      // Re-sampling alone would not reach the screen: `getSnapshot` returns the
      // TICK, so a fresher time behind an unchanged tick is a store React has
      // no reason to re-read. Bumping the tick is what makes the correction a
      // re-render - and `useSyncExternalStore` re-reads the snapshot right
      // after subscribe for exactly this case, a store that moved between
      // render and effect.
      //
      // Every listener must eventually observe the refreshed sample. The
      // broadcast is coalesced independently of millisecond timing; the sample
      // and snapshot correction are not, since the newcomer needs them before
      // subscribe returns. Existing consumers catch the final sample in the
      // trailing sweep, without waiting for the next interval fire.
      //
      // `>` rather than `!==` so a backwards system-clock jump does not thrash
      // every listener; the sample simply stands until the next fire re-takes
      // it.
      const now = Date.now();
      if (now > sampleTheRenderSaw) {
        sampledNow = now;
        tick += 1;
        notifySubscriptionRefresh();
      }
      return () => {
        listeners.delete(listener);
        stopIfIdle();
      };
    },
    getSnapshot: () => tick,
    sampledNow: () => sampledNow,
  };
}

// The long clock: every relative timestamp, reset countdown and "far reset"
// decision in the app. Minute resolution is what those labels change at.
const minuteClock = createSharedClock(MINUTE_MS);
const { subscribe, getSnapshot } = minuteClock;
const sampledNowOf = minuteClock.sampledNow;

/**
 * The SECOND clock, for the provider-fallback grace countdown alone.
 *
 * Its own cadence rather than a faster shared one: a 1s tick on the clock the
 * transcript's timestamps use would repaint every relative label in the window
 * sixty times a minute to move one number. Keeping them apart means the cost is
 * paid only while a countdown card is mounted, and it stops the moment the card
 * unmounts - `stopIfIdle` clears the interval when the last subscriber leaves,
 * which for this clock is the common case rather than the rare one.
 */
const secondClock = createSharedClock(SECOND_MS);

/**
 * Pure bucketed relative-time formatter.
 *
 * Buckets: Just now (<1m) / `${n}m ago` / `${n}h ago` / Yesterday
 * (1 day) / short date ("Mar 5") for older. Negative deltas clamp to 0 so a
 * clock-skewed `createdAt` in the future still renders as "Just now".
 */
export function formatRelativeTimestamp(
  createdAt: number,
  now: number,
): string {
  const diffMs = Math.max(0, now - createdAt);
  const minutes = Math.floor(diffMs / MINUTE_MS);
  const hours = Math.floor(diffMs / HOUR_MS);
  const days = Math.floor(diffMs / DAY_MS);

  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return "Yesterday";
  return formatShortDate(createdAt);
}

function formatShortDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/**
 * The COMPACT ladder, for dense surfaces that show a timestamp beside other
 * values rather than as a sentence: `now` / `10m` / `4h` / `1d` / `1w`, then a
 * short date. No "ago" - the suffix costs width on every row to say what the
 * surface's context already says.
 *
 * Each unit runs to its own natural rollover (60m, 24h, 7d) so the label always
 * names the largest whole unit. Weeks stop at 4: past a month "5w" is harder to
 * place than "Mar 5", and the counting gets less meaningful the further back it
 * goes. Negative deltas clamp to 0, so clock skew reads as `now` rather than a
 * negative duration.
 */
export function formatCompactRelativeTime(
  timestamp: number,
  now: number,
): string {
  const diffMs = Math.max(0, now - timestamp);
  if (diffMs < MINUTE_MS) return "now";
  if (diffMs < HOUR_MS) return `${Math.floor(diffMs / MINUTE_MS)}m`;
  if (diffMs < DAY_MS) return `${Math.floor(diffMs / HOUR_MS)}h`;
  if (diffMs < WEEK_MS) return `${Math.floor(diffMs / DAY_MS)}d`;
  if (diffMs < COMPACT_WEEKS_CUTOFF_MS) {
    return `${Math.floor(diffMs / WEEK_MS)}w`;
  }
  return formatShortDate(timestamp);
}

/**
 * `formatCompactRelativeTime` bound to the shared 60s clock. Same leaf-component
 * guidance as {@link useRelativeTimestamp}: call it from a small leaf so the
 * tick repaints the label rather than its surrounding row.
 */
export function useCompactRelativeTime(timestamp: number): string {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return formatCompactRelativeTime(timestamp, sampledNowOf());
}

/**
 * Subscribes the calling component to the shared 60s tick clock and returns
 * the current bucketed label for `createdAt`. Intended to be called from a
 * small leaf component (e.g. `<NotificationTimestamp />`) so the surrounding
 * list row does not re-render when the clock ticks.
 */
export function useRelativeTimestamp(createdAt: number): string {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return formatRelativeTimestamp(createdAt, sampledNowOf());
}

export function useSampledNow(): number {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return sampledNowOf();
}

/**
 * Pure future-facing countdown formatter, the mirror of
 * `formatRelativeTimestamp` for a reset time instead of a creation time.
 *
 * Buckets: `${n}s` (<1m away) / `${n}m` / `${h}h ${m}m` (m omitted when 0) /
 * `${d}d`. A past `resetsAt` (clock skew, or the window rolled over between
 * fetch and render) clamps to "0s" rather than a negative duration.
 */
export function formatResetCountdown(resetsAt: number, now: number): string {
  const diffMs = Math.max(0, resetsAt - now);
  const minutes = Math.floor(diffMs / MINUTE_MS);
  if (minutes < 1) {
    if (diffMs === 0) return "0s";
    const seconds = Math.max(1, Math.floor(diffMs / SECOND_MS));
    return `${seconds}s`;
  }
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes > 0
      ? `${hours}h ${remainingMinutes}m`
      : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/**
 * Subscribes to the shared 60s tick clock and returns the current countdown
 * label for `resetsAt` (epoch-ms), or `null` when there is nothing to count
 * down to. Shares the same clock `useRelativeTimestamp` uses, so a popover
 * showing several rate-limit windows alongside relative message timestamps
 * still pays for only one interval.
 */
export function useResetCountdown(resetsAt: number | null): string | null {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (resetsAt === null) return null;
  return formatResetCountdown(resetsAt, sampledNowOf());
}

/**
 * Whether a reset is far enough away that an absolute calendar date/time reads
 * better than a relative countdown ("Resets in 3d" is too coarse to act on).
 * Based on the real time remaining rather than a window's nominal duration:
 * some windows (e.g. Claude's per-model `modelScoped` buckets) carry no
 * `durationMinutes` at all, so gating this decision on duration meant those
 * windows always fell back to the relative countdown even when their real
 * reset was days away (regression: Claude's "Fable" per-model window showed
 * "Resets in 3d" instead of a precise calendar date/time). Every window always has a
 * real `resetsAt`, so every caller now derives this the same way instead of
 * each threading through its own duration-based flag (or, worse, hardcoding
 * one).
 */
export function isFarReset(resetsAt: number, now: number): boolean {
  return resetsAt - now >= DAY_MS;
}

/**
 * Subscribes to the shared 60s tick clock and returns whether `resetsAt` is
 * currently far enough away to warrant an absolute calendar date/time over
 * `formatResetCountdown` - `false` for a `null` resetsAt (nothing to compare).
 * Reactive so a window that crosses the
 * one-day threshold while the popover is open flips from absolute to relative
 * display without a remount.
 */
export function useIsFarReset(resetsAt: number | null): boolean {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (resetsAt === null) return false;
  return isFarReset(resetsAt, sampledNowOf());
}

/**
 * Exact reset time as weekday + time (e.g. "Sat 3:35 AM"), for windows where
 * a relative countdown ("Resets in 3d") is too coarse to act on. Drops the
 * calendar date on purpose: these windows reset within the next 7 days, so
 * the weekday alone disambiguates it, and the shorter string reads better in
 * a tight row. `hour12: true` is explicit rather than left to locale default
 * so the AM/PM designator always renders. A pure function, not a hook: unlike
 * a relative countdown, an absolute time string doesn't go stale as time
 * passes, so it doesn't need to subscribe to the shared tick clock.
 */
export function formatResetDateTime(resetsAt: number): string {
  const date = new Date(resetsAt);
  const weekday = date.toLocaleDateString(undefined, { weekday: "short" });
  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${weekday} ${time}`;
}

/**
 * A PAST instant as an absolute date and time (e.g. "Aug 14, 3:42 PM"), for
 * prose that states when something happened.
 *
 * Pure, and deliberately not a hook. A relative label inside a sentence has to
 * choose between subscribing its whole component to the shared tick - which,
 * for a sentence that lives on a chat tile, would repaint the transcript once a
 * minute - and silently freezing at whatever it read on the last render, which
 * is worse than coarse: it is wrong. An absolute stamp never goes stale, so it
 * needs neither. Same reasoning as {@link formatResetDateTime}, in the other
 * time direction.
 *
 * The year is omitted: these read alongside content the reader already places
 * in time, and the compact form is what fits in a sentence.
 */
export function formatAbsoluteDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Full calendar form for roomy surfaces such as Settings, where the explicit
 * date is more useful than the popover's compact weekday-only label.
 */
export function formatResetFullDateTime(resetsAt: number): string {
  return new Date(resetsAt).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Bare wall-clock time - "3:00 PM".
 *
 * The one format the provider-fallback surfaces state a resume time in: the
 * waiting card ("Resuming at 3:00 PM"), its background-items row ("Waiting for
 * Claude Code's limit · resumes 3:00 PM"), and the destination menu's wait row.
 * Exported so those three cannot drift apart - the background panel's own
 * `formatWakeupTime` is a zero-padded 24-hour string ("15:00") belonging to the
 * Claude wake row, and ux-surfaces is explicit that a fallback wait must never
 * be rendered in the wake row's form.
 *
 * No weekday and no date, unlike {@link formatResetDateTime}: a wait is capped
 * at the policy's longest wait (six hours by default), so the day is never in
 * question and the extra words cost width in a card that is mostly buttons.
 * `hour12` is explicit rather than left to the locale so the AM/PM designator
 * always renders - without it "3:00" is ambiguous in exactly the case the card
 * exists for.
 *
 * Pure, not a hook: an absolute time does not go stale.
 */
export function formatClockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * What the grace card renders once the countdown has run out.
 *
 * Deliberately not "0s". The deadline is the HOST's, and this countdown is
 * presentational: the two clocks drift, the frame announcing the switch takes a
 * moment to arrive, and a card reading "0s" for three seconds is asserting
 * something the user can see is false. "Any moment now" is true across the
 * whole of that window and needs no accuracy the client does not have.
 */
export const GRACE_COUNTDOWN_IMMINENT = "any moment now";

/**
 * Seconds-resolution countdown to a grace deadline, for the fallback card.
 *
 * `${n}s` below a minute, `${m}m ${s}s` above it (seconds dropped on the
 * minute), and {@link GRACE_COUNTDOWN_IMMINENT} at or past the deadline. The
 * two-part form exists because the grace window is a user setting bounded at
 * five minutes, not a fixed twelve seconds.
 *
 * Remaining time rounds UP: a card showing "1s" for the last whole second and
 * then "any moment now" reads correctly, whereas rounding down shows "0s" for a
 * second before the deadline is actually reached - the small lie this whole
 * formatter is shaped to avoid.
 */
export function formatGraceCountdown(deadline: number, now: number): string {
  const remainingMs = deadline - now;
  if (remainingMs <= 0) return GRACE_COUNTDOWN_IMMINENT;
  const seconds = Math.ceil(remainingMs / SECOND_MS);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0
    ? `${minutes}m ${remainingSeconds}s`
    : `${minutes}m`;
}

/**
 * {@link formatGraceCountdown} bound to the shared 1s clock, or `null` when
 * there is no deadline to count down to.
 *
 * `null` is a real state rather than a missing one and the caller must render
 * for it: the pending-fallback DTO's `deadline` is null for an effect phase
 * that is due now, for a `choosing` window a menu has frozen, and for a state
 * with no timer at all. In none of those is there a time to show.
 *
 * Call it from a small LEAF component, the same guidance the minute-clock hooks
 * carry and more sharply: this one wakes its subscriber once a second, so a
 * component holding the whole card would repaint every button and helper line
 * with it.
 */
export function useGraceCountdown(deadline: number | null): string | null {
  useSyncExternalStore(
    secondClock.subscribe,
    secondClock.getSnapshot,
    secondClock.getSnapshot,
  );
  if (deadline === null) return null;
  return formatGraceCountdown(deadline, secondClock.sampledNow());
}
