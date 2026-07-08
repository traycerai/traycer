import { useSyncExternalStore } from "react";

const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Shared 60s clock. A single setInterval drives every component that renders
// a relative timestamp, so a popover with 20 rows pays one timer - not 20.
// `tick` increments on each fire; `useSyncExternalStore` wakes only the
// components that subscribed to this clock, so sibling rows that don't read
// it are not re-rendered.
let tick = 0;
let intervalHandle: number | null = null;
// Sampled at module load so the first render of a consumer has a valid value
// before `useSyncExternalStore`'s subscribe effect runs. Re-sampled on every
// interval fire and whenever the shared clock is (re)started.
let sampledNow = Date.now();
const listeners = new Set<() => void>();

function startIfNeeded(): void {
  if (intervalHandle !== null) return;
  sampledNow = Date.now();
  intervalHandle = window.setInterval(() => {
    tick += 1;
    sampledNow = Date.now();
    for (const listener of listeners) {
      listener();
    }
  }, MINUTE_MS);
}

function stopIfIdle(): void {
  if (listeners.size > 0) return;
  if (intervalHandle === null) return;
  window.clearInterval(intervalHandle);
  intervalHandle = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  startIfNeeded();
  return () => {
    listeners.delete(listener);
    stopIfIdle();
  };
}

function getSnapshot(): number {
  return tick;
}

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
 * Subscribes the calling component to the shared 60s tick clock and returns
 * the current bucketed label for `createdAt`. Intended to be called from a
 * small leaf component (e.g. `<NotificationTimestamp />`) so the surrounding
 * list row does not re-render when the clock ticks.
 */
export function useRelativeTimestamp(createdAt: number): string {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return formatRelativeTimestamp(createdAt, sampledNow);
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
  return formatResetCountdown(resetsAt, sampledNow);
}

/**
 * Whether a reset is far enough away that an absolute weekday/time reads
 * better than a relative countdown ("Resets in 3d" is too coarse to act on).
 * Based on the real time remaining rather than a window's nominal duration:
 * some windows (e.g. Claude's per-model `modelScoped` buckets) carry no
 * `durationMinutes` at all, so gating this decision on duration meant those
 * windows always fell back to the relative countdown even when their real
 * reset was days away (regression: Claude's "Fable" per-model window showed
 * "Resets in 3d" instead of "Resets Tue 5:29 PM"). Every window always has a
 * real `resetsAt`, so every caller now derives this the same way instead of
 * each threading through its own duration-based flag (or, worse, hardcoding
 * one).
 */
export function isFarReset(resetsAt: number, now: number): boolean {
  return resetsAt - now >= DAY_MS;
}

/**
 * Subscribes to the shared 60s tick clock and returns whether `resetsAt` is
 * currently far enough away to warrant `formatResetDateTime` over
 * `formatResetCountdown` - `false` for a `null` resetsAt (nothing to compare).
 * Reactive (unlike `formatResetDateTime` itself) so a window that crosses the
 * one-day threshold while the popover is open flips from absolute to relative
 * display without a remount.
 */
export function useIsFarReset(resetsAt: number | null): boolean {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (resetsAt === null) return false;
  return isFarReset(resetsAt, sampledNow);
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
