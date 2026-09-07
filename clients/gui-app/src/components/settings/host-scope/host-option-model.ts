import type { HostHealthState } from "@/components/settings/host-scope/host-health";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import type {
  FleetUpdateView,
  FleetUpdateViewKind,
} from "@/lib/host/fleet-update/fleet-update-view";

/** A host this client cannot dial is not a legal answer there, so its row is inert rather than a click that
 * could only fail. */
export type HostPickIntent = "view" | "bind" | "pin";

/** This is the other kind: a reason this picker cannot use this host, which no other picker would state. */
export const NO_HOST_OPTION_REFUSALS: ReadonlyMap<string, string> = new Map();

/** A union rather than two independent fields because the combination "unreachable because of the surface" and
 * "here is what is wrong with this host" is not a state that should be expressible. */
export type HostRowSurfaceState =
  | { readonly kind: "available" }
  | { readonly kind: "refused"; readonly word: string }
  | { readonly kind: "inert" };

export function hostRowSurfaceState(input: {
  readonly surfaceRefusal: string | null;
  readonly surfaceInert: boolean;
}): HostRowSurfaceState {
  if (input.surfaceInert) return { kind: "inert" };
  if (input.surfaceRefusal !== null) {
    return { kind: "refused", word: input.surfaceRefusal };
  }
  return { kind: "available" };
}

export const AVAILABLE_HOST_ROW_SURFACE_STATE: HostRowSurfaceState = {
  kind: "available",
};

/** Every container asks this, rather than re-deriving "can I click it" from `connectable` beside its own copy
 * of the reason word. */
export function isHostOptionSelectable(
  host: HostScopeOption,
  intent: HostPickIntent,
  surfaceState: HostRowSurfaceState,
): boolean {
  if (surfaceState.kind !== "available") return false;
  return intent === "view" || host.connectable;
}

/** A row that cannot be dialled is therefore silent about it here and inert to the touch. */
const STATUS_WORD: Record<HostHealthState, string | null> = {
  // Nothing to add: the dot carries it, and a word here would restate the
  // absence of a problem on every healthy row in the list.
  online: null,
  // The host is pickable and will dial; "reported reachable" is a nuance for the card, not a warning for a row,
  // and the muted dot already withholds the liveness claim.
  "reported-reachable": null,
  // A blind cloud read is not something a person acts on from a picker.
  unknown: null,
  // A window-scope fact: when the client is offline every row is in this state.
  "viewer-offline": null,
  restarting: "restarting",
  offline: "offline",
  // The remedy, not the symptom - one word covering both this and `offline` is what sent people debugging a
  // network over a billing limit.
  "local-only": "requires upgrade",
  "update-required": "update required",
  removed: "removed",
  stopped: "stopped",
  "not-installed": "not installed",
};

export function hostOptionStatusWord(
  host: HostScopeOption,
  surfaceState: HostRowSurfaceState,
): string | null {
  // The surface state is consulted first, not after status.
  if (surfaceState.kind === "inert") return null;
  if (host.settingUp) return "setting up";
  const statusWord = STATUS_WORD[host.health.state];
  if (statusWord !== null) return statusWord;
  return surfaceState.kind === "refused" ? surfaceState.word : null;
}

/** IT takes the projected view, never a raw `host.status` response, and that is what keeps it from becoming a
 * fourth vocabulary. */
export function hostOptionUpdateBadge(view: FleetUpdateView): string | null {
  if (view.kind === "unknown") {
    const lastKnown = view.lastKnownKind;
    if (lastKnown === null) return null;
    const retained = retainedBadgeWord(lastKnown);
    // A row has no room for a separate marker, so an unqualified "updating" on an offline host would be a claim we
    // cannot support.
    return retained === null ? null : `last seen ${retained}`;
  }
  if (view.qualified) {
    // Rendering `liveBadgeWord` for it would present "last knew it was downloading" as "is downloading" - the
    // exact present-tense claim the retained vocabulary exists to avoid.
    const retained = retainedBadgeWord(view.kind);
    return retained === null ? null : `last seen ${retained}`;
  }
  return liveBadgeWord(view.kind);
}

function liveBadgeWord(kind: FleetUpdateViewKind): string | null {
  switch (kind) {
    case "updating":
    case "downloading":
    case "preparing":
    case "applying":
    case "verifying":
      return "updating";
    case "waiting-for-work":
      return "update waiting";
    case "waiting-to-activate":
      return "restart to finish";
    case "failed":
      return "update failed";
    case "unavailable":
    case "restarting":
    case "reconnecting":
    case "complete":
    case "idle":
    case "unknown":
      return null;
  }
}

function retainedBadgeWord(kind: FleetUpdateViewKind): string | null {
  switch (kind) {
    // "last seen restart to finish" and "last seen update waiting" are compounds that read as instructions for a
    // machine this client cannot currently reach.
    case "updating":
    case "downloading":
    case "preparing":
    case "applying":
    case "verifying":
    case "waiting-for-work":
    case "waiting-to-activate":
    case "restarting":
    case "reconnecting":
      return "updating";
    // Terminal and durable: the host still holds this record, so it remains
    // true after we lose contact rather than becoming merely old.
    case "failed":
      return "update failed";
    case "complete":
    case "idle":
    case "unavailable":
    case "unknown":
      return null;
  }
}

/** The glyph stays the visual carrier; this is its text twin, rendered `sr-only` beside it, so nobody has to
 * infer a machine's kind from an icon they cannot see. */
export function hostOptionKindLabel(host: HostScopeOption): string {
  if (host.isLocalMachine) return "This machine";
  if (host.entry?.kind === "remote") return "Remote host";
  if (host.entry?.kind === "mock") return "Mock host";
  return "Host";
}
