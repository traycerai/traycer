import { create } from "zustand";
import { scopedChatOpenId } from "@/stores/chats/open-store-scope";
import { createChatDurableCache } from "@/stores/chats/chat-durable-cache";
import { readScopedIds } from "@/stores/chats/chat-scoped-open-store-dual-key";
import type { ChatTabPersistenceIdentity } from "@/stores/chats/chat-tab-persistence-key";

interface ToolOpenState {
  readonly openIds: ReadonlySet<string>;
  setOpen: (scope: string, segmentId: string, open: boolean) => void;
  reset: (scope: string) => void;
}

export const useToolOpenStore = create<ToolOpenState>((set) => ({
  openIds: new Set(),
  setOpen: (scope, segmentId, open) =>
    set((state) => {
      const scopedId = scopedChatOpenId(scope, segmentId);
      const wasOpen = state.openIds.has(scopedId);
      if (wasOpen === open) return state;
      const next = new Set(state.openIds);
      if (open) {
        next.add(scopedId);
      } else {
        next.delete(scopedId);
      }
      return { openIds: next };
    }),
  reset: (scope) =>
    set((state) => {
      const prefix = `${scope}\0`;
      const next = new Set(
        Array.from(state.openIds).filter((id) => !id.startsWith(prefix)),
      );
      return next.size === state.openIds.size ? state : { openIds: next };
    }),
}));

// durable chat-key mirror of each tab's open tool segment ids - survives
// the tab-key entries being reset on close, so a reopened chat's expanded tool cards come back.
export const toolOpenDurableCache =
  createChatDurableCache<ReadonlySet<string>>(200);

// tracks which tab scopes have actually been seeded/touched this session - see
// `chat-scoped-open-store-dual-key.ts`'s doc comment.
export const toolOpenInitializedScopes = new Set<string>();

/**
 * promotes this tab's CURRENT scoped ids to durable - called from the canvas close sweep, BEFORE
 * `reset()` wipes the live scope, for every removed chat tile (active or never-mounted alike).
 */
export function promoteToolOpenToDurable(
  identity: ChatTabPersistenceIdentity,
): void {
  if (!toolOpenInitializedScopes.has(identity.tileInstanceId)) return;
  const prefix = `${identity.tileInstanceId}\0`;
  const scoped = readScopedIds(useToolOpenStore.getState().openIds, prefix);
  toolOpenDurableCache.set(identity, scoped);
}

/** Drops the durable chat-key entry - called when the CHAT itself is
 *  deleted, not on an ordinary tab close. */
export function evictToolOpenStoreForChat(
  identity: Pick<ChatTabPersistenceIdentity, "epicId" | "chatId">,
): void {
  toolOpenDurableCache.deleteChat(identity);
}

/** Drops every durable chat-key entry belonging to a deleted/access-lost
 *  epic. */
export function evictToolOpenStoresForEpic(epicId: string): void {
  toolOpenDurableCache.deleteEpic(epicId);
}
