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
 * drops the durable chat-key entry from EVERY registry in the per-tab
 * restoration family - the single point of truth for every registry, called from the chat-deletion
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
}

/**
 * Same, for a deleted/access-lost epic - drops every durable entry under that epic across every
 * registry.
 */
export function evictChatTabPersistenceForEpic(epicId: string): void {
  evictChatTabPersistenceForEpics([epicId]);
}

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
  }
}

/**
 * promotes a closing chat tile's CURRENT tab-side state to durable across every registry - called
 * from the canvas close sweep, BEFORE any of the tab-key eviction functions above run, for every
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
}
