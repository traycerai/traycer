import { describe, expect, it } from "vitest";
import {
  ROW_SKELETON_PREVIEW_MAX_CHARS,
  messageRowSkeletonEntrySchema,
  rowSkeletonEntrySchema,
  rowSkeletonRowIdEquals,
} from "@traycer/protocol/persistence/chat-transcript/row-skeleton";

/**
 * The skeleton is the one frame where per-row bytes multiply by the length of
 * the chat - see the module doc. These tests pin the two properties that
 * argument depends on (the preview cap, and that omitted fields are actually
 * omitted) plus the discrimination the rest of the type relies on.
 */

describe("rowSkeletonEntrySchema", () => {
  it("parses a minimal message entry and discriminates kind: message", () => {
    const input = {
      kind: "message",
      id: "m-1",
      createdAt: 100,
      role: "user",
      byteLength: 42,
    };

    const parsed = rowSkeletonEntrySchema.parse(input);

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") throw new Error("expected message entry");
    expect(parsed.id).toBe("m-1");
    expect(parsed.createdAt).toBe(100);
    expect(parsed.role).toBe("user");
    expect(parsed.byteLength).toBe(42);
  });

  it("parses a minimal event entry and discriminates kind: event", () => {
    const input = {
      kind: "event",
      id: "e-1",
      createdAt: 200,
      eventType: "chat.forked",
      byteLength: 7,
    };

    const parsed = rowSkeletonEntrySchema.parse(input);

    expect(parsed.kind).toBe("event");
    if (parsed.kind !== "event") throw new Error("expected event entry");
    expect(parsed.id).toBe("e-1");
    expect(parsed.createdAt).toBe(200);
    expect(parsed.eventType).toBe("chat.forked");
    expect(parsed.byteLength).toBe(7);
  });
});

describe("message row role", () => {
  it("accepts role: user and role: assistant", () => {
    const userInput = {
      kind: "message" as const,
      id: "m-1",
      createdAt: 1,
      role: "user",
      byteLength: 1,
    };
    const assistantInput = {
      kind: "message" as const,
      id: "m-2",
      createdAt: 2,
      role: "assistant",
      byteLength: 1,
    };

    expect(messageRowSkeletonEntrySchema.parse(userInput).role).toBe("user");
    expect(messageRowSkeletonEntrySchema.parse(assistantInput).role).toBe(
      "assistant",
    );
  });

  it("rejects role: system - the skeleton has no persisted counterpart for worktree setup cards", () => {
    const input = {
      kind: "message" as const,
      id: "m-1",
      createdAt: 1,
      role: "system",
      byteLength: 1,
    };

    const result = messageRowSkeletonEntrySchema.safeParse(input);

    expect(result.success).toBe(false);
  });
});

describe("message row sentByAgent", () => {
  it("accepts an omitted sentByAgent", () => {
    const input = {
      kind: "message" as const,
      id: "m-1",
      createdAt: 1,
      role: "user",
      byteLength: 1,
    };

    const parsed = messageRowSkeletonEntrySchema.parse(input);

    expect("sentByAgent" in parsed).toBe(false);
  });

  it("accepts sentByAgent: true as a boolean flag", () => {
    const input = {
      kind: "message" as const,
      id: "m-1",
      createdAt: 1,
      role: "user",
      byteLength: 1,
      sentByAgent: true,
    };

    const parsed = messageRowSkeletonEntrySchema.parse(input);

    expect(parsed.sentByAgent).toBe(true);
  });

  it("rejects a sentByAgent that is an agent-sender object rather than a boolean", () => {
    const input = {
      kind: "message" as const,
      id: "m-1",
      createdAt: 1,
      role: "user",
      byteLength: 1,
      sentByAgent: {
        type: "agent",
        harnessId: "claude",
        agentId: "agent-1",
        displayName: "Claude",
      },
    };

    const result = messageRowSkeletonEntrySchema.safeParse(input);

    expect(result.success).toBe(false);
  });
});

describe("message row preview cap", () => {
  it("accepts a preview at the ROW_SKELETON_PREVIEW_MAX_CHARS boundary", () => {
    const input = {
      kind: "message" as const,
      id: "m-1",
      createdAt: 1,
      role: "user" as const,
      byteLength: 1,
      preview: "x".repeat(ROW_SKELETON_PREVIEW_MAX_CHARS),
    };

    const parsed = messageRowSkeletonEntrySchema.parse(input);

    expect(parsed.preview).toHaveLength(ROW_SKELETON_PREVIEW_MAX_CHARS);
  });

  it("rejects a preview one char longer than ROW_SKELETON_PREVIEW_MAX_CHARS", () => {
    const input = {
      kind: "message" as const,
      id: "m-1",
      createdAt: 1,
      role: "user" as const,
      byteLength: 1,
      preview: "x".repeat(ROW_SKELETON_PREVIEW_MAX_CHARS + 1),
    };

    const result = messageRowSkeletonEntrySchema.safeParse(input);

    expect(result.success).toBe(false);
  });
});

describe("optional fields are genuinely omitted, not materialized as undefined", () => {
  it("omits preview, sentByAgent, and usage from a parsed minimal message entry", () => {
    const input = {
      kind: "message" as const,
      id: "m-1",
      createdAt: 1,
      role: "user" as const,
      byteLength: 1,
    };

    const parsed = messageRowSkeletonEntrySchema.parse(input);
    const keys = Object.keys(parsed);

    expect(keys.sort()).toEqual(
      ["kind", "id", "createdAt", "role", "byteLength"].sort(),
    );
    // The `keys.sort()` assertion above is the real guard - it is exhaustive,
    // so it catches a NEW optional field materializing as `undefined` too.
    // These name the current optional fields for the reader's benefit; naming
    // fields the schema no longer has (as this test did for the three
    // fork-eligibility fields) makes an assertion that can never fail.
    expect("preview" in parsed).toBe(false);
    expect("sentByAgent" in parsed).toBe(false);
    expect("usage" in parsed).toBe(false);
  });
});

describe("rowSkeletonRowIdEquals", () => {
  it("distinguishes a message and an event that share the same id string", () => {
    const messageId = { kind: "message" as const, id: "shared-id" };
    const eventId = { kind: "event" as const, id: "shared-id" };

    expect(rowSkeletonRowIdEquals(messageId, eventId)).toBe(false);
  });

  it("treats two ids of the same kind and same id string as equal", () => {
    const a = { kind: "message" as const, id: "shared-id" };
    const b = { kind: "message" as const, id: "shared-id" };

    expect(rowSkeletonRowIdEquals(a, b)).toBe(true);
  });

  it("treats two ids of the same kind and different id string as unequal", () => {
    const a = { kind: "event" as const, id: "id-1" };
    const b = { kind: "event" as const, id: "id-2" };

    expect(rowSkeletonRowIdEquals(a, b)).toBe(false);
  });
});
