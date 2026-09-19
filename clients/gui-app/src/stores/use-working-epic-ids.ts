import { useSyncExternalStore } from "react";
import { chatSessionActivity } from "@/hooks/epic/use-epic-activity-status";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import { reconcileStoreSubscriptions } from "@/lib/registries/reconcile-store-subscriptions";
import { useAgentActivityStore } from "@/stores/agent-activity-store";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";

const CHAT_REGISTRY = getChatSessionRegistry();
const EMPTY_WORKING_EPIC_IDS: ReadonlySet<string> = new Set<string>();
let cachedWorkingEpicIds: {
  readonly key: string;
  readonly ids: ReadonlySet<string>;
} = { key: "", ids: EMPTY_WORKING_EPIC_IDS };

/** Content identity used to suppress notifications for activity-frame churn. */
export function workingEpicIdsKey(ids: ReadonlySet<string>): string {
  return [...ids].sort().join("\u0000");
}

function getWorkingEpicIdsSnapshot(): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const host of useAgentActivityStore.getState().byHost.values()) {
    for (const [epicId, activity] of host.byEpic) {
      if (activity.working.size > 0) ids.add(epicId);
    }
  }
  for (const handle of CHAT_REGISTRY.listHandles()) {
    if (chatSessionActivity(handle.store.getState()) !== null) {
      ids.add(handle.epicId);
    }
  }
  const key = workingEpicIdsKey(ids);
  if (key === cachedWorkingEpicIds.key) return cachedWorkingEpicIds.ids;
  cachedWorkingEpicIds = { key, ids };
  return ids;
}

function subscribeWorkingEpicIds(onChange: () => void): () => void {
  let previousKey = workingEpicIdsKey(getWorkingEpicIdsSnapshot());
  const handleSubscriptions = new Map<ChatSessionStoreHandle, () => void>();
  const emitIfChanged = (): void => {
    const nextKey = workingEpicIdsKey(getWorkingEpicIdsSnapshot());
    if (nextKey === previousKey) return;
    previousKey = nextKey;
    onChange();
  };
  const resyncChatSubscriptions = (): void => {
    reconcileStoreSubscriptions(
      CHAT_REGISTRY.listHandles(),
      handleSubscriptions,
      (handle) => handle.store.subscribe(emitIfChanged),
    );
    emitIfChanged();
  };
  const unsubscribeActivity = useAgentActivityStore.subscribe(emitIfChanged);
  const unsubscribeRegistry = CHAT_REGISTRY.subscribe(resyncChatSubscriptions);
  resyncChatSubscriptions();
  return () => {
    unsubscribeActivity();
    unsubscribeRegistry();
    for (const unsubscribe of handleSubscriptions.values()) unsubscribe();
    handleSubscriptions.clear();
  };
}

/** Host-published working epics unioned with activity in warm chat sessions. */
export function useWorkingEpicIds(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribeWorkingEpicIds,
    getWorkingEpicIdsSnapshot,
    () => EMPTY_WORKING_EPIC_IDS,
  );
}
