/**
 * Docs: see ../SETTINGS.md (Host ▸ Overview ▸ Status).
 * Update that file whenever this settings surface changes.
 */
import { describeLastSeenUpdateClause } from "@/components/home/host-update-operation-copy";
import type { HostOverviewAnswerKind } from "@/components/settings/panels/host-overview-updates-state";
import type {
  FleetUpdateView,
  FleetUpdateViewKind,
} from "@/lib/host/fleet-update/fleet-update-view";

/**
 * The Status tab's decisions that are not about rendering: which tag the
 * version card wears, whether an update is in flight, and what the offline
 * notice says.
 */

export type HostOverviewVersionTag =
  | "latest"
  | "available"
  | "checking"
  | "updating"
  | "waiting-on-work"
  | "restart-to-finish"
  | "needs-cli"
  | "last-reported";

export type HostOverviewVersionTagTone =
  | "success"
  | "info"
  | "warning"
  | "muted";

export const HOST_OVERVIEW_VERSION_TAG: Record<
  HostOverviewVersionTag,
  { readonly label: string; readonly tone: HostOverviewVersionTagTone }
> = {
  latest: { label: "Latest", tone: "success" },
  available: { label: "Update available", tone: "info" },
  checking: { label: "Checking…", tone: "muted" },
  updating: { label: "Updating…", tone: "info" },
  "waiting-on-work": { label: "Waiting on work", tone: "warning" },
  "restart-to-finish": { label: "Restart to finish", tone: "warning" },
  "needs-cli": { label: "Needs newer CLI tools", tone: "warning" },
  "last-reported": { label: "Last reported", tone: "muted" },
};

/**
 * The tag an update in flight puts on the version card, keyed by the view's
 * kind. Non-null is exactly "in flight": running, waiting or restarting. A
 * finished or failed update, and every state that is not an update at all,
 * is `null`, and the card's buttons come back.
 */
const IN_FLIGHT_TAG: Record<
  FleetUpdateViewKind,
  HostOverviewVersionTag | null
> = {
  updating: "updating",
  downloading: "updating",
  preparing: "updating",
  applying: "updating",
  restarting: "updating",
  reconnecting: "updating",
  verifying: "updating",
  "waiting-for-work": "waiting-on-work",
  "waiting-to-activate": "restart-to-finish",
  complete: null,
  failed: null,
  "finalizing-record": null,
  "verification-refused": null,
  unavailable: null,
  idle: null,
  unknown: null,
};

/** The tag the update ANSWER puts on the card when nothing is in flight. */
const ANSWER_TAG: Record<
  HostOverviewAnswerKind,
  HostOverviewVersionTag | null
> = {
  latest: "latest",
  available: "available",
  // A newer version exists on another release line, and Updates offers it.
  stranded: "available",
  // The version exists, but this host cannot install it: an "Update
  // available" tag would promise an update the card has no button for.
  "not-installable": null,
  checking: "checking",
  // The host did not answer. The card does not know which tag is true.
  unreachable: null,
  // The host answered with a failure and no catalog: no tag is true either.
  "check-failed": null,
  "restart-to-finish": "restart-to-finish",
  "needs-cli": "needs-cli",
};

/**
 * The update kind the page is describing: the view's own kind, or the phase
 * it retained when the page can no longer vouch for it (`unknown`).
 */
function describedKind(view: FleetUpdateView): FleetUpdateViewKind | null {
  return view.kind === "unknown" ? view.lastKnownKind : view.kind;
}

/**
 * The kind of the update in flight, or `null` when none is.
 *
 * Reads the retained phase too. A host whose read has aged mid-download is
 * still, as far as this page knows, downloading, and offering Update now
 * beside "Last seen: Downloading update to v1.5.1" would be a button for an
 * update that may already be running.
 */
export function inFlightUpdateKind(
  view: FleetUpdateView | null,
): FleetUpdateViewKind | null {
  if (view === null) return null;
  const kind = describedKind(view);
  if (kind === null) return null;
  return IN_FLIGHT_TAG[kind] === null ? null : kind;
}

/**
 * The version card's tag, or `null` for none.
 *
 * In order: an unreachable host's version is only "Last reported"; a host
 * whose updates are not managed here wears no tag, because every tag is a
 * claim about updates; an update in flight says what it is doing, unless the
 * page can no longer vouch for the phase, when it says nothing; otherwise the
 * answer decides.
 */
export function deriveHostOverviewVersionTag(input: {
  /** The host can't be reached, for a reason other than a restart. */
  readonly offline: boolean;
  /** Updates are not manageable here: the card shows one sentence instead. */
  readonly unmanaged: boolean;
  readonly view: FleetUpdateView | null;
  readonly cliFloorBlocked: boolean;
  /** The update answer's kind, or `null` when there is no answer to read. */
  readonly answerKind: HostOverviewAnswerKind | null;
}): HostOverviewVersionTag | null {
  if (input.offline) return "last-reported";
  if (input.unmanaged) return null;
  const inFlight = inFlightUpdateKind(input.view);
  if (inFlight !== null) {
    // The same floor that turns the park's sentence into "Update waits for
    // Traycer's command-line tools" and the pill into "Update waiting on CLI
    // tools".
    if (inFlight === "waiting-for-work" && input.cliFloorBlocked) {
      return "needs-cli";
    }
    // A phase the page can no longer vouch for (retained on an `unknown`
    // view, or `qualified`) still hides the buttons, but it is not a
    // present-tense claim: the pill reads "Last seen: …" and the operation
    // card goes neutral, so the card wears no tag. The floor above stays,
    // because it is a live fact about the catalog, not about the phase.
    if (
      input.view !== null &&
      (input.view.kind === "unknown" || input.view.qualified)
    ) {
      return null;
    }
    return IN_FLIGHT_TAG[inFlight];
  }
  return input.answerKind === null ? null : ANSWER_TAG[input.answerKind];
}

/**
 * The offline notice: one sentence carrying what the page last knew.
 *
 * "Can't reach build-box — last seen 3h ago, while downloading update to
 * v1.5.1. Auto-update settings still apply at its next check-in; everything
 * else here needs a connection."
 *
 * The phase clause drops when no update was in flight. The last-seen half
 * drops when the account holds no check-in time. The auto-update half drops
 * when the account does not know this host, because then there is no setting
 * to still apply.
 */
export function describeHostOfflineNotice(input: {
  readonly hostName: string;
  /** "last seen 3h ago", or `null` when the account holds no check-in. */
  readonly lastSeen: string | null;
  readonly view: FleetUpdateView | null;
  readonly accountKnowsHost: boolean;
}): string {
  const clause =
    input.view === null ? null : describeLastSeenUpdateClause(input.view);
  const tail = input.accountKnowsHost
    ? "Auto-update settings still apply at its next check-in; everything else here needs a connection."
    : "Everything here needs a connection.";
  return `Can't reach ${input.hostName}${lastKnown(input.lastSeen, clause)}. ${tail}`;
}

function lastKnown(lastSeen: string | null, clause: string | null): string {
  if (lastSeen !== null && clause !== null) return ` — ${lastSeen}, ${clause}`;
  if (lastSeen !== null) return ` — ${lastSeen}`;
  if (clause !== null) return ` — last seen ${clause}`;
  return "";
}
