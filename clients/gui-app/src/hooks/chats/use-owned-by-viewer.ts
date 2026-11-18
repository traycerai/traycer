import { useCallback } from "react";
import { useMaybeEpicStore } from "@/hooks/use-epic-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { OpenEpicState } from "@/stores/epics/open-epic/store";

/**
 * Whether a chat belongs to the signed-in user, given whatever owner the
 * calling surface managed to resolve.
 *
 * **The projection answers first.** When the open epic holds this chat under
 * the same owner, its `ownedByViewer` is the answer, so a team host's
 * environment-owned chat - whose owner is the environment, not the viewer - is
 * not called a collaborator's. Without a projected row the owner is compared
 * with the viewer.
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
export function useOwnedByViewer(
  ownerUserId: string | null,
  chatId: string,
): boolean {
  const viewerUserId = useAuthStore(
    (state) => state.contextMetadata?.userId ?? null,
  );
  const projectedOwnedByViewer = useMaybeEpicStore(
    useCallback(
      (state: OpenEpicState): boolean | null => {
        if (!Object.hasOwn(state.chats.byId, chatId)) return null;
        const chat = state.chats.byId[chatId];
        // The slice is keyed by `chatId` alone: a row under another owner is
        // a different chat and says nothing about this one.
        return chat.userId === ownerUserId ? chat.ownedByViewer : null;
      },
      [chatId, ownerUserId],
    ),
    null,
  );
  if (projectedOwnedByViewer === true) return true;
  if (ownerUserId === null || ownerUserId.length === 0) {
    return true;
  }
  if (viewerUserId === null) {
    return true;
  }
  return ownerUserId === viewerUserId;
}
