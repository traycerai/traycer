import { useSyncExternalStore } from "react";

const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
// Where the compact ladder stops counting weeks and shows a date instead.
const COMPACT_WEEKS_CUTOFF_MS = 4 * WEEK_MS;

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
  // Publish the restart sample through `tick`, not just into `sampledNow`.
  // `getSnapshot` returns `tick`, so a resample that leaves it alone is
  // invisible to `useSyncExternalStore`'s post-subscribe comparison: the
  // first render after a cold start keeps whatever the last consumer left
  // behind, with nothing able to correct it until the next interval fire.
  // That is harmless for a relative label ("2m ago" is stale by a minute) and
  // wrong for an absolute one - reopen a transcript at 00:01 after the app
  // sat idle and every stamp from yesterday still claims to be today.
  sampledNow = Date.now();
  tick += 1;
  // The component that woke the clock has ALREADY rendered against the old
  // `sampledNow`, which is as stale as the idle period (hours, in a
  // long-open app), and the interval would not repaint it for a full minute:
  // a countdown to a check 30s away read as hours away until the first tick.
  // Notify every current subscriber so the fresh sample paints now - a
  // one-time cost paid only when the clock comes back from idle.
  for (const listener of listeners) {
    listener();
  }
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
  return formatCompactRelativeTime(timestamp, sampledNow);
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

export function useSampledNow(): number {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return sampledNow;
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
 * How much of the clock a message stamp spells out. The transcript row shows
 * minutes; the assistant footer's hover card shows seconds, where it sits
 * beside a duration that is itself second-precise.
 */
type MessageTimePrecision = "minute" | "second";

/**
 * Whether two epoch-ms instants fall on the same day in the VIEWER's timezone.
 *
 * Compared part by part rather than through a formatted string: the calendar
 * parts are what the decision is about, and going through a formatter would
 * tie "is this today" to a display format that is free to change.
 */
function isSameLocalDay(a: number, b: number): boolean {
  const dateA = new Date(a);
  const dateB = new Date(b);
  return (
    dateA.getFullYear() === dateB.getFullYear() &&
    dateA.getMonth() === dateB.getMonth() &&
    dateA.getDate() === dateB.getDate()
  );
}

function formatDayScopedTime(
  timestamp: number,
  now: number,
  precision: MessageTimePrecision,
): string {
  // No `hour12` here, unlike `formatResetDateTime`. A transcript stamp reads
  // down a column of times the viewer scans, so it should be written the way
  // their own locale writes a clock - "15:45" where that is the convention.
  const time = new Date(timestamp).toLocaleTimeString(
    undefined,
    precision === "second"
      ? { hour: "numeric", minute: "2-digit", second: "2-digit" }
      : { hour: "numeric", minute: "2-digit" },
  );
  if (isSameLocalDay(timestamp, now)) return time;
  return `${formatShortDate(timestamp)}, ${time}`;
}

/**
 * A transcript row's own clock time, scoped to the day it happened on: the
 * time alone when that day is today ("3:45 PM"), a short date ahead of it
 * otherwise ("Sep 8, 3:45 PM").
 *
 * Absolute rather than relative on purpose. A chat is read as a timeline, and
 * "2m ago" both churns every minute and makes two adjacent messages read
 * identically; a clock time never goes stale and can be compared between rows.
 * The date is dropped for today because that is the common case and the
 * prefix would be noise on every row of a session held in one sitting - but it
 * is never dropped otherwise, since these chats routinely span days.
 *
 * Pure, taking `now` as an argument. {@link useMessageTime} is the reactive
 * form for a component that must survive a day rollover.
 */
export function formatMessageTime(timestamp: number, now: number): string {
  return formatDayScopedTime(timestamp, now, "minute");
}

/**
 * {@link formatMessageTime} with seconds, for the roomy detail surfaces (the
 * assistant footer's hover card) where the extra precision is readable and
 * the neighbouring duration is already stated to the second.
 */
export function formatMessageTimeWithSeconds(
  timestamp: number,
  now: number,
): string {
  return formatDayScopedTime(timestamp, now, "second");
}

/**
 * Whether `timestamp` names an instant a message stamp can render at all.
 *
 * A persisted row can carry a number no `Date` represents - `8.64e15 + 1` is
 * perfectly finite and still out of range - and `toISOString()` THROWS on one
 * rather than producing "Invalid Date", so the stamp renders nothing for it.
 * That decision has to be readable from outside the component: a call site
 * drawing its own separator beside the stamp cannot see a `null` return, and
 * would otherwise leave a lone " · " after the sender label. Exported so the
 * separator and the stamp are decided by one predicate instead of two that
 * can drift.
 */
export function hasRenderableMessageTime(timestamp: number): boolean {
  return !Number.isNaN(new Date(timestamp).getTime());
}

/**
 * The unabridged form of a message stamp - weekday, full date, year and time
 * to the second - for the hover label behind {@link formatMessageTime}'s
 * day-scoped one.
 *
 * This is what makes an absolute stamp safe to abbreviate on the row: the
 * visible label drops the date for today and the year always, and the reader
 * gets both back on demand rather than losing them. Pure and complete, so it
 * needs no `now` and never goes stale.
 */
export function formatFullTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * {@link formatMessageTime} bound to the shared 60s clock.
 *
 * The subscription is there for one transition only: a stamp showing "3:45 PM"
 * has to become "Sep 10, 3:45 PM" once the day rolls over under a tab left
 * open overnight. Reading the clock at render time instead would freeze the
 * label at whatever the last render happened to observe, which is not coarse
 * but wrong.
 *
 * Same leaf-component guidance as {@link useRelativeTimestamp}: call it from a
 * small leaf (`<ChatMessageTimestamp />`) so the tick repaints that one element
 * rather than the transcript row around it.
 */
export function useMessageTime(timestamp: number): string {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return formatMessageTime(timestamp, sampledNow);
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
