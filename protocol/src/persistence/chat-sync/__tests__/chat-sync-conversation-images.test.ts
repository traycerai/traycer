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
import type { AutonomousResumeConversationMessage } from "@traycer/protocol/persistence/epic/content-blocks";
import {
  persistenceRecordRegistry,
  type ChatShard,
} from "@traycer/protocol/persistence/registry";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * The member's message on an `autonomous_resume` trigger carries the images the
 * member attached, added in place on the still-unreleased chat-sync 1.14. The
 * stored (raw) block is the carriage: a reader that does not know `images`
 * strips it from its interpreted view and still re-emits the canonical raw
 * block, so a later live read recovers both images. A message stored without
 * the key reads as no images, and no minimum-reader floor is stamped, since an
 * older reader draws the same divider it always did.
 */

const chatShardSchema = getRecordSchema(
  persistenceRecordRegistry,
  "chat-shard",
  "latest",
);

const FIRST_HASH = "a1".repeat(32);
const SECOND_HASH = "b2".repeat(32);

/** Two images that share a file name: the content address tells them apart. */
const IMAGES: JsonObject[] = [
  { attachmentHash: FIRST_HASH, mediaType: "image/png", fileName: "image.png" },
  {
    attachmentHash: SECOND_HASH,
    mediaType: "image/png",
    fileName: "image.png",
  },
];

const MESSAGE_FIELDS: JsonObject = {
  conversationId: "channel-1",
  messageId: "message-1",
  requestId: "request-1",
  senderUserId: "user-1",
  postedAt: 5,
};

function resumeBlock(blockId: string, conversationMessage: JsonObject) {
  const block: JsonObject = {
    blockId,
    status: "completed",
    timestamp: 3,
    type: "autonomous_resume",
    deliveryPlacement: "turn_start",
    triggers: [
      {
        kind: "command",
        title: "Message from channel-1",
        status: "completed",
        summary: "A member wrote to the bot.",
        blockId: "",
        outputFile: null,
        mcp: null,
        live: false,
        managedCommand: null,
        conversationMessage,
      },
    ],
    wakeTriggers: [],
  };
  return block;
}

const IMAGES_BLOCK = resumeBlock("resume-images", {
  ...MESSAGE_FIELDS,
  images: IMAGES,
});

/** A row written before the field existed: the historical absent-input control. */
const LEGACY_BLOCK = resumeBlock("resume-legacy", MESSAGE_FIELDS);

function assistantRow(blocks: JsonObject[]): JsonObject {
  return {
    role: "assistant",
    messageId: "assistant-1",
    sender: {
      type: "agent",
      harnessId: "claude",
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

const canonicalShard = shardOf([IMAGES_BLOCK, LEGACY_BLOCK]);

function parseShard(value: JsonObject): ChatShard {
  return chatShardSchema.parse(value);
}

type PreservedBlock = z.output<typeof preservedContentBlockSchema>;

/** The conversation message on the first trigger of an interpreted resume block. */
function resumeMessage(
  block: PreservedBlock,
): AutonomousResumeConversationMessage {
  const value = block.value;
  if (value === null || value.type !== "autonomous_resume") {
    throw new Error("expected an interpreted autonomous_resume block");
  }
  const message = value.triggers[0].conversationMessage;
  if (message === null) throw new Error("expected a conversationMessage");
  return message;
}

function shardResumeMessage(
  shard: ChatShard,
  index: number,
): AutonomousResumeConversationMessage {
  const message = shard.messages[0].value;
  if (message === null || message.role !== "assistant") {
    throw new Error("expected an interpreted assistant message");
  }
  return resumeMessage(message.blocks[index]);
}

function rawBlocks(shard: ChatShard): readonly unknown[] {
  const raw = shard.messages[0].raw.blocks;
  if (!Array.isArray(raw)) throw new Error("expected raw blocks");
  return raw;
}

/** The first trigger's stored `conversationMessage`, read off a raw block. */
function rawConversationMessage(block: unknown): JsonObject {
  const stored = jsonObjectSchema.parse(block);
  const triggers = stored.triggers;
  if (!Array.isArray(triggers)) throw new Error("expected raw triggers");
  const trigger = jsonObjectSchema.parse(triggers[0]);
  return jsonObjectSchema.parse(trigger.conversationMessage);
}

/**
 * A reader frozen before `images`, written by hand: the resume block as it was
 * then, whose trigger's conversation message names no images. Every other
 * block type is held back unknown, which preserves it, exactly as an old reader
 * does a vocabulary it lacks.
 */
const oldConversationMessageSchema = z.object({
  conversationId: z.string(),
  messageId: z.string(),
  requestId: z.string(),
  senderUserId: z.string().nullable(),
  postedAt: z.number(),
});

const oldResumeTriggerSchema = z.object({
  kind: z.enum(["command", "monitor", "subagent", "wakeup"]),
  title: z.string(),
  status: z.enum(["completed", "failed", "stopped"]),
  summary: z.string(),
  blockId: z.string(),
  outputFile: z
    .object({ workspacePath: z.string(), filePath: z.string() })
    .nullable(),
  mcp: z.object({ serverName: z.string(), toolName: z.string() }).nullable(),
  live: z.boolean(),
  managedCommand: z
    .object({
      commandId: z.string(),
      monitoring: z.boolean(),
      hostId: z.string().nullable(),
    })
    .nullable(),
  conversationMessage: oldConversationMessageSchema.nullable(),
});

const oldResumeBlockSchema = z.object({
  blockId: z.string(),
  status: z.enum(["streaming", "completed", "errored"]),
  timestamp: z.number(),
  parentBlockId: z.string().nullish(),
  type: z.literal("autonomous_resume"),
  deliveryPlacement: z.enum(["turn_start", "in_turn"]).nullable(),
  triggers: z.array(oldResumeTriggerSchema),
});

const oldReaderBlockSchema = definePreservedVariant({
  discriminant: "type",
  knownVariants: ["autonomous_resume"],
  knownSchema: oldResumeBlockSchema,
  label: "content block",
});

describe("the live resume block's conversation message", () => {
  it("refuses an image whose hash is not 64 lowercase hex characters", () => {
    const decoded = preservedContentBlockSchema.safeParse(
      resumeBlock("resume-bad-hash", {
        ...MESSAGE_FIELDS,
        images: [{ ...IMAGES[0], attachmentHash: "not-a-hash" }],
      }),
    );
    expect(decoded.success).toBe(false);
  });
});

describe("a chat-shard holding resume blocks with images", () => {
  it("interprets both images on the live block and none on the legacy one", () => {
    const shard = parseShard(canonicalShard);
    expect(shardResumeMessage(shard, 0).images).toEqual(IMAGES);
    expect(shardResumeMessage(shard, 1).images).toEqual([]);
  });

  it("re-emits canonical input byte-identically, images retained and absence left absent", () => {
    const shard = parseShard(canonicalShard);
    expect(serializeChatShard(shard)).toBe(
      canonicalJsonStringify(canonicalShard),
    );
    const blocks = rawBlocks(parseShard(encodeChatShard(shard)));
    expect(rawConversationMessage(blocks[0])).toHaveProperty("images", IMAGES);
    expect(rawConversationMessage(blocks[1])).not.toHaveProperty("images");
  });

  it("survives repeated read/write cycles with both images intact", () => {
    const once = encodeChatShard(parseShard(canonicalShard));
    const twice = encodeChatShard(parseShard(once));
    expect(twice).toEqual(once);
    expect(shardResumeMessage(parseShard(twice), 0).images).toEqual(IMAGES);
  });
});

describe("a reader frozen before images", () => {
  const liveShard = parseShard(canonicalShard);
  const canonicalImagesBlock = canonicalizeJsonObject(
    jsonObjectSchema.parse(rawBlocks(liveShard)[0]),
  );

  it("takes canonical input from the live shard's raw block", () => {
    expect(canonicalImagesBlock).toEqual(IMAGES_BLOCK);
  });

  it("interprets the block without images, so it draws the divider it always did", () => {
    const decoded = oldReaderBlockSchema.parse(canonicalImagesBlock);
    expect(decoded.value).not.toBeNull();
    expect(decoded.value?.triggers[0].conversationMessage).toEqual(
      MESSAGE_FIELDS,
    );
  });

  it("still holds the raw images and re-encodes the canonical block unchanged", () => {
    const decoded = oldReaderBlockSchema.parse(canonicalImagesBlock);
    expect(rawConversationMessage(decoded.raw)).toHaveProperty(
      "images",
      IMAGES,
    );
    expect(z.encode(oldReaderBlockSchema, decoded)).toEqual(
      canonicalImagesBlock,
    );
  });

  it("lets a live reader recover both images from what the old reader re-emitted", () => {
    const reEmitted = z.encode(
      oldReaderBlockSchema,
      oldReaderBlockSchema.parse(canonicalImagesBlock),
    );
    const recovered = preservedContentBlockSchema.parse(reEmitted);
    expect(resumeMessage(recovered).images).toEqual(IMAGES);
  });
});

describe("no new minimum-reader floor", () => {
  it("stamps no floor for a publication holding a resume block with images", () => {
    expect(
      chatSyncReaderFloorForTranscriptMessages([
        assistantRow([IMAGES_BLOCK]),
        assistantRow([LEGACY_BLOCK]),
      ]),
    ).toBeNull();
  });
});
