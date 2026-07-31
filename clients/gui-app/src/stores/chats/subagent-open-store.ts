import { create } from "zustand";
import { scopedChatOpenId } from "@/stores/chats/open-store-scope";
import { createChatDurableCache } from "@/stores/chats/chat-durable-cache";
import { readScopedIds } from "@/stores/chats/chat-scoped-open-store-dual-key";
import type { ChatTabPersistenceIdentity } from "@/stores/chats/chat-tab-persistence-key";

interface SubagentOpenState {
  readonly openIds: ReadonlySet<string>;
  setOpen: (scope: string, segmentId: string, open: boolean) => void;
  reset: (scope: string) => void;
}

export const useSubagentOpenStore = create<SubagentOpenState>((set) => ({
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

// Ticket 15 (decision #29): durable chat-key mirror of each tab's open
// subagent segment ids - survives the tab-key entries being reset on close,
// so a reopened chat's expanded subagent cards come back.
export const subagentOpenDurableCache =
  createChatDurableCache<ReadonlySet<string>>(200);

// Ticket 15 review round 3: see `toolOpenInitializedScopes`'s twin comment
// in tool-open-store.ts.
export const subagentOpenInitializedScopes = new Set<string>();

/** Ticket 15 review round 3: see `promoteToolOpenToDurable`'s twin comment
 *  in tool-open-store.ts. */
export function promoteSubagentOpenToDurable(
  identity: ChatTabPersistenceIdentity,
): void {
  if (!subagentOpenInitializedScopes.has(identity.tileInstanceId)) return;
  const prefix = `${identity.tileInstanceId}\0`;
  const scoped = readScopedIds(useSubagentOpenStore.getState().openIds, prefix);
  subagentOpenDurableCache.set(identity, scoped);
}

/** Drops the durable chat-key entry - called when the CHAT itself is
 *  deleted, not on an ordinary tab close. */
export function evictSubagentOpenStoreForChat(
  identity: Pick<ChatTabPersistenceIdentity, "epicId" | "chatId">,
): void {
  subagentOpenDurableCache.deleteChat(identity);
}

/** Drops every durable chat-key entry belonging to a deleted/access-lost
 *  epic. */
export function evictSubagentOpenStoresForEpic(epicId: string): void {
  subagentOpenDurableCache.deleteEpic(epicId);
}
