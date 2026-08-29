import { describe, expect, it } from "vitest";
import {
  ROW_SKELETON_PREVIEW_MAX_CHARS,
  rowSkeletonEntrySchema,
} from "@traycer/protocol/persistence/chat-transcript/row-skeleton";

/**
 * The skeleton is the one frame where per-row bytes multiply by the length of
 * the chat - see the module doc. These pin the two properties that argument
 * depends on (the preview cap, and that omitted fields are actually omitted),
 * plus the role set, which changed meaning when entries became ROW-keyed rather
 * than record-keyed.
 */

const MINIMAL = {
  rowId: "assistant:t-1",
  createdAt: 100,
  role: "assistant" as const,
  byteLength: 42,
  // Required, and shaped like a real one: `finishContentFingerprint` emits two
  // base36 halves. Incidental to every assertion below - none of them read it -
  // but the schema will not parse an entry without it.
  bodyDigest: "1x9k2mq0004zt7",
};

describe("rowSkeletonEntrySchema", () => {
  it("parses a minimal entry", () => {
    const parsed = rowSkeletonEntrySchema.parse(MINIMAL);

    expect(parsed.rowId).toBe("assistant:t-1");
    expect(parsed.createdAt).toBe(100);
    expect(parsed.role).toBe("assistant");
    expect(parsed.byteLength).toBe(42);
  });

  it("rejects an entry keyed by record identity rather than a row id", () => {
    // The pre-projection shape. Kept as a test because the failure it guards
    // against is silent: a producer still emitting `{kind, id}` would parse as
    // "missing rowId" only if `rowId` is genuinely required.
    // Built FROM `MINIMAL` with only `rowId` removed, so the parse can fail for
    // exactly one reason. The old fixture also omitted `bodyDigest`, so it
    // would have kept passing on that alone if `rowId` ever became optional -
    // and the guard this comment describes would have stopped guarding.
    const { rowId: _removed, ...withoutRowId } = MINIMAL;
    const result = rowSkeletonEntrySchema.safeParse({
      ...withoutRowId,
      kind: "message",
      id: "m-1",
    });

    expect(result.success).toBe(false);
  });
});

describe("row role", () => {
  it("accepts all three RENDERED roles, system included", () => {
    // `system` is the setup card and the forked-chat link. An earlier schema
    // rejected it on the grounds that no persisted record has that role - true
    // of records, false of rows, which is the distinction this schema carries.
    for (const role of ["user", "assistant", "system"] as const) {
      expect(rowSkeletonEntrySchema.parse({ ...MINIMAL, role }).role).toBe(
        role,
      );
    }
  });

  it("rejects a role outside the rendered set", () => {
    const result = rowSkeletonEntrySchema.safeParse({
      ...MINIMAL,
      role: "tool",
    });

    expect(result.success).toBe(false);
  });
});

describe("sentByAgent", () => {
  it("accepts sentByAgent: true as a boolean flag", () => {
    const parsed = rowSkeletonEntrySchema.parse({
      ...MINIMAL,
      role: "user" as const,
      sentByAgent: true,
    });

    expect(parsed.sentByAgent).toBe(true);
  });

  it("rejects a sentByAgent that is an agent-sender object rather than a boolean", () => {
    const result = rowSkeletonEntrySchema.safeParse({
      ...MINIMAL,
      role: "user",
      sentByAgent: {
        type: "agent",
        harnessId: "claude",
        agentId: "agent-1",
        displayName: "Claude",
      },
    });

    expect(result.success).toBe(false);
  });
});

describe("preview cap", () => {
  it("accepts a preview at the ROW_SKELETON_PREVIEW_MAX_CHARS boundary", () => {
    const parsed = rowSkeletonEntrySchema.parse({
      ...MINIMAL,
      role: "user" as const,
      preview: "x".repeat(ROW_SKELETON_PREVIEW_MAX_CHARS),
    });

    expect(parsed.preview).toHaveLength(ROW_SKELETON_PREVIEW_MAX_CHARS);
  });

  it("rejects a preview one char longer than ROW_SKELETON_PREVIEW_MAX_CHARS", () => {
    const result = rowSkeletonEntrySchema.safeParse({
      ...MINIMAL,
      role: "user",
      preview: "x".repeat(ROW_SKELETON_PREVIEW_MAX_CHARS + 1),
    });

    expect(result.success).toBe(false);
  });
});

describe("optional fields are genuinely omitted, not materialized as undefined", () => {
  it("omits preview, sentByAgent, and usage from a parsed minimal entry", () => {
    const parsed = rowSkeletonEntrySchema.parse(MINIMAL);

    // Exhaustive, so it also catches a NEW optional field materializing as
    // `undefined`. The `in` checks below just name today's optionals for the
    // reader; naming fields the schema does not have would be an assertion
    // that can never fail.
    expect(Object.keys(parsed).sort()).toEqual(
      ["rowId", "createdAt", "role", "byteLength", "bodyDigest"].sort(),
    );
    expect("preview" in parsed).toBe(false);
    expect("sentByAgent" in parsed).toBe(false);
    expect("usage" in parsed).toBe(false);
  });
});
