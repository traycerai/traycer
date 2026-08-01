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

// Ticket 15 (decision #29): durable chat-key mirror of each tab's open tool
// segment ids - survives the tab-key entries being reset on close, so a
// reopened chat's expanded tool cards come back.
export const toolOpenDurableCache =
  createChatDurableCache<ReadonlySet<string>>(200);

// Ticket 15 review round 3: tracks which tab scopes have actually been
// seeded/touched this session - see `chat-scoped-open-store-dual-key.ts`'s
// doc comment. Distinguishes "genuinely empty, already initialized" from
// "never touched (e.g. an inactive tab that never mounted)" for BOTH the
// seed hook and the canvas sweep's promotion below. Cleared by the sweep
// when the tab actually closes.
export const toolOpenInitializedScopes = new Set<string>();

/**
 * Ticket 15 review round 3: promotes this tab's CURRENT scoped ids to
 * durable - called from the canvas close sweep, BEFORE `reset()` wipes the
 * live scope, for every removed chat tile (active or never-mounted alike).
 * A no-op for a tab that was never initialized (inactive tab closed without
 * ever mounting) - there is nothing of this session's to promote, and
 * writing an empty set would incorrectly clobber a prior session's durable
 * snapshot for the same chat.
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
