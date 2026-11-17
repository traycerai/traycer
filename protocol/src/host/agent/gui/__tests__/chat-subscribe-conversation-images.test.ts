import { describe, expect, it } from "vitest";
import { z } from "zod";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";

/**
 * A resume divider's `conversationMessage` carries the images the member
 * attached, added in place on the unreleased `chat.subscribe@1.44`. `1.43` is
 * the line just below it and the first to carry `conversationMessage` at all:
 * it binds a hand-frozen trigger whose message names no images, so a `1.43`
 * peer drops the key on decode and draws the divider it always did.
 *
 * The lines are read off the registry's negotiated contracts, and the message
 * rides a `range` row, which every windowed line decodes.
 */

const line = hostStreamRpcRegistry["chat.subscribe"][1];
const IMAGES_MINOR = 44;
const FROZEN_MINOR = 43;

const FIRST_HASH = "a1".repeat(32);
const SECOND_HASH = "b2".repeat(32);

/** Two images that share a file name: the content address tells them apart. */
const IMAGES = [
  { attachmentHash: FIRST_HASH, mediaType: "image/png", fileName: "image.png" },
  {
    attachmentHash: SECOND_HASH,
    mediaType: "image/png",
    fileName: "image.png",
  },
];

const MESSAGE_FIELDS = {
  conversationId: "channel-1",
  messageId: "message-1",
  requestId: "request-1",
  senderUserId: "user-1",
  postedAt: 5,
};

const RESUME_FRAME = {
  kind: "range",
  hasBinaryPayload: false,
  epicId: "epic-1",
  chatId: "chat-1",
  range: {
    requestId: "range-1",
    epoch: 0,
    fromOrdinal: 0,
    rowIds: ["assistant-1"],
    messages: [
      {
        role: "assistant",
        messageId: "assistant-1",
        sender: {
          type: "agent",
          harnessId: "claude",
          agentId: "agent-1",
          displayName: null,
          reply: { expectsReply: false },
          inReplyTo: null,
        },
        blocks: [
          {
            blockId: "resume-1",
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
                conversationMessage: { ...MESSAGE_FIELDS, images: IMAGES },
              },
            ],
            wakeTriggers: [],
          },
        ],
        timestamp: 2,
        turnId: "turn-1",
        usage: null,
      },
    ],
    events: [],
    reachedStart: true,
    reachedEnd: true,
  },
};

const recordSchema = z.record(z.string(), z.unknown());
const arraySchema = z.array(z.unknown());

function asRecord(value: unknown, label: string): Record<string, unknown> {
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) throw new Error(`expected object for ${label}`);
  return parsed.data;
}

function asArray(value: unknown, label: string): readonly unknown[] {
  const parsed = arraySchema.safeParse(value);
  if (!parsed.success) throw new Error(`expected array for ${label}`);
  return parsed.data;
}

/** The conversation message on the resume trigger a line decoded from the frame. */
function decodedConversationMessage(minor: number): Record<string, unknown> {
  const result =
    line.versions[minor].contract.serverFrameSchema.safeParse(RESUME_FRAME);
  if (!result.success) throw new Error(`1.${minor} refused the frame`);
  const range = asRecord(asRecord(result.data, "frame").range, "range");
  const row = asRecord(asArray(range.messages, "messages")[0], "row");
  const block = asRecord(asArray(row.blocks, "blocks")[0], "block");
  const trigger = asRecord(asArray(block.triggers, "triggers")[0], "trigger");
  return asRecord(trigger.conversationMessage, "conversationMessage");
}

describe("a resume divider's conversation message images", () => {
  it("keeps both images in order with their exact hashes on 1.44", () => {
    expect(decodedConversationMessage(IMAGES_MINOR)).toEqual({
      ...MESSAGE_FIELDS,
      images: IMAGES,
    });
  });

  it("drops the images and keeps the message on 1.43", () => {
    expect(decodedConversationMessage(FROZEN_MINOR)).toEqual(MESSAGE_FIELDS);
  });
});
