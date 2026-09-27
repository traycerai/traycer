/**
 * The Home status board's per-device display thresholds: when an
 * `in-progress` or `needs-you` row reads as stale, and when a `done` row
 * leaves the table.
 *
 * Presentation only. Nothing here reaches the room: hosts prune on their own
 * fixed rule, the 7-day row TTL for every status
 * (`@traycer/protocol/notifications/home-status-room`), and
 * `traycer_home_list_rows` keeps reporting `stale` against the protocol's
 * default.
 */
import {
  HOME_STATUS_ROW_TTL_MS,
  HOME_STATUS_STALE_MS,
  type HomeStatusRow,
} from "@traycer/protocol/notifications/home-status-room";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export interface HomeStatusThresholdOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  /** `null` means never. */
  readonly ms: number | null;
}

export type HomeStatusInProgressStaleAfter =
  | "30m"
  | "1h"
  | "2h"
  | "4h"
  | "8h"
  | "never";

export const HOME_STATUS_IN_PROGRESS_STALE_OPTIONS: ReadonlyArray<
  HomeStatusThresholdOption<HomeStatusInProgressStaleAfter>
> = [
  { value: "30m", label: "30 min", ms: 30 * MINUTE_MS },
  { value: "1h", label: "1 h", ms: HOUR_MS },
  { value: "2h", label: "2 h", ms: HOME_STATUS_STALE_MS },
  { value: "4h", label: "4 h", ms: 4 * HOUR_MS },
  { value: "8h", label: "8 h", ms: 8 * HOUR_MS },
  { value: "never", label: "Never", ms: null },
];

/** The protocol's own threshold, so the default matches what agents are told. */
export const DEFAULT_HOME_STATUS_IN_PROGRESS_STALE_AFTER: HomeStatusInProgressStaleAfter =
  "2h";

export type HomeStatusNeedsYouStaleAfter = "1h" | "4h" | "8h" | "24h" | "never";

export const HOME_STATUS_NEEDS_YOU_STALE_OPTIONS: ReadonlyArray<
  HomeStatusThresholdOption<HomeStatusNeedsYouStaleAfter>
> = [
  { value: "1h", label: "1 h", ms: HOUR_MS },
  { value: "4h", label: "4 h", ms: 4 * HOUR_MS },
  { value: "8h", label: "8 h", ms: 8 * HOUR_MS },
  { value: "24h", label: "24 h", ms: 24 * HOUR_MS },
  { value: "never", label: "Never", ms: null },
];

/** A row waiting on the user does not stop mattering by default. */
export const DEFAULT_HOME_STATUS_NEEDS_YOU_STALE_AFTER: HomeStatusNeedsYouStaleAfter =
  "never";

export type HomeStatusDoneHideAfter = "1h" | "4h" | "12h" | "24h" | "never";

// Hosts keep a `done` row as long as any other, HOME_STATUS_ROW_TTL_MS
// (7 days), so every choice here, Never included, is honoured up to that
// age; past it the row is gone from the room and `isHomeStatusRowHiddenFor`
// hides it anyway.
export const HOME_STATUS_DONE_HIDE_OPTIONS: ReadonlyArray<
  HomeStatusThresholdOption<HomeStatusDoneHideAfter>
> = [
  { value: "1h", label: "1 h", ms: HOUR_MS },
  { value: "4h", label: "4 h", ms: 4 * HOUR_MS },
  { value: "12h", label: "12 h", ms: 12 * HOUR_MS },
  { value: "24h", label: "24 h", ms: DAY_MS },
  { value: "never", label: "Never", ms: null },
];

export const DEFAULT_HOME_STATUS_DONE_HIDE_AFTER: HomeStatusDoneHideAfter =
  "24h";

function optionFor<Value extends string>(
  options: ReadonlyArray<HomeStatusThresholdOption<Value>>,
  value: unknown,
): HomeStatusThresholdOption<Value> | undefined {
  return options.find((option) => option.value === value);
}

export function isHomeStatusInProgressStaleAfter(
  value: unknown,
): value is HomeStatusInProgressStaleAfter {
  return optionFor(HOME_STATUS_IN_PROGRESS_STALE_OPTIONS, value) !== undefined;
}

export function isHomeStatusNeedsYouStaleAfter(
  value: unknown,
): value is HomeStatusNeedsYouStaleAfter {
  return optionFor(HOME_STATUS_NEEDS_YOU_STALE_OPTIONS, value) !== undefined;
}

export function isHomeStatusDoneHideAfter(
  value: unknown,
): value is HomeStatusDoneHideAfter {
  return optionFor(HOME_STATUS_DONE_HIDE_OPTIONS, value) !== undefined;
}

/** The three choices resolved to milliseconds; `null` means never. */
export interface HomeStatusThresholds {
  readonly inProgressStaleAfterMs: number | null;
  readonly needsYouStaleAfterMs: number | null;
  readonly doneHideAfterMs: number | null;
}

export function resolveHomeStatusThresholds(
  inProgressStaleAfter: HomeStatusInProgressStaleAfter,
  needsYouStaleAfter: HomeStatusNeedsYouStaleAfter,
  doneHideAfter: HomeStatusDoneHideAfter,
): HomeStatusThresholds {
  // `msOf`, not `?.ms ?? fallback`: an option's `null` means Never and must
  // survive; only an option that is not in the list falls back.
  return {
    inProgressStaleAfterMs: msOf(
      HOME_STATUS_IN_PROGRESS_STALE_OPTIONS,
      inProgressStaleAfter,
      HOME_STATUS_STALE_MS,
    ),
    needsYouStaleAfterMs: msOf(
      HOME_STATUS_NEEDS_YOU_STALE_OPTIONS,
      needsYouStaleAfter,
      null,
    ),
    doneHideAfterMs: msOf(HOME_STATUS_DONE_HIDE_OPTIONS, doneHideAfter, DAY_MS),
  };
}

function msOf<Value extends string>(
  options: ReadonlyArray<HomeStatusThresholdOption<Value>>,
  value: Value,
  fallback: number | null,
): number | null {
  const option = optionFor(options, value);
  return option === undefined ? fallback : option.ms;
}

/** The thresholds every default resolves to. */
export const DEFAULT_HOME_STATUS_THRESHOLDS: HomeStatusThresholds =
  resolveHomeStatusThresholds(
    DEFAULT_HOME_STATUS_IN_PROGRESS_STALE_AFTER,
    DEFAULT_HOME_STATUS_NEEDS_YOU_STALE_AFTER,
    DEFAULT_HOME_STATUS_DONE_HIDE_AFTER,
  );

/** A `done` row is never stale; it leaves the table instead. */
export function isHomeStatusRowStaleFor(
  row: HomeStatusRow,
  now: number,
  thresholds: HomeStatusThresholds,
): boolean {
  const staleAfterMs = staleAfterMsFor(row.status, thresholds);
  return staleAfterMs !== null && now - row.updatedAt > staleAfterMs;
}

function staleAfterMsFor(
  status: HomeStatusRow["status"],
  thresholds: HomeStatusThresholds,
): number | null {
  switch (status) {
    case "in-progress":
      return thresholds.inProgressStaleAfterMs;
    case "needs-you":
      return thresholds.needsYouStaleAfterMs;
    case "done":
      return null;
  }
}

/** Whether the table leaves a row out: a `done` row past its hide time, or any
 * row past the protocol's 7-day TTL. */
export function isHomeStatusRowHiddenFor(
  row: HomeStatusRow,
  now: number,
  thresholds: HomeStatusThresholds,
): boolean {
  const age = now - row.updatedAt;
  if (age > HOME_STATUS_ROW_TTL_MS) return true;
  return (
    row.status === "done" &&
    thresholds.doneHideAfterMs !== null &&
    age > thresholds.doneHideAfterMs
  );
}
