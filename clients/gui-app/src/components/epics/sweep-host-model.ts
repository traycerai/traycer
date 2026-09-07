import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import type { WorktreeHostEntryV14 } from "@traycer/protocol/host/index";

/** One module because all three answer the same question from the same evidence, and the two surfaces (History
 * and the Epic status row) must answer it identically. */

/** On History it also under-claims: `HistoryItem.chatHostIds` covers the signed-in user's own chats, not
 * terminal agents, so a Task whose only off-host node is a TUI agent still under-enables there. */
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

/** A host that cannot be dialled (offline, or a remote host this plan does not include) cannot serve a proof or
 * a sweep, so it never turns a one-answer question into two. */
export function sweepNeedsHostPicker(
  connectableHostIds: readonly string[],
): boolean {
  return connectableHostIds.length > 1;
}

export interface SweepHostPickerRow {
  readonly host: HostScopeOption;
  /** The host the dialog is currently censusing - the one the chip names. */
  readonly isDefault: boolean;
}

/** Every host in the account's merged list, in the shared picker's own order - never only the dialable ones,
 * and flat. */
export function buildSweepHostPickerRows(input: {
  readonly hosts: readonly HostScopeOption[];
  readonly defaultHostId: string | null;
}): readonly SweepHostPickerRow[] {
  return input.hosts.map((host) => ({
    host,
    isDefault: host.hostId === input.defaultHostId,
  }));
}

/** How many distinct worktrees on one host belong to the selected Task(s). A worktree shared by two selected
 * Tasks counts once, because the listing already lists it once. */
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

/** "No number" covers zero, unknown, loading and failed alike, so a row never claims a zero it has not proven -
 * and it keeps the word, because a bare digit next to a host name reads as anything. */
export function sweepHostCountLabel(count: number | null): string | null {
  if (count === null || count <= 0) return null;
  return `${String(count)} worktree${count === 1 ? "" : "s"}`;
}
