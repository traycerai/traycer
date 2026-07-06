import { useCallback, useSyncExternalStore } from "react";
import {
  useRegisteredEpicActiveAgentIds,
  useRegisteredEpicLiveAgentIds,
} from "@/lib/epic-selectors";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import { reconcileStoreSubscriptions } from "@/lib/registries/reconcile-store-subscriptions";
import {
  isChatRunInProgress,
  type ChatSessionState,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";

const CHAT_REGISTRY = getChatSessionRegistry();

export type EpicActivityStatus = "idle" | "running" | "waiting";

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
    () => getEpicChatSessionActivity(epicId, liveAgentIds),
    [epicId, liveAgentIds],
  );
  const localChatActivity = useSyncExternalStore(
    subscribeLocalChatActivity,
    getLocalChatActivity,
    () => "idle" as const,
  );
  if (localChatActivity === "waiting") return "waiting";
  return hasLiveActiveAgent(activeAgentIds, liveAgentIds) ||
    localChatActivity === "running"
    ? "running"
    : "idle";
}

function getEpicChatSessionActivity(
  epicId: string | null,
  liveAgentIds: ReadonlySet<string>,
): EpicActivityStatus {
  if (epicId === null) return "idle";
  let hasRunningChat = false;
  for (const handle of CHAT_REGISTRY.listHandles()) {
    if (handle.epicId !== epicId) continue;
    if (!liveAgentIds.has(handle.chatId)) continue;
    const activity = chatSessionActivity(handle.store.getState());
    if (activity === "waiting") return "waiting";
    if (activity === "running") hasRunningChat = true;
  }
  return hasRunningChat ? "running" : "idle";
}

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

function chatSessionActivity(state: ChatSessionState): EpicActivityStatus {
  if (
    state.pendingApprovals.length > 0 ||
    state.pendingFileEditApprovals.length > 0 ||
    state.pendingInterviews.length > 0
  ) {
    return "waiting";
  }
  return isChatRunInProgress(state.runStatus) ? "running" : "idle";
}

function hasLiveActiveAgent(
  activeAgentIds: ReadonlySet<string>,
  liveAgentIds: ReadonlySet<string>,
): boolean {
  return [...activeAgentIds].some((id) => liveAgentIds.has(id));
}

function noopUnsubscribe(): void {}
