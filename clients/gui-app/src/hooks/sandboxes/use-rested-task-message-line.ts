import { useCallback, useSyncExternalStore } from "react";
import { useChatSandboxState } from "@/hooks/sandboxes/use-chat-sandbox-state";
import { isEmptyLandingDraftContent } from "@/lib/composer/landing-draft-empty";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { returnedSandboxFor } from "@/lib/sandboxes/returned-sandbox";
import { restedTaskMessageLine } from "@/lib/sandboxes/sandbox-strings";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";

/** False until the task's snapshot has loaded: chats not read yet are not none. */
function useTaskHasNoChats(epicId: string): boolean {
  const handle = getOpenEpicRegistry().get(epicId);
  const subscribe = useCallback(
    (listener: () => void) =>
      handle === null ? () => undefined : handle.store.subscribe(listener),
    [handle],
  );
  const getSnapshot = useCallback((): boolean => {
    if (handle === null) return false;
    const { snapshotLoaded, chats } = handle.store.getState();
    return snapshotLoaded && chats.allIds.length === 0;
  }, [handle]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * The line for a task with no chat whose message came back to its own
 * composer, on a sandbox that rests: that composer is not on screen, so the
 * task has to say where the message is. Derived, not recorded, so it holds
 * across a reload. Only a give-back writes a draft's returned sandbox, and a
 * pick or a send drops it, so a typed draft never reads as one.
 */
export function useRestedTaskMessageLine(epicId: string): string | null {
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const hostId = useNewConversationModalStore((state) => {
    const draft = state.draftPatchesByEpicId[epicId];
    if (
      draft === undefined ||
      draft.content === null ||
      isEmptyLandingDraftContent(draft.content)
    )
      return null;
    const returned = returnedSandboxFor(draft.returnedSandbox ?? null, userId);
    return returned?.target.kind === "existing" ? returned.target.hostId : null;
  });
  const noChats = useTaskHasNoChats(epicId);
  const state = useChatSandboxState(epicId, noChats ? hostId : null, false);
  if (
    state.kind !== "resting" ||
    (state.sandbox.state !== "suspended" && state.sandbox.state !== "stopped")
  )
    return null;
  return restedTaskMessageLine(
    state.sandbox.displayName,
    state.sandbox.state === "stopped",
  );
}
