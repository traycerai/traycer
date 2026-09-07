/**
 * Epics whose landing-flow optimistic binding seed is still authoritative: `epic.create` is in flight (or just resolved) and the host's binding rows may not be readable yet, so a `worktree.listBindingsForEpic` refetch would return `{ rows: [] }` and clobber.
 */
const pendingEpicIds = new Set<string>();

export function markEpicCreateSeedPending(epicId: string): void {
  pendingEpicIds.add(epicId);
}

export function clearEpicCreateSeedPending(epicId: string): void {
  pendingEpicIds.delete(epicId);
}

export function isEpicCreateSeedPending(epicId: string): boolean {
  return pendingEpicIds.has(epicId);
}
