import { chatHeadSchema } from "@traycer/protocol/persistence/chat-sync/head";
import { chatShardSchema } from "@traycer/protocol/persistence/chat-sync/shard";

/**
 * Private Zod values for the `chat-head` and `chat-shard` records.
 * The field maps and the constructions themselves live in `chat-sync/head.ts` and `chat-sync/shard.ts` so the registered schemas, the forward-compatible reader schemas and the frozen wire projections are all built from.
 */
export const chatHeadRecordSchema = chatHeadSchema;
export const chatShardRecordSchema = chatShardSchema;
