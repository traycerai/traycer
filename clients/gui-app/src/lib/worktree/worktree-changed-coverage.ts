/**
 * Which hosts currently have an OPEN `worktree.changed` stream in this
 * renderer.
 *
 * A worktree read can only be trusted "until the host says otherwise" for a
 * host that can say so: the stream's frames - per row, per root, and the
 * catch-up on every (re)subscribe - are what refetch it. A read of any other
 * host (an Epic bound to a different machine, the Sweep popover's other rows)
 * has no such signal and must fall back to time-based freshness.
 *
 * Counted rather than a flag: a host can have more than one mount holding a
 * stream to it, and it stays covered until the last one closes.
 */
const openStreamsByHost = new Map<string, number>();

export function markWorktreeChangedStreamOpen(hostId: string): void {
  openStreamsByHost.set(hostId, (openStreamsByHost.get(hostId) ?? 0) + 1);
}

export function markWorktreeChangedStreamClosed(hostId: string): void {
  const open = openStreamsByHost.get(hostId) ?? 0;
  if (open <= 1) openStreamsByHost.delete(hostId);
  else openStreamsByHost.set(hostId, open - 1);
}

export function isWorktreeChangedStreamOpen(hostId: string | null): boolean {
  return hostId !== null && (openStreamsByHost.get(hostId) ?? 0) > 0;
}

/** Test-only. */
export function resetWorktreeChangedCoverageForTests(): void {
  openStreamsByHost.clear();
}
