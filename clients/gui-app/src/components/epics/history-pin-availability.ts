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
 *
 * ## "the connected device", never "this device"
 *
 * A local-homed epic lives on the HOST that serves it, and after the mobile /
 * relay work that host is routinely not the machine rendering these strings -
 * a phone reads its Mac's local epics. "Stored on this device" was written
 * when the two were always the same and became false without anyone editing
 * it: a string is a claim about a state space, and a new member invalidates
 * strings nobody touched.
 *
 * "Device" stays the UI word for a host (host identity rule 1: no parallel
 * `deviceId`), so the fix is the ARTICLE, not the vocabulary. The same
 * correction applies to the preserved-orphan pair below, whose "this device's
 * edits" makes the identical claim about the identical machine.
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
 * `cloudAuthorized` is `authorizesCloudCapability(status)` and
 * `localHomePinSupported` is `useEpicPinLocalHomeSupported()` - both required
 * arguments rather than store/registry reads, so this stays a pure function
 * every surface can call and test, and so neither the SESSION half nor the
 * NEGOTIATION half of the rule can be silently omitted by a new caller.
 *
 * `localHomePinSupported` is what makes `local-home` a statement about the
 * HOST rather than about the row. The released `epic.setPinned@1.0` line has
 * only a cloud arm, so pinning an epic that exists only on disk 404s; `@1.1`
 * carries the local arm and the refusal becomes false. It is deliberately not
 * derived from anything else on the wire - see `lib/epic-pin-admission.ts`,
 * which owns the version predicate and the fail-closed rule for a host that
 * has not handshaken.
 *
 * `local-home` is therefore no longer PERMANENT: a row that reads unavailable
 * against an old host becomes pinnable when that host updates, with no change
 * to the row. The ordering below is unchanged and still correct - a
 * local-homed row on a `@1.1` host now falls through to the session check,
 * which is right, because the pin still leaves this client as a cloud-backed
 * personal preference until someone establishes otherwise.
 *
 * The row-intrinsic reasons are checked first on purpose: `phase` and
 * `preserved-orphan` are permanent facts about the row, while a withdrawn
 * verdict is a condition the user can recover from, and reporting the
 * recoverable one for a row that could never be pinned anyway would send them
 * to fix the wrong thing.
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
  localHomePinSupported: boolean,
): HistoryPinUnavailableReason | null {
  if (item.taskType === "phase") return "phase";
  if (item.isPreservedOrphan === true) return "preserved-orphan";
  if (item.isLocalHome === true && !localHomePinSupported) return "local-home";
  if (!cloudAuthorized) return "unverified-session";
  return null;
}

export function historyPinControlLabel(input: {
  readonly displayTitle: string;
  readonly unavailableReason: HistoryPinUnavailableReason | null;
  readonly isPinned: boolean;
}): string {
  if (input.unavailableReason === "preserved-orphan") {
    return `Pinning ${input.displayTitle} is unavailable; its cloud copy was deleted and only the connected device's edits remain`;
  }
  if (input.unavailableReason === "local-home") {
    return `Pinning ${input.displayTitle} needs cloud sync; it is stored on the connected device`;
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
    return "This epic's cloud copy was deleted. Only the connected device's edits remain, so it can't be pinned.";
  }
  if (reason === "local-home") {
    return "This epic is stored on the connected device. Pinning needs cloud sync.";
  }
  if (reason === "unverified-session") {
    return "Your sign-in couldn't be confirmed, so cloud changes are paused. Pinning will work again once your sign-in is confirmed.";
  }
  return "Phases cannot be pinned.";
}
