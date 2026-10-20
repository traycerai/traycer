import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  chatSubscribeV126,
  chatSubscribeV127,
  chatSubscribeV128,
} from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * `chat.subscribe@1.28`: the sign-in park line. `signInParked` on the queued
 * prompt item is TOLERANCE, not projection (see `chatSubscribeV128`'s
 * docblock): the live line keeps it, every line below drops it as an unknown
 * member, and an item without it - an older host's - still parses.
 */

function parkedAgentPrompt(
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: "prompt",
    queueItemId: "queue-1",
    messageId: "message-1",
    message: {
      kind: "agent",
      content: { type: "doc", content: [] },
      fromAgentId: "agent-1",
      senderTitle: null,
      senderHarnessId: "claude",
      reply: { expectsReply: false },
    },
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "agent-1",
      displayName: null,
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    settings: {
      harnessId: "codex",
      model: "gpt-5.4",
      permissionMode: "supervised",
      reasoningEffort: "high",
      agentMode: "epic",
    },
    status: "paused",
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

function queueChangedFrame(item: Record<string, unknown>) {
  return {
    kind: "queueChanged",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    queue: { status: "paused", items: [item] },
  };
}

// Reads back the one item a line's `queueChanged` decode produced.
const decodedQueueChangedSchema = z.object({
  kind: z.literal("queueChanged"),
  queue: z.object({
    items: z.tuple([z.record(z.string(), z.unknown())]),
  }),
});

function parsedItem(
  frames: z.ZodType,
  item: Record<string, unknown>,
): Record<string, unknown> {
  const decoded = frames.parse(queueChangedFrame(item));
  return decodedQueueChangedSchema.parse(decoded).queue.items[0];
}

describe("chat.subscribe@1.28 carries the sign-in park mark", () => {
  it("1.28 keeps signInParked on a queued prompt", () => {
    expect(
      parsedItem(
        chatSubscribeV128.serverFrameSchema,
        parkedAgentPrompt({ signInParked: true }),
      ),
    ).toMatchObject({ queueItemId: "queue-1", signInParked: true });
  });

  it("1.28 reads an older host's item, which has no key, as not parked", () => {
    const item = parsedItem(
      chatSubscribeV128.serverFrameSchema,
      parkedAgentPrompt({}),
    );
    expect(item.signInParked === true).toBe(false);
  });

  it.each([
    { label: "1.27", frames: chatSubscribeV127.serverFrameSchema },
    { label: "1.26", frames: chatSubscribeV126.serverFrameSchema },
  ])("$label drops the key and still shows the prompt", ({ frames }) => {
    const item = parsedItem(frames, parkedAgentPrompt({ signInParked: true }));
    expect(item.queueItemId).toBe("queue-1");
    expect("signInParked" in item).toBe(false);
  });
});
