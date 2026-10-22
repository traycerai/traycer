import { useCallback, useSyncExternalStore } from "react";
import { chatSessionActivity } from "@/hooks/epic/use-epic-activity-status";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { reconcileStoreSubscriptions } from "@/lib/registries/reconcile-store-subscriptions";
import {
  getEpicAgentActivity,
  useAgentActivityStore,
} from "@/stores/agent-activity-store";
import type { ChatAccess } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import type {
  OpenEpicState,
  OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { workingEpicIdsKey } from "@/stores/use-working-epic-ids";

const CHAT_REGISTRY = getChatSessionRegistry();
const EPIC_REGISTRY = getOpenEpicRegistry();
const EMPTY_IDS: ReadonlySet<string> = new Set();
const cachedByUser = new Map<
  string,
  { key: string; ids: ReadonlySet<string> }
>();

/** A live session's owner, the viewer when the host says `role: "owner"`. */
function sessionOwnerOf(
  access: ChatAccess | null,
  userId: string,
): string | null {
  if (access === null) return null;
  return access.role === "owner" ? userId : access.ownerUserId;
}

/**
 * The owner an agent's evidence names, with the VIEWER standing in for every
 * piece of evidence that says the agent is the viewer's: a chat projection's
 * `ownedByViewer` and a live session's `role: "owner"`. A team host's
 * environment-owned chat names the environment as its owner and is still the
 * viewer's own. A terminal agent stays member-owned and answers by its owner.
 */
function knownOwnerOfAgent(
  agentId: string,
  userId: string,
  epicState: OpenEpicState | null,
  warm: readonly ChatSessionStoreHandle[],
): string | null {
  const owners = new Set<string>();
  const chat = epicState?.chats.byId[agentId];
  const chatOwner = chat?.ownedByViewer === true ? userId : chat?.userId;
  const terminalOwner = epicState?.tuiAgents.byId[agentId]?.userId;
  if (chatOwner) owners.add(chatOwner);
  if (terminalOwner) owners.add(terminalOwner);
  for (const handle of warm) {
    if (handle.chatId !== agentId) continue;
    const owner = sessionOwnerOf(handle.store.getState().access, userId);
    if (owner) owners.add(owner);
  }
  // A chat id may be shared by two owners. Ambiguous evidence must not
  // attribute a collaborator's activity to this viewer.
  return owners.size === 1 ? (owners.values().next().value ?? null) : null;
}

function ownedWarmTiers(
  userId: string,
  epicState: OpenEpicState | null,
  warm: readonly ChatSessionStoreHandle[],
  liveIds: ReadonlySet<string> | null,
): { turn: boolean; background: ReadonlySet<string> } {
  const background = new Set<string>();
  for (const handle of warm) {
    if (liveIds !== null && !liveIds.has(handle.chatId)) continue;
    const state = handle.store.getState();
    const activity = chatSessionActivity(state);
    // The shell tier can arrive before chat access hydrates. It still
    // suppresses this id's unclassified host turn; it never proves ownership.
    if (activity === "background") background.add(handle.chatId);
    if (state.access?.role !== "owner") continue;
    if (knownOwnerOfAgent(handle.chatId, userId, epicState, warm) !== userId)
      continue;
    if (activity === "turn") return { turn: true, background };
  }
  return { turn: false, background };
}

function hasOwnedTurn(
  epicId: string,
  userId: string,
  warm: readonly ChatSessionStoreHandle[],
): boolean {
  const epicState = EPIC_REGISTRY.peek(epicId)?.store.getState() ?? null;
  const liveIds =
    epicState === null
      ? null
      : new Set([...epicState.chats.allIds, ...epicState.tuiAgents.allIds]);
  const warmTiers = ownedWarmTiers(userId, epicState, warm, liveIds);
  if (warmTiers.turn) return true;
  for (const agentId of getEpicAgentActivity(epicId).turn) {
    if (liveIds !== null && !liveIds.has(agentId)) continue;
    if (warmTiers.background.has(agentId)) continue;
    if (knownOwnerOfAgent(agentId, userId, epicState, warm) === userId)
      return true;
  }
  return false;
}

function rememberSnapshot(
  userId: string,
  ids: ReadonlySet<string>,
): ReadonlySet<string> {
  const key = workingEpicIdsKey(ids);
  const cached = cachedByUser.get(userId);
  if (cached?.key === key) return cached.ids;
  cachedByUser.delete(userId);
  cachedByUser.set(userId, { key, ids });
  if (cachedByUser.size > 4) {
    const oldest = cachedByUser.keys().next().value;
    if (oldest !== undefined) cachedByUser.delete(oldest);
  }
  return ids;
}

/**
 * The activity stream names agent ids, not owners. A warm record or session
 * must prove ownership before an active turn can move this viewer's History.
 * Unknown agents wait for the durable owner-scoped Recent key.
 */
function ownTurnEpicIdsSnapshot(userId: string | null): ReadonlySet<string> {
  if (userId === null) return EMPTY_IDS;
  const warm = CHAT_REGISTRY.listHandles();
  const warmByEpic = new Map<string, ChatSessionStoreHandle[]>();
  const candidates = new Set<string>();
  for (const host of useAgentActivityStore.getState().byHost.values()) {
    for (const epicId of host.byEpic.keys()) candidates.add(epicId);
  }
  for (const handle of warm) {
    candidates.add(handle.epicId);
    const handles = warmByEpic.get(handle.epicId) ?? [];
    handles.push(handle);
    warmByEpic.set(handle.epicId, handles);
  }
  for (const handle of EPIC_REGISTRY.liveHandles()) {
    candidates.add(handle.epicId);
  }

  const ids = new Set<string>();
  for (const epicId of candidates) {
    if (hasOwnedTurn(epicId, userId, warmByEpic.get(epicId) ?? []))
      ids.add(epicId);
  }
  return rememberSnapshot(userId, ids);
}

function subscribeOwnTurnEpicIds(
  userId: string | null,
  onChange: () => void,
): () => void {
  if (userId === null) return () => undefined;
  let previousKey = workingEpicIdsKey(ownTurnEpicIdsSnapshot(userId));
  const chatSubscriptions = new Map<ChatSessionStoreHandle, () => void>();
  const epicSubscriptions = new Map<OpenEpicStoreHandle, () => void>();
  const emitIfChanged = (): void => {
    const nextKey = workingEpicIdsKey(ownTurnEpicIdsSnapshot(userId));
    if (nextKey === previousKey) return;
    previousKey = nextKey;
    onChange();
  };
  const resyncChats = (): void => {
    reconcileStoreSubscriptions(
      CHAT_REGISTRY.listHandles(),
      chatSubscriptions,
      (handle) =>
        handle.store.subscribe((state, previous) => {
          if (
            state.access?.ownerUserId !== previous.access?.ownerUserId ||
            state.access?.role !== previous.access?.role ||
            chatSessionActivity(state) !== chatSessionActivity(previous)
          ) {
            emitIfChanged();
          }
        }),
    );
    emitIfChanged();
  };
  const resyncEpics = (): void => {
    reconcileStoreSubscriptions(
      EPIC_REGISTRY.liveHandles(),
      epicSubscriptions,
      (handle) =>
        handle.store.subscribe((state, previous) => {
          if (
            state.chats !== previous.chats ||
            state.tuiAgents !== previous.tuiAgents
          ) {
            emitIfChanged();
          }
        }),
    );
    emitIfChanged();
  };
  const unsubscribeActivity = useAgentActivityStore.subscribe(emitIfChanged);
  const unsubscribeChats = CHAT_REGISTRY.subscribe(resyncChats);
  const unsubscribeEpics = EPIC_REGISTRY.subscribe(resyncEpics);
  resyncChats();
  resyncEpics();
  return () => {
    unsubscribeActivity();
    unsubscribeChats();
    unsubscribeEpics();
    for (const unsubscribe of chatSubscriptions.values()) unsubscribe();
    for (const unsubscribe of epicSubscriptions.values()) unsubscribe();
  };
}

/** Viewer-owned turns only, for History's owner-scoped optimistic projection. */
export function useOwnTurnEpicIds(userId: string | null): ReadonlySet<string> {
  const subscribe = useCallback(
    (onChange: () => void) => subscribeOwnTurnEpicIds(userId, onChange),
    [userId],
  );
  const getSnapshot = useCallback(
    () => ownTurnEpicIdsSnapshot(userId),
    [userId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_IDS);
}
