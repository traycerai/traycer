import { useMemo, useSyncExternalStore } from "react";
import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import { isRunningBackgroundRoot } from "@/lib/home-focus/focus-background";
import {
  getChatSessionHandleHostId,
  getChatSessionRegistry,
} from "@/lib/registries/chat-session-registry";
import { reconcileStoreSubscriptions } from "@/lib/registries/reconcile-store-subscriptions";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";

/** One warm chat session's live background work, before task titles are
 * attached. */
export interface WarmChatBackground {
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string | null;
  readonly managedCommands: ReadonlyArray<ManagedCommand>;
  readonly backgroundItems: ReadonlyArray<BackgroundItem>;
}

const EMPTY_WARM_CHATS: ReadonlyArray<WarmChatBackground> = [];

/**
 * Every warm chat session in this window, with its running managed commands and
 * its live background items.
 *
 * MOUNTED ONLY, and irreducibly so: both lists ride the chat's own
 * `chat.subscribe` stream, so a shell in a chat this window has never opened is
 * invisible to the client whatever it asks. That is the documented v1 gap
 * behind the section's caption, and the host follow-up (folding managed
 * commands into a host-scoped stream) is what closes it.
 *
 * One subscription for the whole registry rather than a hook per chat: the warm
 * set changes as tiles open, close and get evicted by the session cap, so any
 * per-chat hook loop would change React's hook count between renders. The
 * per-handle subscriptions are reconciled through the same
 * `reconcileStoreSubscriptions` helper the agent-activity monitor uses.
 *
 * The published snapshot is REPLACED only when its content changes, never
 * rebuilt per read: `useSyncExternalStore` compares snapshots with `===`, and
 * the arrays inside a chat store keep their identity between frames (the host
 * sends each set whole), so a per-read rebuild would look like a change on
 * every unrelated store notification and re-render the page.
 */
export function useWarmChatBackground(): ReadonlyArray<WarmChatBackground> {
  const source = useMemo(() => createWarmChatBackgroundSource(), []);
  return useSyncExternalStore(
    source.subscribe,
    source.read,
    () => EMPTY_WARM_CHATS,
  );
}

interface WarmChatBackgroundSource {
  readonly subscribe: (listener: () => void) => () => void;
  /** Returns the SAME array until its content changes, which is what lets
   * `useSyncExternalStore` compare snapshots with `===`. */
  readonly read: () => ReadonlyArray<WarmChatBackground>;
}

function createWarmChatBackgroundSource(): WarmChatBackgroundSource {
  let published = EMPTY_WARM_CHATS;
  let unsubscribeRegistry: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const handleSubscriptions = new Map<ChatSessionStoreHandle, () => void>();

  const refresh = (): void => {
    const next = readWarmChatBackground();
    if (sameWarmChatBackground(next, published)) return;
    published = next;
    for (const listener of listeners) listener();
  };

  const resync = (): void => {
    reconcileStoreSubscriptions(
      getChatSessionRegistry().listHandles(),
      handleSubscriptions,
      (handle) =>
        handle.store.subscribe((state, previousState) => {
          if (
            state.managedCommands === previousState.managedCommands &&
            state.backgroundItems === previousState.backgroundItems
          ) {
            return;
          }
          refresh();
        }),
    );
    refresh();
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        unsubscribeRegistry = getChatSessionRegistry().subscribe(resync);
        resync();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        unsubscribeRegistry?.();
        unsubscribeRegistry = null;
        for (const unsubscribe of handleSubscriptions.values()) unsubscribe();
        handleSubscriptions.clear();
      };
    },
    read: () => published,
  };
}

function readWarmChatBackground(): ReadonlyArray<WarmChatBackground> {
  const chats = getChatSessionRegistry()
    .listHandles()
    .map((handle): WarmChatBackground => {
      const state = handle.store.getState();
      return {
        epicId: handle.epicId,
        chatId: handle.chatId,
        hostId: getChatSessionHandleHostId(handle),
        managedCommands: state.managedCommands.filter(
          (command) => command.status.state === "running",
        ),
        // Filtered at READ time with the same predicate the builder uses, so a
        // chat whose only background items are scheduled wakeups contributes
        // nothing here AND never reaches the caller's title batch. Filtering on
        // the raw length instead put such a chat's epic into the
        // `epic.getTaskContexts` request for rows it can never produce.
        backgroundItems: (state.backgroundItems ?? []).filter(
          isRunningBackgroundRoot,
        ),
      };
    })
    .filter(
      (chat) =>
        chat.managedCommands.length > 0 || chat.backgroundItems.length > 0,
    );
  return chats.length === 0 ? EMPTY_WARM_CHATS : chats;
}

/**
 * Content comparison down to the two arrays, which are compared by LENGTH and
 * element identity rather than deeply: the host replaces each set whole, so an
 * element that changed is a new object, and an element that did not is the same
 * one.
 */
function sameWarmChatBackground(
  a: ReadonlyArray<WarmChatBackground>,
  b: ReadonlyArray<WarmChatBackground>,
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((chat, index) => {
    const prior = b[index];
    return (
      chat.epicId === prior.epicId &&
      chat.chatId === prior.chatId &&
      chat.hostId === prior.hostId &&
      sameElements(chat.managedCommands, prior.managedCommands) &&
      sameElements(chat.backgroundItems, prior.backgroundItems)
    );
  });
}

function sameElements<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}
