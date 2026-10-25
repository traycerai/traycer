import type { HostHealthState } from "@/components/settings/host-scope/host-health";
import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import { isSandboxAsleep } from "@traycer-clients/shared/host-client/sandbox-control";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { isSandboxHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import {
  formatPlatform,
  isUnenrolledSandboxOption,
  type HostScopeOption,
  type HostScopeSandbox,
} from "@/components/settings/host-scope/host-scope-model";
import { formatSandboxTime } from "@/lib/sandboxes/sandbox-row-lines";
import {
  COMPUTER_ACTIVE,
  computerOfflineLine,
  computerSubLine,
} from "@/lib/sandboxes/sandbox-strings";
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
 * What an Activate does, said where it is offered (Settings' Activate button
 * and the account menu's Host rows). Not "tabs stay on the host they started
 * on" - the active-host switch still reloads open tabs today (F2/F3/F7), so
 * that promise would be false. This only says what IS true.
 */
export const ACTIVATE_HOST_HINT = "Switching changes where new work starts.";

/**
 * A refusal the SURFACE holds against a host, keyed by `hostId` and carrying
 * the one word the row shows for it ("needs update").
 *
 * `connectable` is a fact about the host that every picker
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
  if (intent === "view") return true;
  if (host.sandbox !== null && host.sandbox.frozen) return false;
  return host.connectable || isSleepingSandboxPick(host);
}

/**
 * A sandbox that is asleep (suspended, stopped or released, or on its way
 * there) and not frozen. Picking it in a `pin` or `bind` picker is the user's next
 * action, which wakes it (`wakeSandboxOnPick`), so the row is offered
 * whatever its route says: a sleeping sandbox reads `offline`, and past the
 * relay fuse's grace it has no route at all. The pin or preference is stored
 * at once; the surface resolves to its fallback while the sandbox's lease
 * reads dead, so nothing lands on it before it answers, and returns to it
 * when it does. A frozen sandbox is never offered: a wake would only refuse.
 */
export function isSleepingSandboxPick(host: HostScopeOption): boolean {
  return (
    host.sandbox !== null &&
    !host.sandbox.frozen &&
    isSandboxAsleep(host.sandbox.state)
  );
}

/**
 * The row's status word — the SAME vocabulary the Overview card speaks, in the
 * terse form a single-line row can carry.
 *
 * It used to answer a ROUTE question in STATUS words:
 *
 *     if (host.connectable) return null;
 *     return "unreachable";
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
  // word alongside it contradicts that reason - "offline" on a row the
  // class already ruled out reads as a problem with
  // THAT machine, and invites trying another one when no other one can help.
  if (surfaceState.kind === "inert") return null;
  if (host.settingUp) return "setting up";
  // A sandbox speaks its lifecycle instead of connectivity: "suspended" is
  // why it is not answering, which "offline" would hide. Except "awake",
  // which explains nothing about a row that cannot be reached: there the
  // health or the refusal word says why, and "awake" is left for the row
  // that is fine.
  const sandboxWord =
    host.sandbox === null ? null : sandboxStateWord(host.sandbox);
  if (sandboxWord !== null && sandboxWord !== "awake") return sandboxWord;
  const statusWord = STATUS_WORD[host.health.state];
  if (statusWord !== null) return statusWord;
  if (surfaceState.kind === "refused") return surfaceState.word;
  return sandboxWord;
}

/**
 * A computer's sub-line in the composer and in-task pickers: the machine's
 * name under a `This computer` title, its OS, and whether it answers
 * (`windows-test-machine · Windows · Active`, `Linux · Active`). `pickable`
 * is the row's own {@link isHostOptionSelectable}, so the offline line
 * promises a wait only on a row that can be picked.
 */
export function composerComputerSubLine(
  host: HostScopeOption,
  pickable: boolean,
): string {
  return computerSubLine([
    host.isLocalMachine ? host.name : null,
    formatPlatform(host.platform),
    composerComputerStatus(host, pickable),
  ]);
}

/**
 * The status part of {@link composerComputerSubLine}, from the same health
 * the status word reads. A blind read and a window-wide offline say nothing,
 * as the status word does not.
 */
function composerComputerStatus(
  host: HostScopeOption,
  pickable: boolean,
): string | null {
  if (host.settingUp) return "Setting up";
  switch (host.health.state) {
    case "online":
    case "reported-reachable":
      return COMPUTER_ACTIVE;
    case "offline":
      return computerOfflineLine(
        lastSeenLabel(host.item?.status.lastSeenAt ?? null),
        pickable,
      );
    case "unknown":
    case "viewer-offline":
      return null;
    case "restarting":
    case "update-required":
    case "removed":
    case "stopped":
    case "not-installed": {
      const word = STATUS_WORD[host.health.state];
      return word === null
        ? null
        : word.charAt(0).toUpperCase() + word.slice(1);
    }
  }
}

/** `Tue 09:12`: when an offline computer was last seen. */
function lastSeenLabel(lastSeenAt: string | null): string | null {
  if (lastSeenAt === null) return null;
  const at = Date.parse(lastSeenAt);
  if (Number.isNaN(at)) return null;
  const weekday = new Date(at).toLocaleDateString(undefined, {
    weekday: "short",
  });
  return `${weekday} ${formatSandboxTime(at)}`;
}

/**
 * Whether a sandbox's lifecycle word gives way to its host health: the
 * sandbox is `awake` (so its lifecycle explains no unreachability) and its
 * health has a word of its own (offline, restarting, update required...).
 * Every other lifecycle word (suspended, resuming, stopped, frozen, failed)
 * is itself why the host is not answering, and keeps the slot.
 */
export function sandboxWordYieldsToHealth(host: HostScopeOption): boolean {
  if (host.sandbox === null) return false;
  if (sandboxStateWord(host.sandbox) !== "awake") return false;
  return STATUS_WORD[host.health.state] !== null;
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

/** The picker's words for a retained phase ("Last seen: updating"). */
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
  if (host.sandbox !== null) return "Sandbox";
  if (host.entry?.kind === "remote") return "Remote host";
  if (host.entry?.kind === "mock") return "Mock host";
  return "Host";
}

/**
 * A sandbox's lifecycle, as the one word a row carries in place of the
 * connectivity it would otherwise show. Every state has a word, `awake`
 * included: a sandbox is billed by state, so "awake" is information a person
 * scanning the list acts on, where a personal host's "online" is not.
 * `frozen` leads, because it is why a suspended or stopped sandbox will not
 * wake; a destroyed or failed row never reads frozen (the flag is folded with
 * the state upstream, `isSandboxFrozenInEffect`).
 */
const SANDBOX_STATE_WORD: Record<HostSandboxState, string> = {
  creating: "creating",
  awake: "awake",
  suspending: "suspending",
  suspended: "suspended",
  resuming: "resuming",
  stopping: "stopping",
  stopped: "stopped",
  starting: "starting",
  destroying: "destroying",
  destroyed: "destroyed",
  failed: "failed",
  released: "released",
};

export function sandboxStateWord(sandbox: HostScopeSandbox): string | null {
  if (sandbox.frozen) return "frozen";
  return sandbox.state === null ? null : SANDBOX_STATE_WORD[sandbox.state];
}

/**
 * Where a row sits in a host list:
 *
 * - `personal`: the user's own machines, the list's first group.
 * - `sandbox`: a sandbox the user created, in a collapsible group below them.
 * - `agent-sandbox`: a burst sandbox an agent created for one task. Shown ONLY
 *   by the host list, in a collapsed sub-group; never offered by a picker,
 *   where starting work on it would outlive the task it was made for.
 * - `hidden`: left out of this list.
 *
 * The Automations pod (`kind: "automation"`) is a slim host for scheduled
 * runs: the host list shows it with the user's sandboxes, and no picker
 * offers it. It is reached by its `automation` alias and the configuration's
 * Sandboxes page.
 *
 * `listsAgentSandboxes` is the host list (Settings), every other surface is a
 * picker. A picker fails CLOSED on a sandbox whose control-plane row has not
 * answered (`summary === null`): until `GET /api/sandboxes` says it is not
 * burst, it might be, and a burst sandbox offered once is the leak.
 *
 * The server pool (`kind: "pool"`) is hidden from every list: it serves the
 * cloud's own read paths and is not a machine anyone picks, activates or
 * manages.
 */
export type HostPickerGroup =
  "personal" | "sandbox" | "agent-sandbox" | "hidden";

export function hostOptionPickerGroup(
  host: HostScopeOption,
  listsAgentSandboxes: boolean,
  /**
   * The viewer a composer picker is scoped to, or `null` for every other
   * list. A composer offers only the sandboxes the viewer started or kept;
   * the mode adds that `hidden` arm and changes no other.
   */
  composerViewer: ComposerPickerViewer | null,
): HostPickerGroup {
  if (host.entry?.kind === "pool") return "hidden";
  if (host.sandbox === null) return "personal";
  // A sandbox no host row stands for yet: never offered as a
  // host. The host list groups it by the rules below, like any sandbox.
  if (!listsAgentSandboxes && isUnenrolledSandboxOption(host)) return "hidden";
  const summary = host.sandbox.summary;
  if (summary === null) return listsAgentSandboxes ? "sandbox" : "hidden";
  if (summary.kind === "automation") {
    return listsAgentSandboxes ? "sandbox" : "hidden";
  }
  if (summary.burst) return listsAgentSandboxes ? "agent-sandbox" : "hidden";
  if (
    composerViewer !== null &&
    !viewerStartedOrKept(host.sandbox, summary, composerViewer)
  ) {
    return "hidden";
  }
  return "sandbox";
}

/** Who a composer picker lists sandboxes for. */
export interface ComposerPickerViewer {
  /** `null` while signed out: no team sandbox is then the viewer's. */
  readonly userId: string | null;
}

/**
 * Whether the viewer started this sandbox or kept it. A personal sandbox is
 * its owner's (the control plane lists only the viewer's own), so it is
 * theirs; a team sandbox is theirs when they created it or kept it, so a
 * teammate's sandbox, kept or not, stays on the team's Sandboxes page.
 */
function viewerStartedOrKept(
  sandbox: HostScopeSandbox,
  summary: SandboxSummary,
  viewer: ComposerPickerViewer,
): boolean {
  if (!sandbox.teamOwned) return true;
  if (viewer.userId === null) return false;
  return (
    summary.createdBy?.userId === viewer.userId ||
    summary.keptBy?.userId === viewer.userId
  );
}

/**
 * Whether Activate may be offered for this row: exactly the rows a full-host
 * picker offers. The host list keeps the Automations pod, burst sandboxes and
 * an unconfirmed sandbox (`summary === null`) visible for management.
 * Activating one would route the window's new work to a scheduled-run pod or
 * a task-owned sandbox, which every picker hides for that reason. Asked
 * without the composer's viewer, so who started a sandbox never decides it.
 */
export function hostOptionCanActivate(host: HostScopeOption): boolean {
  return hostOptionPickerGroup(host, false, null) !== "hidden";
}

/**
 * Why a team's host is never this window's host. Shown on its disabled
 * Activate and as the refusal when a switch to one is asked for anyway.
 */
export const TEAM_HOST_ACTIVATE_REASON = "Team hosts can't be made active.";

/**
 * One team's hosts in a list: its sandboxes and pods, and the
 * burst ones an agent made, under the team's name.
 */
export interface HostTeamGroup {
  readonly teamId: string;
  readonly teamName: string;
  readonly sandboxes: readonly HostScopeOption[];
  readonly agentSandboxes: readonly HostScopeOption[];
}

export interface HostPickerGroups {
  readonly personal: readonly HostScopeOption[];
  readonly sandboxes: readonly HostScopeOption[];
  readonly agentSandboxes: readonly HostScopeOption[];
  /** Ordered by team name, then id. */
  readonly teams: readonly HostTeamGroup[];
}

/**
 * The team that owns a sandbox row, from its registry `owner`, or `null`: a
 * personal host, a sandbox the person owns, and a row whose registry carries
 * no `owner` (an authn from before it) all stay in the person's own groups.
 */
export function hostOptionTeamOwner(
  host: HostScopeOption,
): { readonly teamId: string; readonly teamName: string } | null {
  if (host.sandbox === null) return null;
  const owner = host.item?.owner ?? null;
  if (owner === null || owner.kind !== "team") return null;
  return { teamId: owner.id, teamName: owner.name };
}

interface MutableTeamGroup {
  readonly teamId: string;
  readonly teamName: string;
  readonly sandboxes: HostScopeOption[];
  readonly agentSandboxes: HostScopeOption[];
}

/**
 * Splits a list into its groups, in the list's own order. `keepHostId` is the
 * row the surface is pointed at: it is never dropped, because hiding the
 * current answer is not the same thing as not offering it (a composer fixed to
 * a burst sandbox's tab still shows that tab's host).
 */
export function groupHostOptions(
  hosts: readonly HostScopeOption[],
  listsAgentSandboxes: boolean,
  composerViewer: ComposerPickerViewer | null,
  keepHostId: string | null,
): HostPickerGroups {
  const personal: HostScopeOption[] = [];
  const sandboxes: HostScopeOption[] = [];
  const agentSandboxes: HostScopeOption[] = [];
  const teams = new Map<string, MutableTeamGroup>();
  for (const host of hosts) {
    const group = hostOptionPickerGroup(
      host,
      listsAgentSandboxes,
      composerViewer,
    );
    const owner = hostOptionTeamOwner(host);
    let target = { sandboxes, agentSandboxes };
    if (owner !== null) {
      const team = teams.get(owner.teamId) ?? {
        teamId: owner.teamId,
        teamName: owner.teamName,
        sandboxes: [],
        agentSandboxes: [],
      };
      teams.set(owner.teamId, team);
      target = team;
    }
    if (group === "personal") personal.push(host);
    else if (group === "sandbox") target.sandboxes.push(host);
    else if (group === "agent-sandbox") target.agentSandboxes.push(host);
    else if (host.hostId === keepHostId) target.sandboxes.push(host);
  }
  return {
    personal,
    sandboxes,
    agentSandboxes,
    teams: [...teams.values()]
      .filter(
        (team) => team.sandboxes.length > 0 || team.agentSandboxes.length > 0,
      )
      .sort(
        (a, b) =>
          a.teamName.localeCompare(b.teamName) ||
          a.teamId.localeCompare(b.teamId),
      ),
  };
}

/**
 * A composer picker's host groups: `Yours` (the person's computers) and
 * `Sandboxes you started` (every configuration together, the viewer's own
 * and the team sandboxes they started or kept, never an agent's), in the
 * list's order. `keepHostId` is the row the composer is pointed at, which is
 * never dropped (see {@link groupHostOptions}).
 */
export interface ComposerHostGroups {
  readonly yours: readonly HostScopeOption[];
  readonly started: readonly HostScopeOption[];
}

export function groupComposerHostOptions(
  hosts: readonly HostScopeOption[],
  viewer: ComposerPickerViewer,
  keepHostId: string | null,
): ComposerHostGroups {
  const groups = groupHostOptions(hosts, false, viewer, keepHostId);
  return {
    yours: groups.personal,
    started: [
      ...groups.sandboxes,
      ...groups.teams.flatMap((team) => team.sandboxes),
    ],
  };
}

/** `N awake` beside the collapsed `Sandboxes you started` count. */
export function awakeSandboxCount(hosts: readonly HostScopeOption[]): number {
  return hosts.filter(
    (host) =>
      host.sandbox !== null &&
      !host.sandbox.frozen &&
      host.sandbox.state === "awake",
  ).length;
}

/**
 * The one line every credential control shows, disabled, on a sandbox.
 */
export const SANDBOX_CREDENTIALS_REFUSED = "Sandboxes don't take sign-ins";

/**
 * Whether a credential (a sign-in, a provider's API key or env override, a
 * synced profile, an MCP server's auth) may be sent to this host. A sandbox
 * runs code the user did not write on a machine they do not hold, so it takes
 * none of them. The check is made BEFORE the RPC: the sandbox's own
 * `SANDBOX_HOST_REFUSES_CREDENTIALS` arrives only after the secret already
 * has. {@link hostEntryTakesCredentials} is the same rule over a directory
 * entry, for a surface that holds one instead of a picker row. The server
 * pool takes none either: it serves the cloud's reads and holds no one's
 * secrets.
 */
export function hostTakesCredentials(host: HostScopeOption): boolean {
  return host.sandbox === null && host.entry?.kind !== "pool";
}

/**
 * {@link hostTakesCredentials} over a directory entry. An unknown host
 * (`null`) is not refused here: with no directory row there is no route to
 * send through either.
 */
export function hostEntryTakesCredentials(
  entry: HostDirectoryEntry | null,
): boolean {
  return (
    entry === null ||
    (entry.kind !== "pool" && !isSandboxHostDirectoryEntry(entry))
  );
}

/**
 * The rows a picker may offer as the TARGET of a credential: personal hosts
 * only ({@link hostTakesCredentials}), so a sandbox is never offered as a
 * step that would hand it a secret.
 */
export function credentialTargetHostOptions(
  hosts: readonly HostScopeOption[],
): readonly HostScopeOption[] {
  return hosts.filter(hostTakesCredentials);
}

/**
 * {@link groupHostOptions} flattened for a surface that draws one flat list
 * (the browser sidebar, a sweep): personal hosts first, then the person's own
 * pickable sandboxes, then each team's in team order, never a burst one.
 */
export function pickableHostOptions(
  hosts: readonly HostScopeOption[],
  keepHostId: string | null,
): readonly HostScopeOption[] {
  const groups = groupHostOptions(hosts, false, null, keepHostId);
  return [
    ...groups.personal,
    ...groups.sandboxes,
    ...groups.teams.flatMap((team) => team.sandboxes),
  ];
}

/**
 * The rows the app-wide host may be switched to (the account menu): personal
 * hosts, then the person's own pickable sandboxes. A team's sandbox is never
 * one - it serves its team's environment, and the selection authority refuses
 * it - so offering it would be a pick that does nothing. A team sandbox whose
 * registry row has not arrived lands in the own-sandbox group (grouping reads
 * the row's owner), so the directory's `teamOwned` fact excludes it too.
 */
export function appWideHostOptions(
  hosts: readonly HostScopeOption[],
  keepHostId: string | null,
): readonly HostScopeOption[] {
  const groups = groupHostOptions(hosts, false, null, keepHostId);
  return [
    ...groups.personal,
    ...groups.sandboxes.filter(
      (host) => host.sandbox === null || !host.sandbox.teamOwned,
    ),
  ];
}
