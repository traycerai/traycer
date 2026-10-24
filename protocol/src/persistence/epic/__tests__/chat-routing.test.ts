import { describe, expect, it } from "vitest";
import { chatRecordSchema } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import { chatSchema, chatSchemaV18 } from "../chat";
import { chatRoutingSchema } from "../foundation";

/**
 * `chatSchema.routing`: what a chat does on a usage limit or an error.
 *
 * A record written before the key existed reads as `policy` (the key is
 * absent), and the frozen wire copies the released lines bind never surface
 * it, so a released peer's frame is byte-for-byte what it was.
 */

const baseChat = {
  parentId: null,
  id: "chat-1",
  userId: "user-1",
  hostId: "host-1",
  title: "Chat",
  createdAt: 1000,
  updatedAt: 1000,
  isTitleEditedByUser: false,
  messages: [],
};

describe("chatSchema.routing", () => {
  it("is absent on a record written before the key existed", () => {
    const parsed = chatSchema.parse(baseChat);
    expect(parsed.routing).toBeUndefined();
    expect(Object.hasOwn(parsed, "routing")).toBe(false);
  });

  it.each(["policy", "hold"] as const)("round-trips %s", (routing) => {
    const parsed = chatSchema.parse({ ...baseChat, routing });
    expect(chatSchema.parse(parsed).routing).toBe(routing);
  });

  it("rejects a value outside the vocabulary", () => {
    expect(chatSchema.safeParse({ ...baseChat, routing: "wait" }).success).toBe(
      false,
    );
    expect(chatRoutingSchema.safeParse(null).success).toBe(false);
  });

  it("is carried on the live chat record the snapshot serves", () => {
    const { messages: _messages, ...record } = baseChat;
    expect(chatRecordSchema.parse({ ...record, routing: "hold" }).routing).toBe(
      "hold",
    );
  });

  it("is not surfaced by the frozen 1.7/1.8 record", () => {
    const parsed = chatSchemaV18.parse({ ...baseChat, routing: "hold" });
    expect(Object.hasOwn(parsed, "routing")).toBe(false);
  });
});
