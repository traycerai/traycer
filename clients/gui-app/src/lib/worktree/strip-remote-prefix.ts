/**
 * Strips a `origin/` (or any `<remote>/`) prefix so collision detection
 * compares against local branch names. The host emits remote-only
 * refs with the full `origin/<name>` so we drop the first segment.
 */
export function stripRemotePrefix(branchName: string): string {
  const slash = branchName.indexOf("/");
  return slash === -1 ? branchName : branchName.slice(slash + 1);
}
