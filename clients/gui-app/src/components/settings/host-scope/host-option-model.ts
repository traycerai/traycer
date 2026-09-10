import type { HostHealthState } from "@/components/settings/host-scope/host-health";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import type {
  FleetUpdateView,
  FleetUpdateViewKind,
} from "@/lib/host/fleet-update/fleet-update-view";

/**
 * What CHOOSING a host does on this surface — the one thing that legitimately
 * differs between the pickers now that they share a list.
 *
 * - `view`: point a read-only surface at the host (Settings' scoped sections,
 *   the header's usage popover). A host this client cannot dial is a legal
 *   pick: the surface then says why it is empty, and picking it is how you get
 *   back to it when it returns.
 * - `bind`: make it the host this window RUNS on — where new work lands (the
 *   composer, the shell's Select host dialog). A host this client cannot dial
 *   is not a legal answer there, so its row is inert rather than a click that
 *   could only fail.
 * - `pin`: scope this surface's RPCs; never rebinds the window (git-diff
 *   panel, file tree, new-terminal picker). Undialable rows stay inert, and
 *   there is no "Active" chip — same pick legality as `bind`, different write.
 *
 * All intents draw the SAME row. Which hosts exist, what they are called and
 * whether they can be reached is one answer everywhere; only the consequence of
 * clicking differs.
 */
export type HostPickIntent = "view" | "bind" | "pin";

/**
 * A refusal the SURFACE holds against a host, keyed by `hostId` and carrying
 * the one word the row shows for it ("needs update").
 *
 * `connectable` / `planRestricted` are facts about the host that every picker
 * shares. This is the other kind: a reason THIS picker cannot use THIS host,
 * which no other picker would state — the fork dialog's target must speak
 * `epic.createChat` at the minor that carries the cross-host owner hint, and a
 * host below it is perfectly fine everywhere else in the app.
 *
 * It travels as a map rather than a predicate so the picker chain stays
 * referentially stable and a surface with nothing to say passes
 * {@link NO_HOST_OPTION_REFUSALS} instead of a fresh closure per render.
 */
export const NO_HOST_OPTION_REFUSALS: ReadonlyMap<string, string> = new Map();

/**
 * What a surface is saying about one row, as ONE value.
 *
 * A union rather than two independent fields because the combination
 * "unreachable because of the surface" AND "here is what is wrong with this
 * host" is not a state that should be expressible. It rendered as a globally
 * inert row still carrying "needs update", which invites a retry on another
 * machine that cannot possibly help — the per-host word contradicting the
 * class-level reason sitting next to it.
 *
 * Inert LEADS: when the surface has put every row but one out of reach, the
 * surface owns the explanation and the rows stay silent.
 */
export type HostRowSurfaceState =
  | { readonly kind: "available" }
  /** This host's own problem, in one word, on this row. */
  | { readonly kind: "refused"; readonly word: string }
  /** The surface's problem. No word here — the surface says it once. */
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

/**
 * Whether choosing this row is a legal answer for that intent.
 *
 * Every container asks THIS, rather than re-deriving "can I click it" from
 * `connectable` beside its own copy of the reason word. A second gate written
 * as a hand-rolled subset of this one is how a row ends up inert with no
 * explanation, or explained but still clickable — which is exactly why the
 * surface state is an argument here and not a second `&&` at each container.
 */
export function isHostOptionSelectable(
  host: HostScopeOption,
  intent: HostPickIntent,
  surfaceState: HostRowSurfaceState,
): boolean {
  if (surfaceState.kind !== "available") return false;
  return intent === "view" || host.connectable;
}

/**
 * The row's status word — the SAME vocabulary the Overview card speaks, in the
 * terse form a single-line row can carry.
 *
 * It used to answer a ROUTE question in STATUS words:
 *
 *     if (host.connectable) return null;
 *     return host.planRestricted ? "requires upgrade" : "unreachable";
 *
 * which made this the app's THIRD independent status vocabulary — after the
 * Settings health line and the tile banners — and the one that contradicted its
 * own row. A registry-only host whose health line read "Reported reachable"
 * carried the word "unreachable" beside it, in the same row, because the two
 * were answering different questions in the same voice.
 *
 * Those questions are now cleanly split. **Route decides interactivity**
 * (`isHostOptionSelectable` below, which the containers use to render a row
 * inert); **status decides words**, and status means the lease-derived
 * `health.state`. A row that cannot be dialled is therefore silent about it
 * here and inert to the touch, with the full reason spoken by the scope gate
 * when a `view` pick lands on it — rather than a fourth surface inventing its
 * own word for a fact three others already describe.
 *
 * `host.settingUp` outranks the table, and that ordering is the M5 requirement:
 * a machine whose host is being installed right now is not "offline" in any
 * sense a user can act on — it is mid-setup, and it will be dialable shortly.
 * It is also a mutation-lane fact rather than a status one, which is why it
 * sits outside the table instead of inside it.
 *
 * Order of precedence, most-owning first: an INERT row says nothing at all
 * (the surface owns the explanation); `settingUp` and the lease-derived
 * status word lead next, because a host that is mid-setup or has no route
 * cannot also be meaningfully described by a surface refusal; and the
 * surface refusal speaks last, for a host that IS fine and still cannot be
 * used here.
 */
const STATUS_WORD: Record<HostHealthState, string | null> = {
  // Nothing to add: the dot carries it, and a word here would restate the
  // absence of a problem on every healthy row in the list.
  online: null,
  // Deliberately silent. The host is pickable and will dial; "reported
  // reachable" is a nuance for the card, not a warning for a row, and the
  // muted dot already withholds the liveness claim (F26).
  "reported-reachable": null,
  // A blind cloud read is not something a person acts on from a picker.
  unknown: null,
  // A WINDOW-scope fact: when the client is offline every row is in this
  // state, so the global narrator owns it (`windowNarratorOwns`) and repeating
  // it down a list of eight is the layered-narration class this epic deletes.
  "viewer-offline": null,
  restarting: "restarting",
  offline: "offline",
  // The remedy, not the symptom — one word covering both this and `offline`
  // is what sent people debugging a network over a billing limit.
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
  // The SURFACE state is consulted FIRST, not after status. When the surface
  // has put the row out of reach it owns the whole explanation, and a status
  // word alongside it contradicts that reason - "offline" or "requires
  // upgrade" on a row the class already ruled out reads as a problem with
  // THAT machine, and invites trying another one when no other one can help.
  if (surfaceState.kind === "inert") return null;
  if (host.settingUp) return "setting up";
  const statusWord = STATUS_WORD[host.health.state];
  if (statusWord !== null) return statusWord;
  return surfaceState.kind === "refused" ? surfaceState.word : null;
}

/**
 * The row's UPDATE badge — deliberately a second, separate word from
 * {@link hostOptionStatusWord}, and this file is the wrong place to merge them.
 *
 * The status word above answers **health and route**: can this machine be
 * reached, is it mid-setup, is it removed. This answers **what its update is
 * doing**. The experience doc states the rule directly — "connectivity and
 * update state remain separate facts" — and the long note on `STATUS_WORD`
 * records what happened the last time one vocabulary tried to answer two
 * questions: a row contradicted its own health line, in the same row.
 *
 * So a host can legitimately carry both ("offline" · "update failed"), and it
 * can carry the update badge with no status word at all, which is the common
 * case: a perfectly healthy host that happens to be downloading.
 *
 * SILENT during restart/reconnect on purpose. Those are the one genuine overlap
 * — the health state already has its own `restarting` word, and the doc's
 * "an observed expected restart is not flattened into ordinary Offline" cuts
 * both ways: connectivity owns that moment, and a second word beside it would
 * be the duplication this split exists to prevent.
 *
 * IT TAKES THE PROJECTED VIEW, never a raw `host.status` response, and that is
 * what keeps it from becoming a fourth vocabulary. `describeUpdateOperation`
 * (sentences, for the banner and the Overview) and this (one or two words, for
 * a single-line row) are two renderings of the SAME `FleetUpdateView.kind`, so
 * they can differ in length but cannot disagree about what the host is doing.
 * A badge derived from the wire directly could, and would.
 *
 * Silent for `idle` and `complete` because a row is for exceptions: an
 * up-to-date host and a host that just finished both have nothing a person
 * needs to act on from a picker.
 *
 * A BARE `unknown` is silent too, and that rule is load-bearing rather than
 * tidy: a badge reading "unknown" on every pre-@1.3 remote host, indefinitely,
 * is noise that teaches people to ignore the column.
 *
 * A RETAINED phase is a different thing wearing the same `kind`, and it gets a
 * qualified word. The two cases are cleanly separable — a peer that never spoke
 * `@1.3` has nothing to retain, so `lastKnownKind` is exactly `null` for the
 * noise case and non-null only for a host we genuinely watched doing something
 * before losing it. The retained word is deliberately coarser than the live
 * one: from a picker, "which phase was it in" is not a question anyone acts on,
 * whereas "this machine was mid-update when it went quiet" is.
 */
export function hostOptionUpdateBadge(view: FleetUpdateView): string | null {
  if (view.kind === "unknown") {
    const lastKnown = view.lastKnownKind;
    if (lastKnown === null) return null;
    const retained = retainedBadgeWord(lastKnown);
    // Qualified in the badge itself. A row has no room for a separate marker,
    // so an unqualified "updating" on an offline host would be a claim we
    // cannot support.
    return retained === null ? null : `last seen ${retained}`;
  }
  if (view.qualified) {
    // A stale view can carry a NON-unknown kind too (`qualified` is the
    // view's own "surfaces MUST qualify this" flag, deliberately separate
    // from `kind`). Rendering `liveBadgeWord` for it would present "last
    // knew it was downloading" as "is downloading" — the exact present-tense
    // claim the retained vocabulary exists to avoid.
    const retained = retainedBadgeWord(view.kind);
    return retained === null ? null : `last seen ${retained}`;
  }
  return liveBadgeWord(view.kind);
}

/**
 * The badge a LIVE view earns, as a table rather than a switch.
 *
 * `Record<FleetUpdateViewKind, …>` keeps the exhaustiveness a switch gave —
 * a new kind is a missing key and a type error — while costing no cyclomatic
 * budget, which a 16-arm switch no longer had (oxlint caps a function at 16 and
 * a switch spends one per arm). Same construct as {@link STATUS_WORD} above,
 * for the same reason.
 */
const LIVE_BADGE_WORD: Record<FleetUpdateViewKind, string | null> = {
  updating: "updating",
  downloading: "updating",
  preparing: "updating",
  applying: "updating",
  verifying: "updating",
  "waiting-for-work": "update waiting",
  "waiting-to-activate": "restart to finish",
  failed: "update failed",
  // No badge, deliberately. The host is up to date and serving; a picker row is
  // a place to find a machine to work on, and the only thing this state would
  // tell someone scanning that list is that a file will be tidied up on its
  // own. The Overview card says it where a person is actually looking at that
  // host. A badge here would also have to be one word like "updated", which is
  // indistinguishable from `complete` — which draws no badge either.
  "finalizing-record": null,
  // Same: the row is not where a refused verification gets explained, and no
  // single word separates it from an ordinary quiet host. The Overview card
  // names what happened and points at Diagnostics.
  "verification-refused": null,
  unavailable: null,
  restarting: null,
  reconnecting: null,
  complete: null,
  idle: null,
  unknown: null,
};

function liveBadgeWord(kind: FleetUpdateViewKind): string | null {
  return LIVE_BADGE_WORD[kind];
}

/**
 * The badge a RETAINED (host-unreachable) view earns. Table for the same reason
 * as {@link LIVE_BADGE_WORD}.
 */
const RETAINED_BADGE_WORD: Record<FleetUpdateViewKind, string | null> = {
  // Every mid-update phase collapses to one word. "last seen restart to finish"
  // and "last seen update waiting" are compounds that read as instructions for
  // a machine this client cannot currently reach.
  updating: "updating",
  downloading: "updating",
  preparing: "updating",
  applying: "updating",
  verifying: "updating",
  "waiting-for-work": "updating",
  "waiting-to-activate": "updating",
  restarting: "updating",
  reconnecting: "updating",
  // Terminal and durable: the host still holds this record, so it remains true
  // after we lose contact rather than becoming merely old.
  failed: "update failed",
  // Unreachable, and for a reason that does not depend on where the projector
  // happens to put either route: `retainedBadgeWord` is only ever called with a
  // `lastKnownKind`, `lastKnownKind` is only ever produced by `phaseKind`, and
  // `phaseKind`'s codomain contains neither of these kinds — both are minted by
  // arms of their own, downstream of it.
  //
  // The earlier wording here said `verification-refused` "is decided before the
  // stale arm can retain it", which is BACKWARDS — the stale arm returns first
  // and the refusal route is reached only when the read is NOT stale. Worse, it
  // would have licensed hoisting that route above the stale arm, since the
  // comment would still have read as true afterwards. Stated as the structural
  // fact instead, so it cannot be used to justify a change that breaks it.
  //
  // Kept because the table is exhaustive, and `null` is the answer either would
  // want anyway: same reasoning as the live badge.
  "finalizing-record": null,
  "verification-refused": null,
  complete: null,
  idle: null,
  unavailable: null,
  unknown: null,
};

function retainedBadgeWord(kind: FleetUpdateViewKind): string | null {
  return RETAINED_BADGE_WORD[kind];
}

/**
 * What KIND of host this is, in words.
 *
 * The row draws this as a glyph, which is `aria-hidden` — so when the Select
 * host dialog moved onto the shared row it silently dropped the `Local` /
 * `Remote` badge that had been the only kind information a screen reader ever
 * got there. The glyph stays the visual carrier; this is its text twin,
 * rendered `sr-only` beside it, so nobody has to infer a machine's kind from an
 * icon they cannot see.
 */
export function hostOptionKindLabel(host: HostScopeOption): string {
  if (host.isLocalMachine) return "This machine";
  if (host.entry?.kind === "remote") return "Remote host";
  if (host.entry?.kind === "mock") return "Mock host";
  return "Host";
}
