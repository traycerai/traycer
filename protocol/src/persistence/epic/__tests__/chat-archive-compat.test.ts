import { describe, expect, it } from "vitest";
import { chatSchema, chatSchemaPreInReplyTo } from "../chat";

/**
 * `chatSchema.archivedAt` back-compat + totality guard.
 *
 * Archiving is a rolling-update addition (see the "Archive Mechanism" in the
 * chat-sidebar redesign plan): records persisted before this field existed
 * must still parse, defaulting to not-archived. The frozen
 * `chat.subscribe@1.0-1.3` wire copy (`chatSchemaPreInReplyTo`) is a
 * hand-maintained snapshot of the shipped wire shape and was deliberately not
 * given the field - it must never surface it, even when present on the input.
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

describe("chatSchema.archivedAt", () => {
  it("defaults to null when absent (pre-archive persisted record)", () => {
    const parsed = chatSchema.parse(baseChat);
    expect(parsed.archivedAt).toBeNull();
  });

  it("round-trips a set archivedAt", () => {
    const parsed = chatSchema.parse({ ...baseChat, archivedAt: 12345 });
    expect(parsed.archivedAt).toBe(12345);
  });
});

describe("chatSchemaPreInReplyTo does not surface archivedAt", () => {
  it("strips archivedAt from a chat object that includes it", () => {
    const parsed = chatSchemaPreInReplyTo.parse({
      ...baseChat,
      archivedAt: 12345,
    });
    expect(Object.hasOwn(parsed, "archivedAt")).toBe(false);
  });
});
