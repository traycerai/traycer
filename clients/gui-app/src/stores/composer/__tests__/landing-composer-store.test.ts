import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  flushPendingLandingDraftContent,
  useLandingComposerStore,
} from "@/stores/composer/landing-composer-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { containsImageAtoms } from "@/lib/composer/image-atoms";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";

function content(text: string): JsonContent {
  if (text.length === 0) {
    return { type: "doc", content: [{ type: "paragraph" }] };
  }
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function draftText(id: string): string | undefined {
  const draft = useLandingDraftStore
    .getState()
    .drafts.find((entry) => entry.id === id);
  return draft === undefined
    ? undefined
    : extractPlainTextFromComposerJSONContent(draft.content);
}

function imageContent(id: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id,
              fileName: "shot.png",
              b64content: "cG5n",
              mimeType: "image/png",
              size: 3,
            },
          },
        ],
      },
    ],
  };
}

describe("landing-composer-store draft binding", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    useLandingComposerStore.getState().reset();
  });

  afterEach(() => {
    vi.useRealTimers();
    flushPendingLandingDraftContent();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    useLandingComposerStore.getState().reset();
  });

  it("creates the draft synchronously on the first non-empty null-binding edit", () => {
    useLandingComposerStore
      .getState()
      .setSnapshot(null, content("hello"), null);

    const drafts = useLandingDraftStore.getState().drafts;
    expect(drafts).toHaveLength(1);
    expect(drafts[0].content).toEqual(content("hello"));
    expect(useLandingDraftStore.getState().activeDraftId).toBe(drafts[0].id);
  });

  it("keeps same-tick null-binding snapshots on the one created draft", () => {
    const store = useLandingComposerStore.getState();
    store.setSnapshot(null, content("first"), null);
    store.setSnapshot(null, content("first second"), null);

    const drafts = useLandingDraftStore.getState().drafts;
    expect(drafts).toHaveLength(1);
    // Pre-remount writes are synchronous so the keyed remount reads back the
    // latest content, never a value frozen mid-debounce.
    expect(drafts[0].content).toEqual(content("first second"));
  });

  it("creates a draft for image-only null-binding edits", () => {
    useLandingComposerStore
      .getState()
      .setSnapshot(null, imageContent("img-1"), null);

    const drafts = useLandingDraftStore.getState().drafts;
    expect(drafts).toHaveLength(1);
    expect(containsImageAtoms(drafts[0].content)).toBe(true);
    expect(useLandingDraftStore.getState().activeDraftId).toBe(drafts[0].id);
  });

  it("seeds currentContent from the bound draft on openDraft", () => {
    const id = useLandingDraftStore.getState().createDraft(null);
    useLandingDraftStore
      .getState()
      .setDraftContent(id, content("persisted text"), null);

    const seeded = useLandingComposerStore.getState().openDraft(id);

    expect(seeded).toEqual(content("persisted text"));
    expect(useLandingComposerStore.getState().currentContent).toBe(seeded);
  });

  it("reopens a bound draft from the remembered full editor content", () => {
    const draftA = useLandingDraftStore.getState().createDraft(null);
    const draftB = useLandingDraftStore.getState().createDraft(null);
    useLandingComposerStore.getState().openDraft(draftA);
    useLandingComposerStore
      .getState()
      .setSnapshot(draftA, imageContent("img-1"), null);

    // openDraft(draftB) flushes the pending debounced write to draftA, so
    // reopening draftA seeds from its now-persisted full editor content.
    useLandingComposerStore.getState().openDraft(draftB);
    const reopened = useLandingComposerStore.getState().openDraft(draftA);

    expect(containsImageAtoms(reopened)).toBe(true);
    expect(reopened).toEqual(imageContent("img-1"));
  });

  it("lands a trailing debounced write on the BOUND draft, not the active one", () => {
    vi.useFakeTimers();
    const draftA = useLandingDraftStore.getState().createDraft(null);
    const draftB = useLandingDraftStore.getState().createDraft(null);
    useLandingDraftStore.getState().setActiveDraft(draftA);
    useLandingComposerStore.getState().openDraft(draftA);

    // A keystroke schedules the debounced write for draft A...
    useLandingComposerStore
      .getState()
      .setSnapshot(draftA, content("edit A"), null);
    // ...then the user switches to draft B before the debounce fires.
    useLandingDraftStore.getState().setActiveDraft(draftB);
    vi.runAllTimers();

    expect(draftText(draftA)).toBe("edit A");
    expect(draftText(draftB)).toBe("");
  });

  it("flushes the previous binding's pending write when a new draft opens", () => {
    vi.useFakeTimers();
    const draftA = useLandingDraftStore.getState().createDraft(null);
    const draftB = useLandingDraftStore.getState().createDraft(null);
    useLandingComposerStore.getState().openDraft(draftA);
    useLandingComposerStore
      .getState()
      .setSnapshot(draftA, content("edit A"), null);

    // Rebinding (the keyed remount's mount path) commits the trailing write
    // immediately so returning to draft A restores the latest content.
    useLandingComposerStore.getState().openDraft(draftB);

    expect(draftText(draftA)).toBe("edit A");
    expect(draftText(draftB)).toBe("");
  });

  it("reset cancels a pending write and clears the session", () => {
    vi.useFakeTimers();
    const draftA = useLandingDraftStore.getState().createDraft(null);
    useLandingComposerStore.getState().openDraft(draftA);
    useLandingComposerStore
      .getState()
      .setSnapshot(draftA, content("typed"), null);

    useLandingComposerStore.getState().reset();
    vi.runAllTimers();

    expect(draftText(draftA)).toBe("");
    expect(useLandingComposerStore.getState().currentContent).toEqual(
      content(""),
    );
    expect(useLandingComposerStore.getState().createdDraftId).toBeNull();
  });
});
