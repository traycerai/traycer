import { useCallback, useSyncExternalStore } from "react";
import {
  useRegisteredEpicActiveAgentIds,
  useRegisteredEpicLiveAgentIds,
} from "@/lib/epic-selectors";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import { reconcileStoreSubscriptions } from "@/lib/registries/reconcile-store-subscriptions";
import {
  type ChatSessionState,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import {
  chatActivityIndicator,
  type ChatActivityIndicator,
} from "@/components/epic-canvas/renderers/chat-tile-session-state";

const CHAT_REGISTRY = getChatSessionRegistry();

export type EpicActivityStatus = "idle" | "turn" | "background";

/**
 * Aggregates this epic's live chat sessions into the activity tier rendered
 * by task-level surfaces. A turn wins over background work across chats.
 */
export function useEpicActivityStatus(
  epicId: string | null,
): EpicActivityStatus {
  const activeAgentIds = useRegisteredEpicActiveAgentIds(epicId);
  const liveAgentIds = useRegisteredEpicLiveAgentIds(epicId);
  const subscribeLocalChatActivity = useCallback(
    (onChange: () => void) =>
      subscribeEpicChatSessionActivity(epicId, liveAgentIds, onChange),
    [epicId, liveAgentIds],
  );
  const getLocalChatActivity = useCallback(
    () => getEpicChatSessionActivity(epicId, activeAgentIds, liveAgentIds),
    [activeAgentIds, epicId, liveAgentIds],
  );
  return useSyncExternalStore(
    subscribeLocalChatActivity,
    getLocalChatActivity,
    () => "idle" as const,
  );
}

/**
 * Reads session activity first, then conservatively treats an unresolved
 * awareness signal as a turn while its chat subscription catches up.
 */
function getEpicChatSessionActivity(
  epicId: string | null,
  activeAgentIds: ReadonlySet<string>,
  liveAgentIds: ReadonlySet<string>,
): EpicActivityStatus {
  if (epicId === null) return "idle";
  let hasBackgroundActivity = false;
  const locallyResolvedAgentIds = new Set<string>();
  for (const handle of CHAT_REGISTRY.listHandles()) {
    if (handle.epicId !== epicId) continue;
    if (!liveAgentIds.has(handle.chatId)) continue;
    const activity = chatSessionActivity(handle.store.getState());
    if (activity === "turn") return "turn";
    if (activity === "background") {
      hasBackgroundActivity = true;
      locallyResolvedAgentIds.add(handle.chatId);
    }
  }
  const hasUnresolvedActiveAgent = [...activeAgentIds].some(
    (id) => liveAgentIds.has(id) && !locallyResolvedAgentIds.has(id),
  );
  if (hasUnresolvedActiveAgent) return "turn";
  return hasBackgroundActivity ? "background" : "idle";
}

/** Subscribes only to live chats belonging to this epic. */
function subscribeEpicChatSessionActivity(
  epicId: string | null,
  liveAgentIds: ReadonlySet<string>,
  onChange: () => void,
): () => void {
  if (epicId === null) return noopUnsubscribe;
  const handleSubs = new Map<ChatSessionStoreHandle, () => void>();

  const resync = (): void => {
    reconcileStoreSubscriptions(
      CHAT_REGISTRY.listHandles().filter(
        (handle) => handle.epicId === epicId && liveAgentIds.has(handle.chatId),
      ),
      handleSubs,
      (handle) => {
        let previousActivity = chatSessionActivity(handle.store.getState());
        return handle.store.subscribe((state) => {
          const nextActivity = chatSessionActivity(state);
          if (nextActivity === previousActivity) return;
          previousActivity = nextActivity;
          onChange();
        });
      },
    );
    onChange();
  };

  const unsubscribeRegistry = CHAT_REGISTRY.subscribe(resync);
  resync();

  return () => {
    unsubscribeRegistry();
    for (const unsubscribe of handleSubs.values()) unsubscribe();
    handleSubs.clear();
  };
}

/** Projects the chat session's indicator tier for task-level aggregation. */
function chatSessionActivity(state: ChatSessionState): ChatActivityIndicator {
  return chatActivityIndicator(state);
}

function noopUnsubscribe(): void {}
