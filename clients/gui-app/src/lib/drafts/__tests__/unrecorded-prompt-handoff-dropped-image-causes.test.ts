/**
 * R6F3: `buildTextOnlyPromptHandoff`'s appended note differs truthfully by
 * `DroppedImageCause` - "we could not find your picture" and "your picture
 * did not fit" are different facts, and a reader deciding whether to resend
 * needs the right one.
 *
 * Pure/synchronous-ish: the image node is dropped before any resolver would
 * ever run, so this needs neither IndexedDB nor an image-decoding stub.
 */
import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  buildTextOnlyPromptHandoff,
  type DroppedImageCause,
} from "@/lib/drafts/unrecorded-prompt-handoff";

function contentWithOneImage(text: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "imageAttachment",
        attrs: {
          id: "image-1",
          fileName: "a.png",
          mimeType: "image/png",
          size: 10,
          hash: "deadbeef",
        },
      },
      { type: "paragraph", content: [{ type: "text", text }] },
    ],
  };
}

const CAUSES: readonly DroppedImageCause[] = [
  "missing",
  "timed-out",
  "too-large",
  "capacity",
  "unprepared",
];

describe("R6F3: DroppedImageCause produces a distinct, truthful note per cause", () => {
  it("every cause's note is unique text (DRIVE RED)", async () => {
    const notes = new Map<DroppedImageCause, string>();
    for (const cause of CAUSES) {
      const snapshot = await buildTextOnlyPromptHandoff({
        id: `id-${cause}`,
        createdAt: 1,
        content: contentWithOneImage("hello"),
        reason: "Reason.",
        cause,
      });
      notes.set(cause, JSON.stringify(snapshot.entry.content));
    }
    // Every note is different text - no two causes are described the same
    // way.
    expect(new Set(notes.values()).size).toBe(CAUSES.length);
  });

  it("the three most user-visible causes name their own, correct fact (DRIVE RED)", async () => {
    async function noteFor(cause: DroppedImageCause): Promise<string> {
      const snapshot = await buildTextOnlyPromptHandoff({
        id: `id-${cause}`,
        createdAt: 1,
        content: contentWithOneImage("hello"),
        reason: "Reason.",
        cause,
      });
      return JSON.stringify(snapshot.entry.content);
    }
    expect(await noteFor("missing")).toContain(
      "the bytes are no longer on this device",
    );
    expect(await noteFor("timed-out")).toContain(
      "the bytes could not be read in time",
    );
    expect(await noteFor("capacity")).toContain(
      "it did not fit in the prompt stash",
    );
  });

  it("the text and the qualification both survive alongside the dropped-image note", async () => {
    const TEXT = "the words the user actually typed";
    const snapshot = await buildTextOnlyPromptHandoff({
      id: "id-survive",
      createdAt: 1,
      content: contentWithOneImage(TEXT),
      reason: "Reason.",
      cause: "capacity",
    });
    const text = JSON.stringify(snapshot.entry.content);
    expect(text).toContain(TEXT);
    expect(text).toContain("Reason.");
    expect(snapshot.entry.blobHashes).toEqual([]);
    expect(text).not.toContain("hash");
  });
});
