/**
 * Docs: see ../SETTINGS.md (Host ▸ Overview ▸ Updates ▸ Answer card, and The
 * notices strip).
 * Update that file whenever this settings surface changes.
 */
import { describeLastSeenUpdateClause } from "@/components/home/host-update-operation-copy";
import type {
  FleetUpdateView,
  FleetUpdateViewKind,
} from "@/lib/host/fleet-update/fleet-update-view";

/**
 * The Updates tab's and the notices strip's decisions that are not about
 * rendering: whether an update is in flight, and what the offline notice
 * says.
 */

/**
 * Whether each view kind is an update in flight: running, waiting or
 * restarting. A finished or failed update, and every state that is not an
 * update at all, is not, and the answer card and Check now come back.
 */
const IN_FLIGHT: Record<FleetUpdateViewKind, boolean> = {
  updating: true,
  downloading: true,
  preparing: true,
  applying: true,
  restarting: true,
  reconnecting: true,
  verifying: true,
  "waiting-for-work": true,
  "waiting-to-activate": true,
  complete: false,
  failed: false,
  "finalizing-record": false,
  "verification-refused": false,
  unavailable: false,
  idle: false,
  unknown: false,
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
  return IN_FLIGHT[kind] ? kind : null;
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
