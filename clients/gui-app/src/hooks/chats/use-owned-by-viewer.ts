import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Only a positive owner mismatch is foreign. Unresolved owner stays own-chat so hydration does not label the viewer's agent as someone else's.
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
