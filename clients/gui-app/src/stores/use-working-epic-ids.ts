import { useSyncExternalStore } from "react";
import { agentActivityTiers } from "@/lib/agent-activity";
import {
  chatSessionActivity,
  epicActivityStatusFromSources,
  type EpicActivityStatus,
} from "@/hooks/epic/use-epic-activity-status";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { reconcileStoreSubscriptions } from "@/lib/registries/reconcile-store-subscriptions";
import {
  getEpicAgentActivity,
  useAgentActivityStore,
} from "@/stores/agent-activity-store";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";

const CHAT_REGISTRY = getChatSessionRegistry();
const EPIC_REGISTRY = getOpenEpicRegistry();
const EMPTY_WORKING_EPIC_IDS: ReadonlySet<string> = new Set<string>();

/**
 * Which epics count: `"any"` is every epic with activity of either tier, and
 * `"turn"` only epics with an agent turn in progress - a background shell or
 * monitor alone does not qualify.
 */
type WorkingEpicTier = "any" | "turn";

interface CachedWorkingEpicIds {
  readonly key: string;
  readonly ids: ReadonlySet<string>;
}

const cachedWorkingEpicIds: Record<WorkingEpicTier, CachedWorkingEpicIds> = {
  any: { key: "", ids: EMPTY_WORKING_EPIC_IDS },
  turn: { key: "", ids: EMPTY_WORKING_EPIC_IDS },
};

/** Content identity used to suppress notifications for activity-frame churn. */
export function workingEpicIdsKey(ids: ReadonlySet<string>): string {
  return [...ids].sort().join("\u0000");
}

function countsAsWorking(
  status: EpicActivityStatus,
  tier: WorkingEpicTier,
): boolean {
  return tier === "turn" ? status === "turn" : status !== "idle";
}

function workingEpicIdsSnapshot(tier: WorkingEpicTier): ReadonlySet<string> {
  const candidateEpicIds = new Set<string>();
  for (const host of useAgentActivityStore.getState().byHost.values()) {
    for (const epicId of host.byEpic.keys()) candidateEpicIds.add(epicId);
  }
  for (const handle of CHAT_REGISTRY.listHandles()) {
    candidateEpicIds.add(handle.epicId);
  }
  for (const handle of EPIC_REGISTRY.liveHandles()) {
    candidateEpicIds.add(handle.epicId);
  }
  const ids = new Set<string>();
  for (const epicId of candidateEpicIds) {
    const activity = epicActivityStatusFromSources(
      epicId,
      agentActivityTiers(getEpicAgentActivity(epicId)),
      liveAgentIdsForEpic(epicId),
    );
    if (countsAsWorking(activity, tier)) ids.add(epicId);
  }
  const key = workingEpicIdsKey(ids);
  if (key === cachedWorkingEpicIds[tier].key) {
    return cachedWorkingEpicIds[tier].ids;
  }
  cachedWorkingEpicIds[tier] = { key, ids };
  return ids;
}

function getWorkingEpicIdsSnapshot(): ReadonlySet<string> {
  return workingEpicIdsSnapshot("any");
}

function getTurnEpicIdsSnapshot(): ReadonlySet<string> {
  return workingEpicIdsSnapshot("turn");
}

function subscribeWorkingEpicIds(onChange: () => void): () => void {
  return subscribeWorkingEpicIdsForTier("any", onChange);
}

function subscribeTurnEpicIds(onChange: () => void): () => void {
  return subscribeWorkingEpicIdsForTier("turn", onChange);
}

function subscribeWorkingEpicIdsForTier(
  tier: WorkingEpicTier,
  onChange: () => void,
): () => void {
  let previousKey = workingEpicIdsKey(workingEpicIdsSnapshot(tier));
  const chatSubscriptions = new Map<ChatSessionStoreHandle, () => void>();
  const epicSubscriptions = new Map<OpenEpicStoreHandle, () => void>();
  const emitIfChanged = (): void => {
    const nextKey = workingEpicIdsKey(workingEpicIdsSnapshot(tier));
    if (nextKey === previousKey) return;
    previousKey = nextKey;
    onChange();
  };
  const resyncChatSubscriptions = (): void => {
    const handles = CHAT_REGISTRY.listHandles();
    const membershipChanged =
      handles.length !== chatSubscriptions.size ||
      handles.some((handle) => !chatSubscriptions.has(handle));
    reconcileStoreSubscriptions(handles, chatSubscriptions, (handle) =>
      handle.store.subscribe((state, previous) => {
        if (chatSessionActivity(state) !== chatSessionActivity(previous)) {
          emitIfChanged();
        }
      }),
    );
    if (membershipChanged) emitIfChanged();
  };
  const resyncEpicSubscriptions = (): void => {
    const handles = EPIC_REGISTRY.liveHandles();
    const membershipChanged =
      handles.length !== epicSubscriptions.size ||
      handles.some((handle) => !epicSubscriptions.has(handle));
    reconcileStoreSubscriptions(handles, epicSubscriptions, (handle) =>
      handle.store.subscribe((state, previous) => {
        if (
          state.chats.allIds !== previous.chats.allIds ||
          state.tuiAgents.allIds !== previous.tuiAgents.allIds
        ) {
          emitIfChanged();
        }
      }),
    );
    if (membershipChanged) emitIfChanged();
  };
  const unsubscribeActivity = useAgentActivityStore.subscribe(emitIfChanged);
  const unsubscribeChatRegistry = CHAT_REGISTRY.subscribe(
    resyncChatSubscriptions,
  );
  const unsubscribeEpicRegistry = EPIC_REGISTRY.subscribe(
    resyncEpicSubscriptions,
  );
  resyncChatSubscriptions();
  resyncEpicSubscriptions();
  return () => {
    unsubscribeActivity();
    unsubscribeChatRegistry();
    unsubscribeEpicRegistry();
    for (const unsubscribe of chatSubscriptions.values()) unsubscribe();
    for (const unsubscribe of epicSubscriptions.values()) unsubscribe();
    chatSubscriptions.clear();
    epicSubscriptions.clear();
  };
}

function liveAgentIdsForEpic(epicId: string): ReadonlySet<string> | null {
  const handle = EPIC_REGISTRY.peek(epicId);
  if (handle === null) return null;
  const state = handle.store.getState();
  return new Set([...state.chats.allIds, ...state.tuiAgents.allIds]);
}

/** Host-published working epics unioned with activity in warm chat sessions. */
export function useWorkingEpicIds(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribeWorkingEpicIds,
    getWorkingEpicIdsSnapshot,
    () => EMPTY_WORKING_EPIC_IDS,
  );
}

/**
 * Epics with an agent turn in progress. Background-only work (a shell or a
 * monitor left running with no reply streaming) is excluded, which is what the
 * phone's task lists lift to the top.
 */
export function useTurnEpicIds(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribeTurnEpicIds,
    getTurnEpicIdsSnapshot,
    () => EMPTY_WORKING_EPIC_IDS,
  );
}
