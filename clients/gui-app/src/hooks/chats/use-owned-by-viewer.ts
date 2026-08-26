import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Whether a chat belongs to the signed-in user, given whatever owner the
 * calling surface managed to resolve.
 *
 * **Only a positive mismatch flips it.** An unresolved owner (`null`, or the
 * empty string a ref minted before `ownerUserId` was recorded carries) and an
 * identity mid-refresh both stay on the own-chat answer, which is the
 * vocabulary every one of these surfaces had before collaborators existed.
 * The alternative - treating "unknown" as foreign - would tell a user their
 * OWN agent belongs to someone else during a hydration frame, which is worse
 * than the transient own-chat copy this returns.
 *
 * Shared by the dead-tile banner's container and the published tile so the
 * banner and the footer sentence under it can never disagree about who owns
 * the chat they are both describing.
 */
export function useOwnedByViewer(ownerUserId: string | null): boolean {
  const viewerUserId = useAuthStore(
    (state) => state.contextMetadata?.userId ?? null,
  );
  if (ownerUserId === null || ownerUserId.length === 0) {
    return true;
  }
  if (viewerUserId === null) {
    return true;
  }
  return ownerUserId === viewerUserId;
}
