import {
  chatHeadReaderSchema,
  type ChatHeadRecord,
} from "@traycer/protocol/persistence/chat-sync/head";
import {
  chatShardReaderSchema,
  type ChatShardRecord,
} from "@traycer/protocol/persistence/chat-sync/shard";
import { CHAT_SYNC_SCHEMA_VERSION } from "@traycer/protocol/persistence/chat-sync/version";
import {
  chatHeadRecordV130,
  chatShardRecordV130,
  type ChatHead,
  type ChatShard,
} from "@traycer/protocol/persistence/registry";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

/**
 * `ChatHeadRecord` / `ChatShardRecord` are public structural mirrors of the registered records: the Zod values live behind the `_internal/` privacy boundary, and the encoders need types they can take without importing.
 * These assignments are the guard - a field added to a registered record without being added to its mirror (or the reverse) fails to compile, which is exactly when the encoder would have started silently dropping it.
 */

// Tuple-wrapped so the conditional is not DISTRIBUTIVE.
// The records are object types today; the day a shard variant set becomes a discriminated union is the day that would matter, silently.
type Assignable<From, To> = [From] extends [To] ? true : never;
type ChatHeadReaderRecord = z.infer<typeof chatHeadReaderSchema>;
type ChatShardReaderRecord = z.infer<typeof chatShardReaderSchema>;

const registeredHeadFitsMirror: Assignable<ChatHead, ChatHeadRecord> = true;
const headReaderFitsMirror: Assignable<ChatHeadReaderRecord, ChatHeadRecord> =
  true;
const headMirrorFitsReader: Assignable<ChatHeadRecord, ChatHeadReaderRecord> =
  true;

const registeredShardFitsMirror: Assignable<ChatShard, ChatShardRecord> = true;
const shardReaderFitsMirror: Assignable<
  ChatShardReaderRecord,
  ChatShardRecord
> = true;
const shardMirrorFitsReader: Assignable<
  ChatShardRecord,
  ChatShardReaderRecord
> = true;

describe("chat-sync record shapes", () => {
  it("keeps the head mirror and the head reader record mutually assignable", () => {
    expect(headReaderFitsMirror && headMirrorFitsReader).toBe(true);
  });

  it("keeps the shard mirror and the shard reader record mutually assignable", () => {
    expect(shardReaderFitsMirror && shardMirrorFitsReader).toBe(true);
  });

  it("keeps the registered (writer) records assignable to their mirrors", () => {
    expect(registeredHeadFitsMirror && registeredShardFitsMirror).toBe(true);
  });

  it("registers both contracts against the shared version literal", () => {
    // Identity, not equality.
    // The two records share ONE version line, so they must bind the same object.
    expect(chatHeadRecordV130.schemaVersion).toBe(CHAT_SYNC_SCHEMA_VERSION);
    expect(chatShardRecordV130.schemaVersion).toBe(CHAT_SYNC_SCHEMA_VERSION);
  });
});
