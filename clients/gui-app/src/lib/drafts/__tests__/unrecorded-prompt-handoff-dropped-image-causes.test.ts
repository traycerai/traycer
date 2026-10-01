/**
 * R6F3: `buildTextOnlyPromptHandoff`'s appended note differs truthfully by
 * `DroppedImageCause` - "we could not find your picture" and "your picture
 * did not fit" are different facts, and a reader deciding whether to resend
 * needs the right one.
 *
 * The note now rides in a closed start-page draft rather than a stash entry,
 * so every assertion reads the installed draft's content. The image node is
 * dropped before any resolver would ever run, so this needs no image-decoding
 * stub.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { BrowserAnnotationRecord } from "@/lib/browser-view/annotation/browser-annotation-record";

import {
  buildTextOnlyPromptHandoff,
  type DroppedImageCause,
} from "@/lib/drafts/unrecorded-prompt-handoff";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";

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
  "capacity",
  "unsupported",
  "unprepared",
];

const DROPPED_IMAGE_CLAUSE_FRAGMENT: Readonly<
  Record<DroppedImageCause, string>
> = {
  missing: "the bytes are no longer on this device",
  "timed-out": "the bytes could not be read in time",
  capacity: "it did not fit in this window's image budget",
  unsupported: "its format cannot be kept in a draft",
  unprepared: "it could not be prepared for a draft",
};

/** Always current: every handoff mints a new draft id. */
function installedText(draftId: string | null): string {
  const draft = useLandingDraftStore
    .getState()
    .drafts.find((row) => row.id === draftId);
  if (draft === undefined) throw new Error("expected an installed draft");
  return JSON.stringify(draft.content);
}

beforeEach(() => {
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
});

describe("R6F3: DroppedImageCause produces a distinct, truthful note per cause", () => {
  it("every cause's note is unique text (DRIVE RED)", async () => {
    const notes = new Map<DroppedImageCause, string>();
    for (const cause of CAUSES) {
      const { draftId } = await buildTextOnlyPromptHandoff({
        content: contentWithOneImage("hello"),
        reason: "Reason.",
        browserAnnotations: [],
        cause,
        stillCurrent: () => true,
      });
      notes.set(cause, installedText(draftId));
    }
    // Every note is different text - no two causes are described the same
    // way.
    expect(new Set(notes.values()).size).toBe(CAUSES.length);
  });

  it("the three most user-visible causes name their own, correct fact (DRIVE RED)", async () => {
    async function noteFor(cause: DroppedImageCause): Promise<string> {
      const { draftId } = await buildTextOnlyPromptHandoff({
        content: contentWithOneImage("hello"),
        reason: "Reason.",
        browserAnnotations: [],
        cause,
        stillCurrent: () => true,
      });
      return installedText(draftId);
    }
    expect(await noteFor("missing")).toContain(
      "the bytes are no longer on this device",
    );
    expect(await noteFor("timed-out")).toContain(
      "the bytes could not be read in time",
    );
    expect(await noteFor("capacity")).toContain(
      "it did not fit in this window's image budget",
    );
  });

  it("the text and the qualification both survive alongside the dropped-image note", async () => {
    const TEXT = "the words the user actually typed";
    const { draftId } = await buildTextOnlyPromptHandoff({
      content: contentWithOneImage(TEXT),
      reason: "Reason.",
      browserAnnotations: [],
      cause: "capacity",
      stillCurrent: () => true,
    });
    const text = installedText(draftId);
    expect(text).toContain(TEXT);
    expect(text).toContain("Reason.");
    expect(text).not.toContain("hash");
    expect(text).not.toContain("imageAttachment");
  });

  it("installs a CLOSED draft and leaves the active one alone", async () => {
    // The row is a put-away draft, not a tab the disposal steals focus into:
    // the handoff runs during teardown, when the user is looking at something
    // else entirely.
    useLandingDraftStore.setState({ activeDraftId: "somebody-elses-draft" });
    const { draftId } = await buildTextOnlyPromptHandoff({
      content: contentWithOneImage("hello"),
      reason: "Reason.",
      browserAnnotations: [],
      cause: "capacity",
      stillCurrent: () => true,
    });
    const draft = useLandingDraftStore
      .getState()
      .drafts.find((row) => row.id === draftId);
    expect(draft?.closed).toBe(true);
    expect(useLandingDraftStore.getState().activeDraftId).toBe(
      "somebody-elses-draft",
    );
  });

  it("installs NOTHING once the identity fence has moved (DRIVE RED)", async () => {
    const { draftId } = await buildTextOnlyPromptHandoff({
      content: contentWithOneImage("a prompt from the outgoing account"),
      reason: "Reason.",
      browserAnnotations: [],
      cause: "capacity",
      stillCurrent: () => false,
    });
    expect(draftId).toBeNull();
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
  });

  it("states a dropped annotation WITHOUT borrowing the image's cause (DRIVE RED)", async () => {
    // This path has a `DroppedImageCause`, and it belongs to the DOCUMENT
    // image. Reusing it for the sidecar blames the crop for something that
    // did not happen to it: under `missing`, the image resolver aborts before
    // annotation capture is ever reached, so the crop is untouched and
    // perfectly readable - yet the draft would announce that its bytes are no
    // longer on this device. Records are dropped here because a landing draft
    // has no annotation sidecar at all, which is a structural decision rather
    // than a failure of these bytes.
    for (const cause of CAUSES) {
      const { draftId } = await buildTextOnlyPromptHandoff({
        content: contentWithOneImage("hello"),
        browserAnnotations: [annotationRecord("crop-hash")],
        reason: "Not accepted.",
        cause,
        stillCurrent: () => true,
      });
      const text = installedText(draftId);
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
