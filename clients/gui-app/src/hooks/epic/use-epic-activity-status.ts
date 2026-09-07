import { useCallback, useSyncExternalStore } from "react";
import {
  useRegisteredEpicAgentActivityTiers,
  useRegisteredEpicLiveAgentIds,
  type AgentActivityTier,
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
 * Warm-session only for managed commands. A cold chat falls back to host-published activity, which does not know shells exist.
 */
export function useEpicActivityStatus(
  epicId: string | null,
): EpicActivityStatus {
  const activityTiers = useRegisteredEpicAgentActivityTiers(epicId);
  const liveAgentIds = useRegisteredEpicLiveAgentIds(epicId);
  const subscribeLocalChatActivity = useCallback(
    (onChange: () => void) =>
      subscribeChatSessionActivity(epicId, liveAgentIds, onChange),
    [epicId, liveAgentIds],
  );
  const getLocalChatActivity = useCallback(
    () => getChatSessionActivity(epicId, activityTiers, liveAgentIds),
    [activityTiers, epicId, liveAgentIds],
  );
  return useSyncExternalStore(
    subscribeLocalChatActivity,
    getLocalChatActivity,
    () => "idle" as const,
  );
}

/**
 * Local turn/background is never overridden. Idle sessions still defer to presence. null candidateIds skips the liveness filter; empty set means no agents.
 */
function getChatSessionActivity(
  epicId: string | null,
  activityTiers: ReadonlyMap<string, AgentActivityTier>,
  candidateIds: ReadonlySet<string> | null,
): EpicActivityStatus {
  if (epicId === null) return "idle";
  let hasBackgroundActivity = false;
  const locallyResolvedAgentIds = new Set<string>();
  if (candidateIds !== null) {
    for (const handle of CHAT_REGISTRY.listHandles()) {
      if (handle.epicId !== epicId) continue;
      if (!candidateIds.has(handle.chatId)) continue;
      const activity = chatSessionActivity(handle.store.getState());
      if (activity === "turn") return "turn";
      if (activity === "background") {
        hasBackgroundActivity = true;
        locallyResolvedAgentIds.add(handle.chatId);
      }
    }
  }
  for (const [agentId, tier] of activityTiers) {
    if (candidateIds !== null && !candidateIds.has(agentId)) continue;
    if (locallyResolvedAgentIds.has(agentId)) continue;
    if (tier === "turn") return "turn";
    hasBackgroundActivity = true;
  }
  return hasBackgroundActivity ? "background" : "idle";
}

/** Subscribes only to live chats in `candidateIds` belonging to this epic. */
function subscribeChatSessionActivity(
  epicId: string | null,
  candidateIds: ReadonlySet<string> | null,
  onChange: () => void,
): () => void {
  if (epicId === null || candidateIds === null || candidateIds.size === 0) {
    return noopUnsubscribe;
  }
  const handleSubs = new Map<ChatSessionStoreHandle, () => void>();

  const resync = (): void => {
    reconcileStoreSubscriptions(
      CHAT_REGISTRY.listHandles().filter(
        (handle) => handle.epicId === epicId && candidateIds.has(handle.chatId),
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

function chatSessionActivity(state: ChatSessionState): ChatActivityIndicator {
  return chatActivityIndicator(state);
}

function noopUnsubscribe(): void {}
