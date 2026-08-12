/**
 * Drift guard: hand-maintained KNOWN_STASH_* allowlists must exactly match the
 * live composer Tiptap schema built from `buildComposerExtensions`.
 *
 * Persistence code imports only the pure descriptor (no live editor config).
 * This test is the only place that bridges both sides.
 */
import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";

import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { buildComposerExtensions } from "@/components/chat/composer/editor/editor-config";
import {
  KNOWN_STASH_MARK_TYPES,
  KNOWN_STASH_NODE_TYPES,
} from "@/lib/composer/prompt-stash-schema-descriptor";

function buildLiveComposerSchema() {
  const submitHolder = {
    current: () => {
      // no-op submit for schema-only construction
    },
  };
  return getSchema(
    buildComposerExtensions({
      pickerStore: createComposerPickerStore(),
      getPlaceholder: () => "test",
      onSubmit: submitHolder,
      slashProviderId: "claude",
      getHasPastedImageBytes: () => null,
      getIngestPastedComposerImages: () => null,
    }),
  );
}

function sortedKeys(
  values: ReadonlySet<string> | ReadonlyArray<string>,
): string[] {
  return [...values].toSorted();
}

describe("prompt-stash-schema-descriptor drift", () => {
  it("KNOWN_STASH_NODE_TYPES matches live schema.nodes exactly", () => {
    const schema = buildLiveComposerSchema();
    const liveNodes = Object.keys(schema.nodes);
    expect(sortedKeys(liveNodes)).toEqual(sortedKeys(KNOWN_STASH_NODE_TYPES));
  });

  it("KNOWN_STASH_MARK_TYPES matches live schema.marks exactly", () => {
    const schema = buildLiveComposerSchema();
    const liveMarks = Object.keys(schema.marks);
    expect(sortedKeys(liveMarks)).toEqual(sortedKeys(KNOWN_STASH_MARK_TYPES));
  });
});
