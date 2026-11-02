import { describe, expect, it } from "vitest";
import {
  draftComposerPortableSchema,
  draftComposerPortableSchemaPreCommandCode,
  draftComposerPortableWriteSchema,
} from "@traycer/protocol/persistence/draft/schemas";

/**
 * A draft is stored and read on its own frozen line: the run settings it holds
 * are the strict tuple of the release before the per-chat Ultracode request,
 * so a draft never carries the request, however the writer built its tuple.
 * The request a restored chat composer shows comes from the chat's own tuple.
 */

const RUN_SETTINGS = {
  harnessId: "claude",
  model: "claude-sonnet-4-20250514",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

function draft(runSettings: Record<string, unknown> | null) {
  return {
    content: { type: "doc", content: [] },
    selection: null,
    runSettings,
    composerMode: "chat",
    blobHashes: [],
    closed: false,
  };
}

function hasUltracode(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.hasOwn(value, "ultracode")
  );
}

describe("the composer draft payload", () => {
  it.each([
    ["the stored payload", draftComposerPortableSchema],
    ["the write payload", draftComposerPortableWriteSchema],
    [
      "the pre-CommandCode wire copy",
      draftComposerPortableSchemaPreCommandCode,
    ],
  ] as const)(
    "%s drops a request a writer put on the tuple",
    (_label, schema) => {
      const parsed = schema.parse(draft({ ...RUN_SETTINGS, ultracode: true }));
      expect(hasUltracode(parsed.runSettings)).toBe(false);
      expect(parsed.runSettings?.model).toBe(RUN_SETTINGS.model);
    },
  );

  it("parses a draft whose tuple never had the key and keeps a null tuple null", () => {
    expect(
      hasUltracode(
        draftComposerPortableSchema.parse(draft(RUN_SETTINGS)).runSettings,
      ),
    ).toBe(false);
    expect(
      draftComposerPortableSchema.parse(draft(null)).runSettings,
    ).toBeNull();
  });
});
