import {
  defineRecordContract,
  defineVersionedRecordRegistry,
} from "@traycer/protocol/framework/index";
import {
  chatHeadRecordSchema,
  chatShardRecordSchema,
} from "@traycer/protocol/persistence/_internal/chat-sync-schemas";
import { CHAT_SYNC_SCHEMA_VERSION } from "@traycer/protocol/persistence/chat-sync/version";

/**
 * The record codecs a chat publication is encoded with, and nothing else.
 *
 * `persistenceRecordRegistry` (`registry.ts`) registers every persistence
 * record, so importing it constructs the epic, room-metadata and draft schemas
 * too. A consumer that only reads and writes `chat-head` / `chat-shard` - the
 * host's publication encoder, which runs in its own worker isolate - imports
 * this registry instead and never loads those modules. It is the same kind of
 * door as `persistenceRecordRegistry`: schemas are reached through
 * `getRecordSchema(chatSyncRecordRegistry, …)`, never from `_internal/`.
 *
 * The two contracts are defined HERE and imported by `registry.ts`, so each
 * record still has one contract object and one registered schema instance,
 * whichever registry a caller reaches it through.
 */

// Both bind the SAME `CHAT_SYNC_SCHEMA_VERSION` object the payload schemas are
// pinned to - identity, not a repeated literal. `defineRecordContract` returns
// its input and never compares the contract's version against the one its
// schema embeds, so a copied `{ major: 1, minor: 0 }` here would let a future
// bump register 1.1 while the payload schema and the writers stayed on 1.0.

export const chatHeadRecordV150 = defineRecordContract({
  name: "chat-head",
  schemaVersion: CHAT_SYNC_SCHEMA_VERSION,
  schema: chatHeadRecordSchema,
});

export const chatShardRecordV150 = defineRecordContract({
  name: "chat-shard",
  schemaVersion: CHAT_SYNC_SCHEMA_VERSION,
  schema: chatShardRecordSchema,
});

export const chatSyncRecordRegistry = defineVersionedRecordRegistry({
  "chat-head": {
    1: {
      latestMinor: 5,
      versions: {
        5: { contract: chatHeadRecordV150, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
  "chat-shard": {
    1: {
      latestMinor: 5,
      versions: {
        5: { contract: chatShardRecordV150, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
});

export type ChatSyncRecordRegistry = typeof chatSyncRecordRegistry;
