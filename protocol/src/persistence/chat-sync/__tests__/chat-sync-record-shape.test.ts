import { chatHeadReaderSchema, type ChatHeadRecord } from "@traycer/protocol/persistence/chat-sync/head";
import { chatShardReaderSchema, type ChatShardRecord } from "@traycer/protocol/persistence/chat-sync/shard";
import { CHAT_SYNC_SCHEMA_VERSION } from "@traycer/protocol/persistence/chat-sync/version";
import {
  chatHeadRecordV120,
  chatShardRecordV120,
  type ChatHead,
  type ChatShard,
} from "@traycer/protocol/persistence/registry";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

/**
 * `ChatHeadRecord` / `ChatShardRecord` are public structural mirrors of the
 * registered records: the Zod values live behind the `_internal/` privacy
 * boundary, and the encoders need types they can take without importing that
 * module or cycling through the registry.
 *
 * A mirror can drift. These assignments are the guard - a field added to a
 * registered record without being added to its mirror (or the reverse) fails to
 * compile, which is exactly when the encoder would have started silently
 * dropping it.
 */

// Tuple-wrapped so the conditional is not DISTRIBUTIVE. A naked `From extends
// To` spreads over a union `From` and collapses `true | never` back to `true`,
// so a union in which only some members fit would pass this guard. The records
// are object types today; the day a shard variant set becomes a discriminated
// union is the day that would matter, silently.
type Assignable<From, To> = [From] extends [To] ? true : never;
type ChatHeadReaderRecord = z.infer<typeof chatHeadReaderSchema>;
type ChatShardReaderRecord = z.infer<typeof chatShardReaderSchema>;

// Each mirror is typed against the READER schema, which is the more general of
// the two: it accepts any same-major minor, while the registered (writer)
// schema pins the exact literal. So the registered value is a narrowing of the
// mirror, and the reader value matches it exactly.
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
    // Identity, not equality. `defineRecordContract` returns its input and
    // never compares the contract's version against the one its schema embeds,
    // so a repeated `{ major: 1, minor: 0 }` would let a future bump register
    // 1.1 while a payload schema and its writer stayed on 1.0. The two records
    // share ONE version line, so they must bind the same object.
    expect(chatHeadRecordV120.schemaVersion).toBe(CHAT_SYNC_SCHEMA_VERSION);
    expect(chatShardRecordV120.schemaVersion).toBe(CHAT_SYNC_SCHEMA_VERSION);
  });
});
