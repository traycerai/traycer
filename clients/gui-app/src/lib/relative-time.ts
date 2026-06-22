import { useSyncExternalStore } from "react";

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
