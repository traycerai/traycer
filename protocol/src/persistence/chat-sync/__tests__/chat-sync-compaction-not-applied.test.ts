import { getRecordSchema } from "@traycer/protocol/framework/index";
import { chatSyncReaderFloorForTranscriptMessages } from "@traycer/protocol/persistence/chat-sync/head";
import { preservedContentBlockSchema } from "@traycer/protocol/persistence/chat-sync/entries";
import {
  canonicalizeJsonObject,
  canonicalJsonStringify,
  jsonObjectSchema,
  type JsonObject,
} from "@traycer/protocol/persistence/chat-sync/json";
import { definePreservedVariant } from "@traycer/protocol/persistence/chat-sync/passthrough";
import {
  encodeChatShard,
  serializeChatShard,
} from "@traycer/protocol/persistence/chat-sync/shard";
import { CHAT_SYNC_SCHEMA_VERSION } from "@traycer/protocol/persistence/chat-sync/version";
import {
  persistenceRecordRegistry,
  type ChatShard,
} from "@traycer/protocol/persistence/registry";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * chat-sync 1.11 adds `compaction.notApplied` to the interpreted block. The
 * stored (raw) block is the carriage: a reader that does not know the key
 * strips it from its interpreted view and still re-emits the canonical raw
 * block, so a later live read recovers it. Missing input reads as `false`, and
 * no minimum-reader floor is stamped, since an older reader degrades to showing
 * the same row as failed.
 */

const chatShardSchema = getRecordSchema(
  persistenceRecordRegistry,
  "chat-shard",
  "latest",
);

const NOT_APPLIED_BLOCK: JsonObject = {
  blockId: "compaction-not-applied",
  status: "errored",
  timestamp: 3,
  type: "compaction",
  trigger: "auto",
  preTokens: 900,
  postTokens: null,
  durationMs: null,
  summary: null,
  error: "Copilot did not apply this compaction.",
  notApplied: true,
};

/** A row written before the field existed: the historical absent-input control. */
const LEGACY_FAILED_BLOCK: JsonObject = {
  blockId: "compaction-legacy-failed",
  status: "errored",
  timestamp: 4,
  type: "compaction",
  trigger: "manual",
  preTokens: null,
  postTokens: null,
  durationMs: null,
  summary: null,
  error: "Copilot did not apply this compaction.",
};

function assistantRow(blocks: JsonObject[]): JsonObject {
  return {
    role: "assistant",
    messageId: "assistant-1",
    sender: {
      type: "agent",
      harnessId: "copilot",
      agentId: "agent-1",
      displayName: "Coder",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks,
    startedAt: 1,
    timestamp: 2,
    turnId: "turn-1",
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

function shardOf(blocks: JsonObject[]): JsonObject {
  return {
    schemaVersion: CHAT_SYNC_SCHEMA_VERSION,
    chatId: "chat-1",
    section: "messages",
    messages: [assistantRow(blocks)],
    events: [],
    hostPrivate: null,
  };
}

const canonicalShard = shardOf([NOT_APPLIED_BLOCK, LEGACY_FAILED_BLOCK]);

function parseShard(value: JsonObject): ChatShard {
  return chatShardSchema.parse(value);
}

function interpretedBlock(shard: ChatShard, index: number) {
  const message = shard.messages[0].value;
  if (message === null || message.role !== "assistant") {
    throw new Error("expected an interpreted assistant message");
  }
  const block = message.blocks[index].value;
  if (block === null || block.type !== "compaction") {
    throw new Error("expected an interpreted compaction block");
  }
  return block;
}

function rawBlocks(shard: ChatShard): readonly unknown[] {
  const raw = shard.messages[0].raw.blocks;
  if (!Array.isArray(raw)) throw new Error("expected raw blocks");
  return raw;
}

/**
 * A reader frozen at chat-sync 1.10, written by hand: the compaction block as
 * it was then, with no `notApplied`. Every other block type is held back
 * unknown, which preserves it, exactly as an old reader does a vocabulary it
 * lacks.
 */
const oldCompactionBlockSchema = z.object({
  blockId: z.string(),
  status: z.enum(["streaming", "completed", "errored"]),
  timestamp: z.number(),
  parentBlockId: z.string().nullish(),
  type: z.literal("compaction"),
  trigger: z.enum(["auto", "manual"]).nullable(),
  preTokens: z.number().nullable(),
  postTokens: z.number().nullable(),
  durationMs: z.number().nullable(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
});

const oldReaderBlockSchema = definePreservedVariant({
  discriminant: "type",
  knownVariants: ["compaction"],
  knownSchema: oldCompactionBlockSchema,
  label: "content block",
});

describe("chat-sync 1.11 registration", () => {
  it("moves the head and the shard together onto one 1.11 version object", () => {
    expect(CHAT_SYNC_SCHEMA_VERSION).toEqual({ major: 1, minor: 11 });
    const head = persistenceRecordRegistry["chat-head"][1];
    const shard = persistenceRecordRegistry["chat-shard"][1];
    expect(head.latestMinor).toBe(11);
    expect(shard.latestMinor).toBe(11);
    expect(Object.keys(head.versions)).toEqual(["11"]);
    expect(Object.keys(shard.versions)).toEqual(["11"]);
    expect(head.versions[11].contract.schemaVersion).toBe(
      shard.versions[11].contract.schemaVersion,
    );
  });
});

describe("the live compaction block", () => {
  it("decodes absent input to false and keeps the raw block absent", () => {
    const decoded = preservedContentBlockSchema.parse(LEGACY_FAILED_BLOCK);
    if (decoded.value === null || decoded.value.type !== "compaction") {
      throw new Error("expected an interpreted compaction block");
    }
    expect(decoded.value.status).toBe("errored");
    expect(decoded.value.notApplied).toBe(false);
    expect(decoded.raw).not.toHaveProperty("notApplied");
  });

  it("decodes true and an explicit false as sent", () => {
    for (const notApplied of [true, false]) {
      const decoded = preservedContentBlockSchema.parse({
        ...LEGACY_FAILED_BLOCK,
        notApplied,
      });
      if (decoded.value === null || decoded.value.type !== "compaction") {
        throw new Error("expected an interpreted compaction block");
      }
      expect(decoded.value.notApplied).toBe(notApplied);
    }
  });

  it("refuses a non-boolean flag", () => {
    const decoded = preservedContentBlockSchema.safeParse({
      ...LEGACY_FAILED_BLOCK,
      notApplied: "yes",
    });
    expect(decoded.success).toBe(false);
  });
});

describe("a chat-shard holding compaction outcomes", () => {
  it("interprets true on the live block and keeps absent input false", () => {
    const shard = parseShard(canonicalShard);
    expect(interpretedBlock(shard, 0).notApplied).toBe(true);
    expect(interpretedBlock(shard, 1).notApplied).toBe(false);
  });

  it("re-emits canonical input byte-identically, true retained and absence left absent", () => {
    const shard = parseShard(canonicalShard);
    expect(serializeChatShard(shard)).toBe(
      canonicalJsonStringify(canonicalShard),
    );
    const blocks = rawBlocks(parseShard(encodeChatShard(shard)));
    expect(blocks[0]).toHaveProperty("notApplied", true);
    expect(blocks[1]).not.toHaveProperty("notApplied");
  });

  it("survives repeated read/write cycles with the flag intact", () => {
    const once = encodeChatShard(parseShard(canonicalShard));
    const twice = encodeChatShard(parseShard(once));
    expect(twice).toEqual(once);
    expect(interpretedBlock(parseShard(twice), 0).notApplied).toBe(true);
  });
});

describe("a reader frozen before the flag", () => {
  const liveShard = parseShard(canonicalShard);
  const canonicalTrueBlock = canonicalizeJsonObject(
    jsonObjectSchema.parse(rawBlocks(liveShard)[0]),
  );

  it("takes canonical input from the live shard's raw block", () => {
    expect(canonicalTrueBlock).toEqual(NOT_APPLIED_BLOCK);
  });

  it("interprets the row without the key, so it reads as an ordinary failure", () => {
    const decoded = oldReaderBlockSchema.parse(canonicalTrueBlock);
    expect(decoded.value).not.toBeNull();
    expect(decoded.value).not.toHaveProperty("notApplied");
    expect(decoded.value?.status).toBe("errored");
    expect(decoded.value?.error).toBe("Copilot did not apply this compaction.");
  });

  it("still holds the raw key and re-encodes the canonical block unchanged", () => {
    const decoded = oldReaderBlockSchema.parse(canonicalTrueBlock);
    expect(decoded.raw).toHaveProperty("notApplied", true);
    expect(z.encode(oldReaderBlockSchema, decoded)).toEqual(canonicalTrueBlock);
  });

  it("lets a live reader recover true from what the old reader re-emitted", () => {
    const reEmitted = z.encode(
      oldReaderBlockSchema,
      oldReaderBlockSchema.parse(canonicalTrueBlock),
    );
    const recovered = preservedContentBlockSchema.parse(reEmitted);
    if (recovered.value === null || recovered.value.type !== "compaction") {
      throw new Error("expected an interpreted compaction block");
    }
    expect(recovered.value.notApplied).toBe(true);
  });
});

describe("no new minimum-reader floor", () => {
  it("stamps no floor for a publication holding a not-applied compaction", () => {
    expect(
      chatSyncReaderFloorForTranscriptMessages([
        assistantRow([NOT_APPLIED_BLOCK]),
        assistantRow([LEGACY_FAILED_BLOCK]),
      ]),
    ).toBeNull();
  });
});
