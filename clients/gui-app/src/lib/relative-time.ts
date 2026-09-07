import { useSyncExternalStore } from "react";

const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
// Where the compact ladder stops counting weeks and shows a date instead.
const COMPACT_WEEKS_CUTOFF_MS = 4 * WEEK_MS;

// Shared 60s clock.
// A single setInterval drives every component that renders a relative timestamp, so a popover with 20 rows pays one timer - not 20.
let tick = 0;
let intervalHandle: number | null = null;
// Sampled at module load so the first render of a consumer has a valid value before `useSyncExternalStore`'s subscribe effect runs.
// Re-sampled on every interval fire and whenever the shared clock is (re)started.
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

/** Pure bucketed relative-time formatter. */
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
 * The COMPACT ladder, for dense surfaces that show a timestamp beside other values rather than as a sentence: `now` / `10m` / `4h` / `1d` / `1w`, then a short date.
 * No "ago" - the suffix costs width on every row to say what the surface's context already says.
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
 * `formatCompactRelativeTime` bound to the shared 60s clock.
 * Same leaf-component guidance as {@link useRelativeTimestamp}: call it from a small leaf so the tick repaints the label rather than its surrounding row.
 */
export function useCompactRelativeTime(timestamp: number): string {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return formatCompactRelativeTime(timestamp, sampledNow);
}

/**
 * Subscribes the calling component to the shared 60s tick clock and returns the current bucketed label for `createdAt`.
 * Intended to be called from a small leaf component (e.g.
 */
export function useRelativeTimestamp(createdAt: number): string {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return formatRelativeTimestamp(createdAt, sampledNow);
}

export function useSampledNow(): number {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return sampledNow;
}

/**
 * Pure future-facing countdown formatter, the mirror of `formatRelativeTimestamp` for a reset time instead of a creation time.
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
 * Subscribes to the shared 60s tick clock and returns the current countdown label for `resetsAt` (epoch-ms), or `null` when there is nothing to count down to.
 * Shares the same clock `useRelativeTimestamp` uses, so a popover showing several rate-limit windows alongside relative message timestamps still pays for only one interval.
 */
export function useResetCountdown(resetsAt: number | null): string | null {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (resetsAt === null) return null;
  return formatResetCountdown(resetsAt, sampledNow);
}

/**
 * Whether a reset is far enough away that an absolute calendar date/time reads better than a relative countdown ("Resets in 3d" is too coarse to act on).
 * Based on the real time remaining rather than a window's nominal duration: some windows (e.g.
 */
export function isFarReset(resetsAt: number, now: number): boolean {
  return resetsAt - now >= DAY_MS;
}

/**
 * Subscribes to the shared 60s tick clock and returns whether `resetsAt` is currently far enough away to warrant an absolute calendar date/time over `formatResetCountdown` - `false` for a `null` resetsAt (nothing to compare).
 */
export function useIsFarReset(resetsAt: number | null): boolean {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (resetsAt === null) return false;
  return isFarReset(resetsAt, sampledNow);
}

/**
 * Exact reset time as weekday + time (e.g.
 * "Sat 3:35 AM"), for windows where a relative countdown ("Resets in 3d") is too coarse to act on.
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
 * A PAST instant as an absolute date and time (e.g.
 * "Aug 14, 3:42 PM"), for prose that states when something happened.
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
 * Full calendar form for roomy surfaces such as Settings, where the explicit date is more useful than the popover's compact weekday-only label.
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
