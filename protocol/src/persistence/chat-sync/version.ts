import { z } from "zod";

/**
 * The single literal version of the chat-sync publication contract.
 *
 * Deliberately its own module, importing nothing but Zod, so the registered
 * payload schemas (`_internal/chat-sync-schemas.ts`), the registry entries,
 * and the writers (`head.ts` / `shard.ts`) can all bind to the SAME literal
 * without a dependency cycle.
 *
 * **One version line for both records.** `chat-head` and `chat-shard` are two
 * halves of one publication: a shard embeds the same message / block / event
 * sub-schemas the head's core is built from, and a reader that gates on the
 * head then parses the shards it names. Every change that moves one moves the
 * other, so they bump together, always - the same argument that put
 * `chat-snapshot` and its increment on one line in the v1 design.
 *
 * Why a literal rather than the generic `{major, minor}` schema: a payload's
 * `schemaVersion` is self-identifying - it is what a repair verb, an orphan
 * sweep, or a clone target trusts when a downloaded object is detached from
 * the row that pointed at it. A generic schema lets a v1.0 parser accept a
 * payload claiming `{major: 99, minor: 77}`, which makes that field worthless
 * exactly when it matters. Pinning it means a payload can only ever claim the
 * version of the contract that accepted it.
 *
 * A new minor adds new contracts with their own literal here (`z.literal(1)`
 * for 1.1, and so on) alongside their registry entries.
 *
 * **1.2** carries canonical interview settlement: the interview content block
 * gained `outcome`, `draftAnswers`, `settlement`, `diagnostics` and `delivery`,
 * and each interview answer gained `selection`. Every one of those is
 * `.default(...)`-ed, so a 1.1 record parses unchanged, and §2/§3 of
 * `COMPATIBILITY.md` (the passthrough's `raw` re-emission and residual capture)
 * already make a 1.1 reader's re-publication of a 1.2 chat mechanically
 * lossless - which is why `CHAT_SYNC_1_1_READER_FLOOR` is NOT raised and a 1.2
 * head still stamps `minReaderVersion: null`. The bump exists because the
 * coupled-bump ritual requires the record minor for a `chat.subscribe` field
 * that also lands in a publication (these rode `chat.subscribe@1.7`), and
 * because a payload's self-identifying version is what a detached repair
 * candidate is trusted on.
 */
// 1.3 adds `chat.imported` to `KNOWN_CHAT_EVENT_TYPES`. A new chat-event type
// is a MINOR here and only here: the unknown-variant passthrough
// (`passthrough.ts`) is what lets an older reader meet the event, keep it whole
// in `raw`, and re-publish it unchanged - the mechanism `COMPATIBILITY.md`
// names as reclassifying this class of addition from breaking to additive.
// (Renumbered from 1.2 when main's interview-settlement bump took that minor.)
export const CHAT_SYNC_SCHEMA_VERSION = { major: 1, minor: 3 } as const;

export type ChatSyncSchemaVersion = typeof CHAT_SYNC_SCHEMA_VERSION;

/**
 * Payload-side schema for `schemaVersion`, pinned to the constant above so the
 * two cannot drift. A payload claiming any other version is not a v1.1 record
 * and does not parse as one.
 */
export const chatSyncSchemaVersionSchema = z.object({
  major: z.literal(CHAT_SYNC_SCHEMA_VERSION.major),
  minor: z.literal(CHAT_SYNC_SCHEMA_VERSION.minor),
});

/**
 * The version a READER may accept, as opposed to the one a writer stamps.
 *
 * The gate admits every same-major publication whatever its minor - that is
 * what makes the passthrough and the residual bags worth having. The strict
 * schema above would then reject a genuine 1.1 payload immediately after
 * download, leaving the promise unreachable end to end, so acceptance is
 * widened here to "same major, any minor" while the writer keeps stamping the
 * pinned literal.
 *
 * Nothing about the anti-forgery property is given up. A payload still cannot
 * claim a version its parser did not accept: the major is pinned, so no
 * payload can pass itself off as belonging to a different contract line, and
 * a shard is still cross-checked against the head that named it.
 *
 * Older minors are accepted too: a 1.4 reader meeting a 1.0 head is the
 * ordinary case, not the interesting one.
 */
export const chatSyncReaderVersionSchema = z.object({
  major: z.literal(CHAT_SYNC_SCHEMA_VERSION.major),
  minor: z.number().int().nonnegative(),
});

/**
 * A payload version as a reader may see it: this contract's major, any minor.
 * `ChatSyncSchemaVersion` (the writer's pinned literal) is a narrowing of it,
 * so a freshly written record satisfies both.
 */
export type ChatSyncPayloadVersion = {
  readonly major: ChatSyncSchemaVersion["major"];
  readonly minor: number;
};

/** Lowercase hex SHA-256, the only form a content address is written in. */
export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
