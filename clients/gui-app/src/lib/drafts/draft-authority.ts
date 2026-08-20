/**
 * A draft owned by another host, or demoted to a replica after claim
 * elsewhere, is read-only until `drafts.claim` through this tab's host.
 */
export function draftRequiresClaim(
  ownerHostId: string | null,
  origin: "own" | "replica" | null,
  tabHostId: string,
): boolean {
  if (origin === "replica") return true;
  if (ownerHostId === null) return false;
  return ownerHostId !== tabHostId;
}
