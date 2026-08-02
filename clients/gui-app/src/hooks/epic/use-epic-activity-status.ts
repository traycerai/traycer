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
 * Aggregates this epic's live chat sessions into the activity tier rendered
 * by task-level surfaces. A turn wins over background work across chats.
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
 * Reads session activity across a candidate set of chat ids, falling back to
 * the host-published activity tier for agents whose session state did not
 * resolve locally. `candidateIds` scopes the aggregation: the whole epic's
 * live agents for {@link useEpicActivityStatus}, or a node's descendant ids
 * for {@link useSubtreeChatActivityTier}.
 *
 * An open chat session is authoritative for its own tier ONLY when it reads
 * some activity - a local `"turn"`/`"background"` is never overridden by the
 * global source, so the two tiers can't be re-conflated. A session reading idle
 * is deliberately NOT treated as resolved: it still defers to presence, which
 * backfills the brief subscription-gap window where a genuinely running chat's
 * store has not received its first snapshot yet (same rule as the per-chat icon
 * in `chat-progress-icon.tsx`).
 *
 * Everything else - a chat that was never opened, or one whose warm session was
 * evicted - is resolved from `activityTiers`, which reports `"turn"` for any
 * host that does not classify its agents. That keeps the pre-existing
 * conservative reading intact against an unclassified host while letting a
 * classifying one report background-only work accurately.
 *
 * `candidateIds` is a LIVENESS filter over that fallback: an agent the epic's
 * projection no longer holds must not keep a spinner alive. `null` means this
 * window has NO session for the epic, so there is no projection to check
 * against and the filter is skipped entirely - that is the never-opened epic
 * the per-user activity room exists to cover, and filtering it against an
 * empty set would put the original defect straight back. An empty SET is a
 * different statement: a live projection that authoritatively holds no agents.
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

/** Projects the chat session's indicator tier for aggregation. */
function chatSessionActivity(state: ChatSessionState): ChatActivityIndicator {
  return chatActivityIndicator(state);
}

function noopUnsubscribe(): void {}
