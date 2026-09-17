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
import type { BrowserAnnotationRecord } from "@/lib/browser-view/annotation/browser-annotation-record";

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

function annotationRecord(imageHash: string): BrowserAnnotationRecord {
  return {
    kind: "browser-annotation",
    annotationId: "ann-cause",
    tabId: "tab-1",
    sessionId: "session-1",
    origin: "https://example.test",
    pageUrl: "https://example.test/checkout",
    pageTitle: "Checkout",
    capturedAt: 1_700_000_000_000,
    comment: "the button is misaligned",
    counts: { elements: 1, regions: 0, strokes: 2 },
    elements: [],
    imageFileName: "crop.png",
    imageHash,
    droppedElementCount: 0,
  };
}

const CAUSES: readonly DroppedImageCause[] = [
  "missing",
  "timed-out",
  "too-large",
  "capacity",
  "unprepared",
];

const DROPPED_IMAGE_CLAUSE_FRAGMENT: Readonly<
  Record<DroppedImageCause, string>
> = {
  missing: "the bytes are no longer on this device",
  "timed-out": "the bytes could not be read in time",
  "too-large": "it was over the size limit for a stashed image",
  capacity: "it did not fit in the prompt stash",
  unprepared: "it could not be prepared for the stash",
};

describe("R6F3: DroppedImageCause produces a distinct, truthful note per cause", () => {
  it("every cause's note is unique text (DRIVE RED)", async () => {
    const notes = new Map<DroppedImageCause, string>();
    for (const cause of CAUSES) {
      const snapshot = await buildTextOnlyPromptHandoff({
        id: `id-${cause}`,
        createdAt: 1,
        content: contentWithOneImage("hello"),
        reason: "Reason.",
        browserAnnotations: [],
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
        browserAnnotations: [],
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
      browserAnnotations: [],
      cause: "capacity",
    });
    const text = JSON.stringify(snapshot.entry.content);
    expect(text).toContain(TEXT);
    expect(text).toContain("Reason.");
    expect(snapshot.entry.blobHashes).toEqual([]);
    expect(text).not.toContain("hash");
  });

  it("states a dropped annotation WITHOUT borrowing the image's cause (DRIVE RED)", async () => {
    // This path has a `DroppedImageCause`, and it belongs to the DOCUMENT
    // image. Reusing it for the sidecar blames the crop for something that
    // did not happen to it: under `missing`, the image resolver aborts before
    // annotation capture is ever reached, so the crop is untouched and
    // perfectly readable - yet the entry would announce that its bytes are no
    // longer on this device. Records are dropped here because this path
    // carries no blobs at all, which is a structural decision rather than a
    // failure of these bytes.
    for (const cause of CAUSES) {
      const snapshot = await buildTextOnlyPromptHandoff({
        id: `id-annotation-${cause}`,
        createdAt: 1,
        content: contentWithOneImage("hello"),
        browserAnnotations: [annotationRecord("crop-hash")],
        reason: "Not accepted.",
        cause,
      });
      const text = JSON.stringify(snapshot.entry.content);
      expect(text).toContain("A browser annotation was not saved with it.");
      // The image sentence still carries its own cause; the annotation one
      // must not inherit it.
      expect(text).toContain(DROPPED_IMAGE_CLAUSE_FRAGMENT[cause]);
      expect(text).not.toContain(
        `A browser annotation was not saved with it: ${DROPPED_IMAGE_CLAUSE_FRAGMENT[cause]}`,
      );
    }
  });
});
