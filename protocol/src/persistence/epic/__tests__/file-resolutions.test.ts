import { describe, expect, it } from "vitest";
import {
  assistantMessageSchema,
  assistantMessageSchemaPreImage,
  assistantMessageSchemaPreInReplyTo,
  assistantMessageSchemaPreReasonix,
  assistantMessageSchemaPreSettlement,
  fileResolutionEntrySchema,
  imageResolutionEntrySchema,
} from "@traycer/protocol/persistence/epic/messages";

/**
 * `fileResolutionEntrySchema` + the `fileResolutions` field it adds to the
 * LIVE `assistantMessageSchema` only (D28).
 *
 * The compatibility claim under test: a message persisted before the epic
 * file plane existed has no `fileResolutions` key at all and must still parse
 * (old-writer case), and the four hand-frozen wire copies bound to already
 * -released `chat.subscribe` minors must never observe the field even when a
 * caller hands them one - each is a field-for-field list, not a `.omit()`
 * derivation, so gaining a key silently would mean the freeze stopped freezing.
 */

function minimalAssistantMessage(): Record<string, unknown> {
  return {
    role: "assistant",
    messageId: "m1",
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "agent-1",
      displayName: null,
    },
    blocks: [],
    timestamp: 1,
    turnId: null,
    usage: null,
  };
}

describe("assistantMessageSchema.fileResolutions", () => {
  it("parses a message with no fileResolutions key as [] (old-writer compatibility)", () => {
    const parsed = assistantMessageSchema.parse(minimalAssistantMessage());
    expect(parsed.fileResolutions).toEqual([]);
  });

  it("round-trips one resolved entry", () => {
    const entry = {
      src: "files/recordings/clip.mp4",
      state: "resolved",
      path: "files/recordings/clip.mp4",
      sha256: "a".repeat(64),
      mediaType: "video/mp4",
      kind: "recording",
    };
    expect(fileResolutionEntrySchema.parse(entry)).toEqual(entry);

    const parsed = assistantMessageSchema.parse({
      ...minimalAssistantMessage(),
      fileResolutions: [entry],
    });
    expect(parsed.fileResolutions).toEqual([entry]);
  });

  it("parses open string values invented after this minor froze", () => {
    const entry = {
      src: "files/future.bin",
      state: "some-future-state",
      path: "files/future.bin",
      sha256: "b".repeat(64),
      mediaType: "application/x-future",
      kind: "some-future-kind",
    };
    expect(fileResolutionEntrySchema.parse(entry)).toEqual(entry);
  });

  it("parses an unresolved entry (path/sha256/mediaType/kind all null)", () => {
    const entry = {
      src: "files/missing.bin",
      state: "unavailable",
      path: null,
      sha256: null,
      mediaType: null,
      kind: null,
    };
    expect(fileResolutionEntrySchema.parse(entry)).toEqual(entry);
  });

  // The frozen-copy guard: each hand-frozen assistant-message copy below is a
  // field-for-field list bound to an already-released `chat.subscribe` wire
  // line. A message carrying `fileResolutions` must still parse against them
  // (unknown keys strip, per the plain `z.object` reparse discipline these
  // freezes already rely on for every other post-freeze field) but the
  // parsed OUTPUT must never carry the key - these copies must never gain it.
  const frozenCopies = [
    ["assistantMessageSchemaPreReasonix", assistantMessageSchemaPreReasonix],
    ["assistantMessageSchemaPreInReplyTo", assistantMessageSchemaPreInReplyTo],
    ["assistantMessageSchemaPreImage", assistantMessageSchemaPreImage],
    [
      "assistantMessageSchemaPreSettlement",
      assistantMessageSchemaPreSettlement,
    ],
  ] as const;

  it.each(frozenCopies)(
    "%s parses a message carrying fileResolutions but strips the key",
    (_name, schema) => {
      const input = {
        ...minimalAssistantMessage(),
        fileResolutions: [
          {
            src: "files/x.mp4",
            state: "resolved",
            path: "files/x.mp4",
            sha256: "c".repeat(64),
            mediaType: "video/mp4",
            kind: "recording",
          },
        ],
      };
      const result = schema.safeParse(input);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect("fileResolutions" in result.data).toBe(false);
    },
  );

  it("proves the comparison is meaningful: the live schema DOES carry it on the same input", () => {
    const input = {
      ...minimalAssistantMessage(),
      fileResolutions: [
        {
          src: "files/x.mp4",
          state: "resolved",
          path: "files/x.mp4",
          sha256: "c".repeat(64),
          mediaType: "video/mp4",
          kind: "recording",
        },
      ],
    };
    const parsed = assistantMessageSchema.parse(input);
    expect("fileResolutions" in parsed).toBe(true);
    expect(parsed.fileResolutions).toEqual(input.fileResolutions);
  });
});

describe("imageResolutionEntrySchema is untouched by fileResolutions", () => {
  it("still rejects a non-image mediaType on a resolved entry", () => {
    expect(
      imageResolutionEntrySchema.safeParse({
        canonicalSource: "files/clip.mp4",
        source: "files/clip.mp4",
        state: "resolved",
        attachmentHash: "d".repeat(64),
        mediaType: "video/mp4",
      }).success,
    ).toBe(false);
  });
});
