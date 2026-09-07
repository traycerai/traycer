import { z } from "zod";

/** `chat.subscribe@1.7` - The single literal version of the chat-sync publication contract. */
// 1.3 adds `chat.imported` to `KNOWN_CHAT_EVENT_TYPES`.
export const CHAT_SYNC_SCHEMA_VERSION = { major: 1, minor: 3 } as const;

export type ChatSyncSchemaVersion = typeof CHAT_SYNC_SCHEMA_VERSION;

/** Payload-side schema for `schemaVersion`, pinned to the constant above so the two cannot drift. */
export const chatSyncSchemaVersionSchema = z.object({
  major: z.literal(CHAT_SYNC_SCHEMA_VERSION.major),
  minor: z.literal(CHAT_SYNC_SCHEMA_VERSION.minor),
});

/**
 * The version a READER may accept, as opposed to the one a writer stamps.
 * A payload still cannot claim a version its parser did not accept: the major is pinned, so no payload can pass itself off as belonging to a different contract line, and a shard is still cross-checked against the head.
 */
export const chatSyncReaderVersionSchema = z.object({
  major: z.literal(CHAT_SYNC_SCHEMA_VERSION.major),
  minor: z.number().int().nonnegative(),
});

/** A payload version as a reader may see it: this contract's major, any minor. */
export type ChatSyncPayloadVersion = {
  readonly major: ChatSyncSchemaVersion["major"];
  readonly minor: number;
};

/** Lowercase hex SHA-256, the only form a content address is written in. */
export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
