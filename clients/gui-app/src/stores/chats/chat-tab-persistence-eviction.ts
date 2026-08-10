import {
  evictChatTabStateForChat,
  evictChatTabStateForEpic,
  promoteChatTabStateToDurable,
} from "@/stores/chats/chat-tab-state-cache";
import {
  evictA2AOpenStoreForChat,
  evictA2AOpenStoresForEpic,
  promoteA2AOpenStoreToDurable,
} from "@/stores/chats/a2a-open-store-context";
import {
  evictActivityGroupOpenStoreForChat,
  evictActivityGroupOpenStoresForEpic,
  promoteActivityGroupOpenStoreToDurable,
} from "@/stores/chats/activity-group-open-store-core";
import {
  evictToolOpenStoreForChat,
  evictToolOpenStoresForEpic,
  promoteToolOpenToDurable,
} from "@/stores/chats/tool-open-store";
import {
  evictSubagentOpenStoreForChat,
  evictSubagentOpenStoresForEpic,
  promoteSubagentOpenToDurable,
} from "@/stores/chats/subagent-open-store";
import {
  evictTileFindUiForChat,
  evictTileFindUiForEpic,
  promoteTileFindUiToDurable,
} from "@/stores/tile-find/tile-find-store";
import {
  evictChatTurnMinimapActiveEntryForChat,
  evictChatTurnMinimapActiveEntriesForEpic,
  promoteChatTurnMinimapActiveEntryToDurable,
} from "@/stores/chats/chat-turn-minimap-active-entry-store";
import {
  chatTabPersistenceChatKey,
  type ChatTabPersistenceIdentity,
} from "@/stores/chats/chat-tab-persistence-key";
import {
  tombstoneChatKey,
  tombstoneEpicPrefixes,
} from "@/stores/chats/chat-tab-persistence-tombstone";
import { readingPositionIdentityForChat } from "@/lib/reading-position/chat-identity";
import {
  tombstoneReadingPositionContent,
  tombstoneReadingPositionEpics,
} from "@/lib/reading-position/service";

type ChatIdentity = Pick<ChatTabPersistenceIdentity, "epicId" | "chatId">;

/**
 * Ticket 15 (decision #29): drops the durable chat-key entry from EVERY
 * registry in the per-tab restoration family - the single point of truth
 * for "all seven registries", called from the chat-deletion mutation's
 * `onSuccess`. Unlike a tab close (tab-key only, LRU-bounded), a deleted
 * chat can never be reopened, so there is nothing worth keeping.
 *
 * Ticket 15 review round 3: tombstones the chat key FIRST - the canvas
 * close sweep's own durable promotion (store.ts) can race this call from
 * either side (whichever of "the tab closes" or "the delete RPC resolves"
 * happens to run last), so eviction alone is not terminal; every durable
 * write checks this fence (see chat-durable-cache.ts).
 */
export function evictChatTabPersistenceForChat(identity: ChatIdentity): void {
  tombstoneChatKey(chatTabPersistenceChatKey(identity));
  tombstoneReadingPositionContent(
    readingPositionIdentityForChat({
      ...identity,
      tileInstanceId: `deleted-chat:${identity.chatId}`,
    }),
  );
  evictChatTabStateForChat(identity);
  evictA2AOpenStoreForChat(identity);
  evictActivityGroupOpenStoreForChat(identity);
  evictToolOpenStoreForChat(identity);
  evictSubagentOpenStoreForChat(identity);
  evictTileFindUiForChat(identity);
  evictChatTurnMinimapActiveEntryForChat(identity);
}

/**
 * Same, for a deleted/access-lost epic - drops every durable entry under
 * that epic across all seven registries. Called from the epic
 * access-loss/delete reactor alongside its existing tab-close sweep.
 */
export function evictChatTabPersistenceForEpic(epicId: string): void {
  evictChatTabPersistenceForEpics([epicId]);
}

/**
 * Batch form of `evictChatTabPersistenceForEpic` - tombstones every epicId
 * in ONE atomic batch (`tombstoneEpicPrefixes`) before evicting any of
 * them, so a batch larger than the tombstone's FIFO cap cannot half-expire
 * its own earlier entries before the caller's own subsequent sweep
 * (`handleEpicAccessLoss`'s canvas close, which writes durable state back
 * for any of these epics that still had open tiles) gets to them - ticket
 * 15 review round 5 (item 2): a fence must survive its own transaction.
 */
export function evictChatTabPersistenceForEpics(
  epicIds: ReadonlyArray<string>,
): void {
  tombstoneEpicPrefixes(epicIds.map((epicId) => `${epicId}:`));
  tombstoneReadingPositionEpics(epicIds);
  for (const epicId of epicIds) {
    evictChatTabStateForEpic(epicId);
    evictA2AOpenStoresForEpic(epicId);
    evictActivityGroupOpenStoresForEpic(epicId);
    evictToolOpenStoresForEpic(epicId);
    evictSubagentOpenStoresForEpic(epicId);
    evictTileFindUiForEpic(epicId);
    evictChatTurnMinimapActiveEntriesForEpic(epicId);
  }
}

/**
 * Ticket 15 review round 3 (mandated simplification - the ONE close-commit
 * choke point): promotes a closing chat tile's CURRENT tab-side state to
 * durable across all seven registries - called from the canvas close
 * sweep, BEFORE any of the tab-key eviction functions above run, for every
 * removed tile the sweep resolves a chat identity for. Reading each
 * registry's live/tab-side state directly (not depending on a component's
 * own unmount lifecycle) is what makes this correct for BOTH an active view
 * (its component's cleanup, where one still exists - only the scroll cache
 * - runs afterward and wins by ordering) AND an inactive view that never
 * mounted at all (nothing else would ever commit for it).
 */
export function promoteChatTabPersistenceToDurable(
  identity: ChatTabPersistenceIdentity,
): void {
  promoteChatTabStateToDurable(identity);
  promoteA2AOpenStoreToDurable(identity);
  promoteActivityGroupOpenStoreToDurable(identity);
  promoteToolOpenToDurable(identity);
  promoteSubagentOpenToDurable(identity);
  promoteTileFindUiToDurable(identity);
  promoteChatTurnMinimapActiveEntryToDurable(identity);
}
