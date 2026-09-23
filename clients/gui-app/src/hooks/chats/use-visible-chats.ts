import { useSyncExternalStore } from "react";
import {
  getChatSessionHandleHostId,
  getChatSessionRegistry,
} from "@/lib/registries/chat-session-registry";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { reconcileStoreSubscriptions } from "@/lib/registries/reconcile-store-subscriptions";
import {
  autoModeRuleDraftWorkspace,
  type AutoModeRuleDraftWorkspace,
} from "@/lib/auto-mode/auto-mode-rule-copy";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";

/**
 * What this window can see of one chat right now, from the epic sessions and
 * chat sessions it already holds open. A surface outside any epic (Settings)
 * reads it to name a chat by its LIVE title and to narrow a drafted rule by
 * the chat's workspace, and falls back to what it was handed otherwise.
 */
export interface VisibleChat {
  /** The live title, or `null` when only the chat's session is open. */
  readonly title: string | null;
  /** The host the chat lives on, when either registry knows it. */
  readonly hostId: string | null;
  /** The remote and branch its binding records; see the rule-draft copy. */
  readonly workspace: AutoModeRuleDraftWorkspace;
}

const CHAT_REGISTRY = getChatSessionRegistry();
const EPIC_REGISTRY = getOpenEpicRegistry();
const EMPTY_VISIBLE_CHATS: ReadonlyMap<string, VisibleChat> = new Map();
const UNKNOWN_WORKSPACE: AutoModeRuleDraftWorkspace = {
  remote: null,
  branch: null,
};

let cachedVisibleChats: {
  readonly key: string;
  readonly chats: ReadonlyMap<string, VisibleChat>;
} = { key: "[]", chats: EMPTY_VISIBLE_CHATS };

function collectVisibleChats(): Map<string, VisibleChat> {
  const chats = new Map<string, VisibleChat>();
  for (const handle of EPIC_REGISTRY.liveHandles()) {
    for (const chat of Object.values(handle.store.getState().chats.byId)) {
      chats.set(chat.id, {
        title: chat.title,
        hostId: chat.hostId,
        workspace: UNKNOWN_WORKSPACE,
      });
    }
  }
  for (const handle of CHAT_REGISTRY.listHandles()) {
    const known = chats.get(handle.chatId);
    chats.set(handle.chatId, {
      title: known?.title ?? null,
      hostId: known?.hostId ?? getChatSessionHandleHostId(handle),
      workspace: autoModeRuleDraftWorkspace(
        handle.store.getState().worktreeBinding,
      ),
    });
  }
  return chats;
}

/**
 * Cached by CONTENT, so an unrelated store update returns the same map and
 * `useSyncExternalStore` does not re-render (a fresh map every read would loop).
 */
function getVisibleChatsSnapshot(): ReadonlyMap<string, VisibleChat> {
  const chats = collectVisibleChats();
  const key = JSON.stringify([...chats].sort(([a], [b]) => a.localeCompare(b)));
  if (key === cachedVisibleChats.key) return cachedVisibleChats.chats;
  cachedVisibleChats = { key, chats };
  return chats;
}

function subscribeVisibleChats(onChange: () => void): () => void {
  const chatSubscriptions = new Map<ChatSessionStoreHandle, () => void>();
  const epicSubscriptions = new Map<OpenEpicStoreHandle, () => void>();
  const syncChats = (): void => {
    reconcileStoreSubscriptions(
      CHAT_REGISTRY.listHandles(),
      chatSubscriptions,
      (handle) =>
        handle.store.subscribe((state, previous) => {
          if (state.worktreeBinding !== previous.worktreeBinding) onChange();
        }),
    );
  };
  const syncEpics = (): void => {
    reconcileStoreSubscriptions(
      EPIC_REGISTRY.liveHandles(),
      epicSubscriptions,
      (handle) =>
        handle.store.subscribe((state, previous) => {
          if (state.chats !== previous.chats) onChange();
        }),
    );
  };
  // A membership change re-reads the snapshot; the first sync does not,
  // because nothing has been read against it yet.
  const unsubscribeChatRegistry = CHAT_REGISTRY.subscribe(() => {
    syncChats();
    onChange();
  });
  const unsubscribeEpicRegistry = EPIC_REGISTRY.subscribe(() => {
    syncEpics();
    onChange();
  });
  syncChats();
  syncEpics();
  return () => {
    unsubscribeChatRegistry();
    unsubscribeEpicRegistry();
    for (const unsubscribe of chatSubscriptions.values()) unsubscribe();
    for (const unsubscribe of epicSubscriptions.values()) unsubscribe();
    chatSubscriptions.clear();
    epicSubscriptions.clear();
  };
}

/** Every chat this window holds open, keyed by chat id. */
export function useVisibleChats(): ReadonlyMap<string, VisibleChat> {
  return useSyncExternalStore(
    subscribeVisibleChats,
    getVisibleChatsSnapshot,
    () => EMPTY_VISIBLE_CHATS,
  );
}
