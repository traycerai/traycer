import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import type { WorktreeHostEntryV14 } from "@traycer/protocol/host/index";

/**
 * Which host a Sweep concerns: the fleet gate in front of the host chip, the
 * chip's own popover rows, and the affordance gate that decides whether Sweep
 * is offered at all. One module because all three answer the same question
 * from the same evidence, and the two SURFACES (History and the Epic status
 * row) must answer it identically.
 */

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
 * catches that case.
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

export interface SweepHostPickerRow {
  readonly host: HostScopeOption;
  /**
   * The host the dialog is CURRENTLY censusing - the one the chip names.
   *
   * It used to mean "where Sweep was already pointed when the question was
   * asked", and marking it was the defect the standalone step died of: a
   * highlighted row in a modal that asks "which host?" reads as a selection
   * nobody made. In a popover hung off a chip the same mark is simply true -
   * it says where you are, next to a census of that machine.
   */
  readonly isDefault: boolean;
}

/**
 * EVERY host in the account's merged list, in the shared picker's own order -
 * never only the dialable ones, and flat.
 *
 * Filtering out dead hosts would delete the only place a person learns WHY the
 * machine they were looking for is not offering to sweep. Non-selectable rows
 * go inert with the shared status word instead, which is what every other
 * picker in the app does.
 */
export function buildSweepHostPickerRows(input: {
  readonly hosts: readonly HostScopeOption[];
  readonly defaultHostId: string | null;
}): readonly SweepHostPickerRow[] {
  return input.hosts.map((host) => ({
    host,
    isDefault: host.hostId === input.defaultHostId,
  }));
}

/**
 * How many distinct worktrees on one host belong to the selected Task(s).
 *
 * The SAME attribution the Sweep dialog's own candidates query uses as its
 * first step (`use-epic-sweep-worktree-candidates-query.ts`): a worktree
 * counts when any of its owner bindings - GUI chat or terminal agent, archived
 * or not - names a selected Task. A worktree shared by two selected Tasks
 * counts once, because the listing already lists it once.
 */
export function countTaskWorktrees(
  worktrees: ReadonlyArray<Pick<WorktreeHostEntryV14, "owners">>,
  selectedEpicIds: ReadonlySet<string>,
): number {
  let count = 0;
  for (const entry of worktrees) {
    if (entry.owners.some((owner) => selectedEpicIds.has(owner.epicId))) {
      count += 1;
    }
  }
  return count;
}

/**
 * The row's trailing pill, or `null` for no pill at all.
 *
 * Positive counts only. "No number" covers zero, unknown, loading and failed
 * alike, so a row never claims a zero it has not proven - and it keeps the
 * word, because a bare digit next to a host name reads as anything.
 */
export function sweepHostCountLabel(count: number | null): string | null {
  if (count === null || count <= 0) return null;
  return `${String(count)} worktree${count === 1 ? "" : "s"}`;
}
