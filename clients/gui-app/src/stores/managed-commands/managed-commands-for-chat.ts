import { useCallback, useMemo, useSyncExternalStore } from "react";
import { create, useStore } from "zustand";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import {
  getChatSessionRegistry,
  useExistingChatSessionHandle,
} from "@/lib/registries/chat-session-registry";
import { reconcileStoreSubscriptions } from "@/lib/registries/reconcile-store-subscriptions";
import type {
  ChatSessionState,
  ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";

/**
 * The read side of the Shells surface for one chat.
 *
 * The set rides that chat's own `chat.subscribe` stream, so these hooks are
 * projections of the chat session store rather than a stream of their own.
 * Every surface that reads them is chat-scoped - the chat tile's menu and the
 * chat's Background panel - and reading through the chat session binds them to
 * the tab's host the way every other chat surface is bound.
 *
 * Empty means empty: a host too old to serve the field has no managed-command
 * subsystem, so it owns no commands. There is no "unavailable" state to
 * distinguish, and these hooks never return `null` for "not answered yet" - a
 * chat that has not received its snapshot has nothing to show either way.
 */

type ManagedCommandsChatSlice = Pick<
  ChatSessionState,
  "managedCommands" | "connectionStatus"
>;

// Stable stand-in for a chat with no live session (its tile is not mounted, or
// the snapshot has yet to land): no commands, and a stream still connecting.
const emptyChatSlice = create<ManagedCommandsChatSlice>()(() => ({
  managedCommands: [],
  connectionStatus: "connecting",
}));

function useChatSliceStore(epicId: string, chatId: string) {
  const handle = useExistingChatSessionHandle(epicId, chatId);
  return handle === null ? emptyChatSlice : handle.store;
}

/**
 * Running first, then most recent activity. A command that is doing something
 * now outranks one that finished a second ago, which is what a human scanning
 * for "what is live" is looking for.
 */
function compareManagedCommands(a: ManagedCommand, b: ManagedCommand): number {
  const aRunning = a.status.state === "running";
  const bRunning = b.status.state === "running";
  if (aRunning !== bRunning) return aRunning ? -1 : 1;
  return b.updatedAtMs - a.updatedAtMs;
}

/**
 * Every command this chat owns, whatever state it is in - the menu's list. The
 * ordering is applied once here so every reader shares it; the host sends the
 * set whole, so the sorted array only changes when the set does.
 */
export function useManagedCommandsForChat(
  epicId: string,
  chatId: string,
): readonly ManagedCommand[] {
  const commands = useStore(
    useChatSliceStore(epicId, chatId),
    (state) => state.managedCommands,
  );
  return useMemo(() => [...commands].sort(compareManagedCommands), [commands]);
}

/**
 * The subset of {@link useManagedCommandsForChat} that is live right now - what
 * the chat's Background panel lists, since that panel is about work happening
 * at this moment rather than about the commands as durable objects.
 */
export function useRunningManagedCommandsForChat(
  epicId: string,
  chatId: string,
): readonly ManagedCommand[] {
  const commands = useManagedCommandsForChat(epicId, chatId);
  return useMemo(
    () => commands.filter((command) => command.status.state === "running"),
    [commands],
  );
}

/**
 * The chat stream's connection status, which is now also the commands' - they
 * arrive on it. A menu held open across a dropped connection says its rows may
 * be stale rather than silently freezing them.
 */
export function useManagedCommandsConnectionStatus(
  epicId: string,
  chatId: string,
): StreamConnectionStatus {
  return useStore(
    useChatSliceStore(epicId, chatId),
    (state) => state.connectionStatus,
  );
}

/**
 * One command by id, found across the epic's live chat sessions - the output
 * window's tab title, which holds a command pointer and no chat id.
 *
 * A command id is unique within an epic, so the scan cannot be ambiguous; it is
 * a scan rather than an index because an epic's live sessions are a handful and
 * the alternative is a second source of truth to keep in step. `null` when the
 * owning chat has no live session (never opened this window's chat, or its
 * session went idle), which is the window's pre-hydration state - the tab falls
 * back to its persisted name until the chat is opened.
 */
export function useManagedCommandInEpic(
  epicId: string,
  commandId: string,
): ManagedCommand | null {
  const subscribe = useCallback(
    (onChange: () => void) =>
      subscribeEpicManagedCommands(epicId, commandId, onChange),
    [epicId, commandId],
  );
  const getSnapshot = useCallback(
    () => findManagedCommandInEpic(epicId, commandId),
    [epicId, commandId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

/**
 * Stable across calls while nothing changes: the host sends the set whole, so
 * the array - and the record inside it - keeps its identity until a new frame
 * replaces it. That is what lets `useSyncExternalStore` read this directly.
 */
function findManagedCommandInEpic(
  epicId: string,
  commandId: string,
): ManagedCommand | null {
  if (commandId.length === 0) return null;
  for (const handle of getChatSessionRegistry().listHandles()) {
    if (handle.epicId !== epicId) continue;
    const found = handle.store
      .getState()
      .managedCommands.find((command) => command.id === commandId);
    if (found !== undefined) return found;
  }
  return null;
}

/**
 * The registry is read at call time, never as a module constant: this module is
 * reached from `epic-selectors`, which the registry itself imports, so a
 * top-level read would run inside that import cycle before it exists.
 */
function subscribeEpicManagedCommands(
  epicId: string,
  commandId: string,
  onChange: () => void,
): () => void {
  if (commandId.length === 0) return noopUnsubscribe;
  const handleSubs = new Map<ChatSessionStoreHandle, () => void>();

  const resync = (): void => {
    reconcileStoreSubscriptions(
      getChatSessionRegistry()
        .listHandles()
        .filter((handle) => handle.epicId === epicId),
      handleSubs,
      (handle) =>
        handle.store.subscribe((state, previousState) => {
          if (state.managedCommands === previousState.managedCommands) return;
          onChange();
        }),
    );
    onChange();
  };

  const unsubscribeRegistry = getChatSessionRegistry().subscribe(resync);
  resync();

  return () => {
    unsubscribeRegistry();
    for (const unsubscribe of handleSubs.values()) unsubscribe();
    handleSubs.clear();
  };
}

function noopUnsubscribe(): void {}
