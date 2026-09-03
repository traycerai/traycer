import type { HistoryItem } from "@/components/home/data/home-page.data";

/**
 * Pin availability for a history row, kept OUT of `epics-list-shared.tsx`.
 *
 * These are pure functions, and a module that exports both components and
 * plain values loses Fast Refresh for every component in it
 * (`react-refresh/only-export-components`) - the desktop panel and both mobile
 * surfaces import from here, so that file is one of the most-edited in the
 * package and the one where losing HMR costs the most.
 *
 * The split is also the honest boundary: the rule below is what every
 * responsive surface must agree on, and it has no rendering in it.
 */

/** The reason a history row cannot dispatch the cloud-only pin mutation. */
export type HistoryPinUnavailableReason =
  | "phase"
  | "local-home"
  | "preserved-orphan"
  | "unverified-session";

/**
 * The pin mutation targets a cloud task. Keep its admission rule independent
 * of the desktop/mobile row implementations so each responsive surface, plus
 * other task affordances, makes the same decision.
 *
 * `cloudAuthorized` is `authorizesCloudCapability(status)` - a required
 * argument rather than a store read, so this stays a pure function every
 * surface can call and test, and so the SESSION half of the rule cannot be
 * silently omitted by a new caller.
 *
 * The row-intrinsic reasons are checked first on purpose: they are permanent
 * facts about the row, while a withdrawn verdict is a condition the user can
 * recover from, and reporting the recoverable one for a row that could never
 * be pinned anyway would send them to fix the wrong thing.
 *
 * Why the session belongs in this rule at all: History stays readable under
 * `unverified` by design - `resolveCloudTasksUserId` admits it and the first
 * page's cache is infinite-lived - so settled cloud rows keep rendering after
 * the verdict is withdrawn. Pin is not a read. It is a cloud-capability spend
 * on the account, dispatched with a bearer the cloud has stopped vouching for.
 */
export function historyPinUnavailableReason(
  item: HistoryItem,
  cloudAuthorized: boolean,
): HistoryPinUnavailableReason | null {
  if (item.taskType === "phase") return "phase";
  if (item.isPreservedOrphan === true) return "preserved-orphan";
  if (item.isLocalHome === true) return "local-home";
  if (!cloudAuthorized) return "unverified-session";
  return null;
}

export function historyPinControlLabel(input: {
  readonly displayTitle: string;
  readonly unavailableReason: HistoryPinUnavailableReason | null;
  readonly isPinned: boolean;
}): string {
  if (input.unavailableReason === "preserved-orphan") {
    return `Pinning ${input.displayTitle} is unavailable; its cloud copy was deleted and only this device's edits remain`;
  }
  if (input.unavailableReason === "local-home") {
    return `Pinning ${input.displayTitle} needs cloud sync; it is stored on this device`;
  }
  if (input.unavailableReason === "phase") {
    return `Pinning ${input.displayTitle} is unavailable for phases`;
  }
  if (input.unavailableReason === "unverified-session") {
    return `Pinning ${input.displayTitle} needs a verified session; sign-in could not be confirmed`;
  }
  return input.isPinned
    ? `Unpin ${input.displayTitle} from top`
    : `Pin ${input.displayTitle} to top`;
}

export function historyPinUnavailableTooltip(
  reason: HistoryPinUnavailableReason,
): string {
  if (reason === "preserved-orphan") {
    return "This epic's cloud copy was deleted. Only this device's edits remain, so it can't be pinned.";
  }
  if (reason === "local-home") {
    return "This epic is stored on this device. Pinning needs cloud sync.";
  }
  if (reason === "unverified-session") {
    return "Your sign-in couldn't be confirmed, so cloud changes are paused. Pinning will work again once your sign-in is confirmed.";
  }
  return "Phases cannot be pinned.";
}
