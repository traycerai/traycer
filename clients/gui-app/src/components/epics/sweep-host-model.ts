import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";

/**
 * Which host a Sweep concerns: the fleet gate in front of the picker, the
 * picker's own rows, and the affordance gate that decides whether Sweep is
 * offered at all. One module because all three answer the same question from
 * the same zero-RPC evidence, and the two SURFACES (History and the Epic
 * status row) must answer it identically.
 */

/**
 * The occupancy badge's words. It claims exactly what the evidence supports -
 * the Task has AGENTS on this machine - and never "has worktrees here", which
 * would be a claim only the dialog's own act-time proof can make.
 */
export const SWEEP_HOST_OCCUPANCY_LABEL = "has agents for this task";

/**
 * Does this Task's client-visible provenance name a machine OTHER than the one
 * this surface speaks to?
 *
 * THE reason the Sweep affordance stays live for a multi-host Task. Both
 * surfaces used to gate purely on their own host's worktree listing, which is
 * the only reliable per-host worktree oracle there is - and which therefore
 * says nothing at all about a Task whose agents ran elsewhere. That greyed out
 * the single route to those worktrees, for exactly the Tasks multi-host Sweep
 * exists for.
 *
 * It is a HINT and both surfaces treat it as one. It over-claims (a node on a
 * host does not imply a worktree there - see `useEpicNodeHostIds`), and the
 * dialog's own empty state is the accepted outcome when it does. On History it
 * also under-claims: `HistoryItem.chatHostIds` covers the signed-in user's own
 * CHATS, not terminal agents, so a Task whose only off-host node is a TUI
 * agent still under-enables there. Accepted v1 residual - in-Epic gating
 * catches that case, and the exact answer needs the v2 per-host walk.
 *
 * `null` host ids (a peer that predates the field) answer NO rather than YES:
 * silence is not evidence, and the surface's own worktree listing is still the
 * other half of the gate. A surface with no host of its own answers NO too -
 * it has no client to sweep with, so there is nothing to compare against.
 */
export function namesHostOutsideSurface(input: {
  readonly hostIds: Iterable<string> | null;
  readonly surfaceHostId: string | null;
}): boolean {
  if (input.hostIds === null || input.surfaceHostId === null) return false;
  for (const hostId of input.hostIds) {
    if (hostId !== input.surfaceHostId) return true;
  }
  return false;
}

/**
 * Whether Sweep must ask WHICH host before it can proceed.
 *
 * Worktrees are per host and one Sweep dialog is one host's census, so a Task
 * whose agents ran on several machines owns worktrees the surface's own host
 * cannot see. Asking is the fix - but only where there is something to ask.
 *
 * At one usable host the question has one answer, so there is no question:
 * the single-host install must see byte-for-byte the behaviour it has today,
 * which is why this is a hard `> 1` on the DIALABLE fleet rather than on the
 * account's host count. A host that cannot be dialled (offline, or a remote
 * host this plan does not include) cannot serve a proof or a sweep, so it
 * never turns a one-answer question into two.
 */
export function sweepNeedsHostPicker(
  connectableHostIds: readonly string[],
): boolean {
  return connectableHostIds.length > 1;
}

/**
 * Folds per-Task host provenance into the badge set.
 *
 * `null` is not `[]` and the difference is load-bearing: a History row served
 * by a peer that predates `chatHostIds` cannot answer at all, and reading that
 * silence as "no hosts" would badge nothing while looking like a verdict. Both
 * cases contribute no ids - the picker lists every usable host either way -
 * but only one of them is a fact.
 */
export function unionHostIds(
  lists: Iterable<ReadonlyArray<string> | null>,
): ReadonlySet<string> {
  const union = new Set<string>();
  for (const list of lists) {
    if (list === null) continue;
    for (const hostId of list) union.add(hostId);
  }
  return union;
}

export interface SweepHostPickerRow {
  readonly host: HostScopeOption;
  /** The selected Task(s)' node records name this host. Hint, not a census. */
  readonly occupied: boolean;
  /** The host this surface was already pointed at when Sweep was opened. */
  readonly isDefault: boolean;
}

/**
 * EVERY host in the account's merged list, in the shared picker's own order -
 * never only the badged ones, and never only the dialable ones.
 *
 * Both exclusions are tempting and both are wrong. Filtering to badged hosts
 * would hide the case the badge cannot see: worktree owner-bindings cascade
 * best-effort on chat deletion, so a host can hold a Task's worktrees with no
 * client-visible record naming it. Filtering out dead hosts would delete the
 * only place a person learns WHY the machine they were looking for is not
 * offering to sweep. Non-selectable rows go inert with the shared status word
 * instead, which is what every other picker in the app does.
 */
export function buildSweepHostPickerRows(input: {
  readonly hosts: readonly HostScopeOption[];
  readonly occupiedHostIds: ReadonlySet<string>;
  readonly defaultHostId: string | null;
}): readonly SweepHostPickerRow[] {
  return input.hosts.map((host) => ({
    host,
    occupied: input.occupiedHostIds.has(host.hostId),
    isDefault: host.hostId === input.defaultHostId,
  }));
}

export interface SweepHostPickerGroups {
  /**
   * Rows shown at the top level: the badged hosts, badged-first, then the
   * surface's own host when nothing named it.
   */
  readonly primary: readonly SweepHostPickerRow[];
  /**
   * Rows behind the collapsed disclosure. EMPTY means render flat - there is
   * no disclosure at all, rather than an empty one.
   */
  readonly other: readonly SweepHostPickerRow[];
}

/**
 * Splits the (complete) row list into what a person is looking for and what
 * they are only occasionally looking for.
 *
 * The picker deliberately does NOT scope itself to the Epic's participating
 * hosts - that completeness is the whole backstop, since a host can hold a
 * Task's worktrees with no client-visible record naming it. But completeness
 * read as a flat fleet-wide list, which on a large account buries the two
 * machines that actually matter. Grouping keeps every row and demotes the
 * ones nothing points at; it is presentation, never a filter.
 *
 * Two rows are never demoted. A BADGED host is the answer the signal offers.
 * The DEFAULT host is where Sweep was already pointed, so hiding it would put
 * the pre-selected choice behind a disclosure - and it is also the row a
 * person falls back to when the badges are wrong.
 *
 * Degenerate case, and the reason this returns a union of two lists rather
 * than a predicate: when NOTHING is badged and there is no default, every row
 * would land under the disclosure. A list that is entirely collapsed is
 * strictly worse than the flat list it replaced, so that case renders flat.
 */
export function groupSweepHostPickerRows(
  rows: readonly SweepHostPickerRow[],
): SweepHostPickerGroups {
  const badged = rows.filter((row) => row.occupied);
  const unbadgedDefault = rows.filter((row) => !row.occupied && row.isDefault);
  if (badged.length === 0 && unbadgedDefault.length === 0) {
    return { primary: rows, other: [] };
  }
  return {
    // Badged first: the ordering claim the group is making. Stable within
    // each half, so the shared picker's own order (this machine, active,
    // alphabetical) still decides everything else.
    primary: [...badged, ...unbadgedDefault],
    other: rows.filter((row) => !row.occupied && !row.isDefault),
  };
}
