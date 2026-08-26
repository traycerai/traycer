import { createContext, use } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { ChatCollapsibleKey } from "@/components/chat/chat-collapsible-key";
import { serializeChatCollapsibleKey } from "@/components/chat/chat-collapsible-key";
import { updateOpenIds } from "@/stores/chats/open-id-set";

export interface ChatFindForceState {
  readonly forcedKeyIds: ReadonlySet<string>;
  readonly activeTarget: ChatFindActiveTarget | null;
  /** Interview paging dismissed the current find override for this key. */
  readonly manuallyOverriddenKeyIds: ReadonlySet<string>;
  /** Monotonic local signal for controller-owned highlight dismissal. */
  readonly activeTargetClearEpoch: number;
  readonly setForcedOpen: (key: ChatCollapsibleKey, open: boolean) => void;
  readonly setActiveTarget: (target: ChatFindActiveTarget | null) => void;
  readonly reconcileActiveTarget: (target: ChatFindActiveTarget | null) => void;
  readonly clearActiveTarget: (key: ChatCollapsibleKey) => void;
}

export interface ChatFindActiveTarget {
  readonly key: ChatCollapsibleKey;
  readonly unitId: string;
}

export function createChatFindForceStore(): StoreApi<ChatFindForceState> {
  return createStore<ChatFindForceState>((set) => ({
    forcedKeyIds: new Set<string>(),
    activeTarget: null,
    manuallyOverriddenKeyIds: new Set<string>(),
    activeTargetClearEpoch: 0,
    setForcedOpen: (key, open) =>
      set((state) => {
        const serializedKey = serializeChatCollapsibleKey(key);
        const forcedKeyIds = updateOpenIds(
          state.forcedKeyIds,
          serializedKey,
          open,
        );
        if (forcedKeyIds === state.forcedKeyIds) return state;
        return { forcedKeyIds };
      }),
    setActiveTarget: (target) =>
      set((state) => {
        const manuallyOverriddenKeyIds =
          target === null
            ? new Set<string>()
            : updateOpenIds(
                state.manuallyOverriddenKeyIds,
                serializeChatCollapsibleKey(target.key),
                false,
              );
        if (
          state.activeTarget?.unitId === target?.unitId &&
          state.activeTarget !== null &&
          target !== null &&
          serializeChatCollapsibleKey(state.activeTarget.key) ===
            serializeChatCollapsibleKey(target.key) &&
          manuallyOverriddenKeyIds === state.manuallyOverriddenKeyIds
        ) {
          return state;
        }
        if (
          state.activeTarget === null &&
          target === null &&
          manuallyOverriddenKeyIds === state.manuallyOverriddenKeyIds
        ) {
          return state;
        }
        return { activeTarget: target, manuallyOverriddenKeyIds };
      }),
    reconcileActiveTarget: (target) =>
      set((state) => {
        if (target === null) {
          if (state.activeTarget === null) return state;
          return { activeTarget: null };
        }
        if (
          state.manuallyOverriddenKeyIds.has(
            serializeChatCollapsibleKey(target.key),
          )
        ) {
          return state;
        }
        if (
          state.activeTarget?.unitId === target.unitId &&
          serializeChatCollapsibleKey(state.activeTarget.key) ===
            serializeChatCollapsibleKey(target.key)
        ) {
          return state;
        }
        return { activeTarget: target };
      }),
    clearActiveTarget: (key) =>
      set((state) => {
        const target = state.activeTarget;
        if (
          target === null ||
          serializeChatCollapsibleKey(target.key) !==
            serializeChatCollapsibleKey(key)
        ) {
          return state;
        }
        return {
          activeTarget: null,
          manuallyOverriddenKeyIds: updateOpenIds(
            state.manuallyOverriddenKeyIds,
            serializeChatCollapsibleKey(key),
            true,
          ),
          activeTargetClearEpoch: state.activeTargetClearEpoch + 1,
        };
      }),
  }));
}

export const ChatFindForceStoreContext =
  createContext<StoreApi<ChatFindForceState> | null>(null);

export const ChatFindForceTileInstanceIdContext = createContext<string | null>(
  null,
);

function useChatFindForceStoreFromContext(): StoreApi<ChatFindForceState> {
  const store = use(ChatFindForceStoreContext);
  if (store === null) {
    throw new Error(
      "chat find-force store hook used outside ChatFindForceStoreProvider",
    );
  }
  return store;
}

export function useChatCollapsibleTileInstanceId(): string {
  const tileInstanceId = use(ChatFindForceTileInstanceIdContext);
  if (tileInstanceId === null) {
    throw new Error(
      "chat collapsible key hook used outside ChatFindForceStoreProvider",
    );
  }
  return tileInstanceId;
}

export function useChatFindForcedOpen(key: ChatCollapsibleKey): boolean {
  const store = useChatFindForceStoreFromContext();
  const serializedKey = serializeChatCollapsibleKey(key);
  return useStore(store, (state) => state.forcedKeyIds.has(serializedKey));
}

export function useSetChatFindForcedOpen(): (
  key: ChatCollapsibleKey,
  open: boolean,
) => void {
  const store = useChatFindForceStoreFromContext();
  return store.getState().setForcedOpen;
}

export function useChatFindActiveTargetUnitId(
  key: ChatCollapsibleKey,
): string | null {
  const store = useChatFindForceStoreFromContext();
  const serializedKey = serializeChatCollapsibleKey(key);
  return useStore(store, (state) => {
    const target = state.activeTarget;
    if (target === null) return null;
    return serializeChatCollapsibleKey(target.key) === serializedKey
      ? target.unitId
      : null;
  });
}

export function useSetChatFindActiveTarget(): (
  target: ChatFindActiveTarget | null,
) => void {
  const store = useChatFindForceStoreFromContext();
  return store.getState().setActiveTarget;
}

export function useReconcileChatFindActiveTarget(): (
  target: ChatFindActiveTarget | null,
) => void {
  const store = useChatFindForceStoreFromContext();
  return store.getState().reconcileActiveTarget;
}

export function useClearChatFindActiveTarget(): (
  key: ChatCollapsibleKey,
) => void {
  const store = useChatFindForceStoreFromContext();
  return store.getState().clearActiveTarget;
}

/**
 * The controller owns CSS Highlight ranges and find snapshots. A card emits
 * this tile-local epoch only for a user dismissal of its current target, so
 * the controller can clear those resources without closing the query.
 */
export function useChatFindActiveTargetClearEpoch(): number {
  const store = useChatFindForceStoreFromContext();
  return useStore(store, (state) => state.activeTargetClearEpoch);
}
