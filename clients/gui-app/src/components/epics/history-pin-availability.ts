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
 * ## The copy never says where a task lives
 *
 * The reason codes below distinguish a local-homed row from a cloud-backed
 * one because the REMEDIES differ (a host update versus a sign-in), but the
 * strings name only the remedy. Whether a task's copy is in the cloud or on
 * the host serving it is not something the person reading the list knows or
 * cares about - they know their tasks - so no string here, and none in the
 * list bodies, narrates cloud-versus-device. A row that needs a newer host
 * says so; a row that was deleted says so; which side of the sync each fact
 * came from stays out of the sentence.
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
 * to the row.
 *
 * It also does not require a cloud verdict. A local-homed pin on a `@1.1`
 * host is served entirely from that host's disk (`epic-set-pinned-resolver`
 * admits on the local `epicHomeVerdict` and returns before any cloud header is
 * built), so the row returns from its own branch and never reaches the session
 * check. `useEpicSetPinned` carries the same carve-out at DISPATCH, and the
 * two must move together: a control this function enables and that mutation
 * refuses is a button that does nothing.
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
  // A local-homed row RETURNS from here either way and never reaches the
  // session check below. That is the carve-out, not an ordering accident: on
  // `@1.1` the host's pin resolver admits this epic on its local
  // `epicHomeVerdict` and returns before building any cloud header, so the
  // write spends no cloud capability and a withdrawn verdict is not a reason
  // to refuse it. Requiring one would deny an offline or free-tier user a
  // write their own machine can serve - which is the whole population this
  // lane exists for.
  if (item.isLocalHome === true) {
    return localHomePinSupported ? null : "local-home";
  }
  if (!cloudAuthorized) return "unverified-session";
  return null;
}

export function historyPinControlLabel(input: {
  readonly displayTitle: string;
  readonly unavailableReason: HistoryPinUnavailableReason | null;
  readonly isPinned: boolean;
}): string {
  if (input.unavailableReason === "preserved-orphan") {
    return `Pinning ${input.displayTitle} is unavailable; the task was deleted and only its unsynced edits remain`;
  }
  // The remedy is a HOST UPDATE, not sign-in or sync: `local-home` means the
  // serving host has not negotiated `epic.setPinned@1.1` (see
  // `historyPinUnavailableReason`), and copy that sent the user to the cloud
  // named a fix that changes nothing.
  if (input.unavailableReason === "local-home") {
    return `Pinning ${input.displayTitle} needs a newer Traycer host`;
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
    return "This task was deleted. Its unsynced edits are kept, but it can't be pinned.";
  }
  if (reason === "local-home") {
    return "Pinning this task needs a newer Traycer host version. Update the host that serves it.";
  }
  if (reason === "unverified-session") {
    return "Your sign-in couldn't be confirmed. Pinning will work again once it is.";
  }
  return "Phases cannot be pinned.";
}
