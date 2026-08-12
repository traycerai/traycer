import { chatHeadSchema } from "@traycer/protocol/persistence/chat-sync/head";
import { chatShardSchema } from "@traycer/protocol/persistence/chat-sync/shard";

/**
 * Private Zod values for the `chat-head` and `chat-shard` records.
 *
 * A published chat is a small mutable head plus a set of immutable,
 * content-addressed shards. Unlike `epic`, neither lives in a Yjs doc: the
 * head is the opaque JSON on a chat's cloud row, and the shards are objects in
 * storage the head names by content hash.
 *
 * The records are partitioned on purpose:
 *
 * - the head's `core` is what cloud renderers and clone targets interpret, and
 *   evolves at reader speed under the usual same-major rules;
 * - `hostPrivate` is opaque to the protocol and evolves at host speed;
 * - shards hold the transcript, so an append rewrites one cohort rather than
 *   the whole chat.
 *
 * Every modeled object in both records captures its unmodeled keys into a
 * `residual` bag (`chat-sync/residual.ts`), so a field a newer minor adds
 * survives an older reader's re-publication instead of being stripped.
 *
 * `schemaVersion` is carried inside both payloads so an object found detached
 * from the head that named it is still self-identifying - and it is pinned to
 * the contract's literal (`chat-sync/version.ts`) rather than the generic
 * `{major, minor}` schema, so a v1.0 parser can never accept a payload claiming
 * to be something else.
 *
 * These schemas are the contract authority for the records' TypeScript shapes -
 * `ChatHead` and `ChatShard` are derived from them in
 * `protocol/persistence/registry.ts` via `RecordValue<>`. Only that registry
 * imports this module; every other consumer reaches the schemas through
 * `getRecordSchema(persistenceRecordRegistry, …, "latest")`.
 *
 * The field maps and the constructions themselves live in `chat-sync/head.ts`
 * and `chat-sync/shard.ts` so the registered schemas, the forward-compatible
 * reader schemas and the frozen wire projections are all built from one source.
 * This module still owns the single registered instances, which is what the
 * privacy boundary is actually about.
 */
export const chatHeadRecordSchema = chatHeadSchema;
export const chatShardRecordSchema = chatShardSchema;
