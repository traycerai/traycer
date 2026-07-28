import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  draftRuntimeRegistry,
  type DraftSubmissionPlacement,
} from "@/stores/home/draft-runtime-registry";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";

const PLACEMENT: DraftSubmissionPlacement = {
  refKey: "draft:test",
  activeItemId: "tab:draft:test",
  focusedRefKey: "draft:test",
  layoutRevision: "test-layout",
};

function content(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function imageContent(hash: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: `image-${hash}`,
              fileName: "image.png",
              hash,
              mimeType: "image/png",
              size: 1,
            },
          },
        ],
      },
    ],
  };
}

describe("DraftRuntimeRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    draftRuntimeRegistry.resetForTesting();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  });

  afterEach(() => {
    draftRuntimeRegistry.resetForTesting();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    vi.useRealTimers();
  });

  it("keeps two visible draft mirrors and their pending writes independent", () => {
    useLandingDraftStore.getState().createDraftWithId("draft-a", null);
    useLandingDraftStore.getState().createDraftWithId("draft-b", null);
    const draftA = draftRuntimeRegistry.attach("draft-a");
    const draftB = draftRuntimeRegistry.attach("draft-b");
    if (draftA === null || draftB === null) {
      throw new Error("expected keyed draft runtimes");
    }

    draftA.setSnapshot(content("alpha"), null);
    draftB.setSnapshot(content("bravo"), null);
    draftRuntimeRegistry.detach("draft-a");

    expect(
      useLandingDraftStore
        .getState()
        .drafts.find((draft) => draft.id === "draft-a")?.content,
    ).toEqual(content("alpha"));
    expect(
      useLandingDraftStore
        .getState()
        .drafts.find((draft) => draft.id === "draft-b")?.content,
    ).not.toEqual(content("bravo"));

    vi.advanceTimersByTime(300);

    expect(
      useLandingDraftStore
        .getState()
        .drafts.find((draft) => draft.id === "draft-b")?.content,
    ).toEqual(content("bravo"));
  });

  it("hydrates each runtime from its own durable draft rather than another mirror", () => {
    useLandingDraftStore.getState().createDraftWithId("draft-a", null);
    useLandingDraftStore.getState().createDraftWithId("draft-b", null);
    useLandingDraftStore
      .getState()
      .setDraftContent("draft-a", content("persisted alpha"), null);
    useLandingDraftStore
      .getState()
      .setDraftContent("draft-b", content("persisted bravo"), null);

    const draftA = draftRuntimeRegistry.getOrHydrate("draft-a");
    const draftB = draftRuntimeRegistry.getOrHydrate("draft-b");
    if (draftA === null || draftB === null) {
      throw new Error("expected keyed draft runtimes");
    }

    expect(draftA.store.getState().content).toEqual(content("persisted alpha"));
    expect(draftB.store.getState().content).toEqual(content("persisted bravo"));
  });

  it("allows one attempt per exact draft and aborts a close before create", () => {
    useLandingDraftStore.getState().createDraftWithId("draft-a", null);
    const runtime = draftRuntimeRegistry.attach("draft-a");
    if (runtime === null) throw new Error("expected keyed draft runtime");

    const first = runtime.startSubmission(PLACEMENT);
    if (first === null) throw new Error("expected first submission attempt");

    expect(runtime.startSubmission(PLACEMENT)).toBeNull();
    draftRuntimeRegistry.close("draft-a");

    expect(first.abortController.signal.aborted).toBe(true);
    expect(runtime.canStartCreate(first)).toBe(false);
  });

  it("flushes every pending runtime writer during window teardown", () => {
    useLandingDraftStore.getState().createDraftWithId("draft-a", null);
    const runtime = draftRuntimeRegistry.attach("draft-a");
    if (runtime === null) throw new Error("expected keyed draft runtime");

    runtime.setSnapshot(content("flush before teardown"), null);
    draftRuntimeRegistry.teardown();

    expect(
      useLandingDraftStore
        .getState()
        .drafts.find((draft) => draft.id === "draft-a")?.content,
    ).toEqual(content("flush before teardown"));
  });

  it("aggregates live roots from every runtime instead of one active composer", () => {
    useLandingDraftStore.getState().createDraftWithId("draft-a", null);
    useLandingDraftStore.getState().createDraftWithId("draft-b", null);
    const draftA = draftRuntimeRegistry.attach("draft-a");
    const draftB = draftRuntimeRegistry.attach("draft-b");
    if (draftA === null || draftB === null) {
      throw new Error("expected keyed draft runtimes");
    }

    draftA.setSnapshot(imageContent("hash-a"), null);
    draftB.setSnapshot(imageContent("hash-b"), null);

    expect(draftRuntimeRegistry.liveImageRoots()).toEqual(
      new Set(["hash-a", "hash-b"]),
    );
  });

  it("keeps an in-flight submission snapshot rooted after its live mirror changes", () => {
    useLandingDraftStore.getState().createDraftWithId("draft-a", null);
    const runtime = draftRuntimeRegistry.attach("draft-a");
    if (runtime === null) throw new Error("expected keyed draft runtime");

    runtime.setSnapshot(imageContent("submit-hash"), null);
    const attempt = runtime.startSubmission(PLACEMENT);
    if (attempt === null) throw new Error("expected submission attempt");
    runtime.setSnapshot(content("new live text"), null);

    expect(draftRuntimeRegistry.liveImageRoots()).toContain("submit-hash");
    draftRuntimeRegistry.complete(attempt);
    expect(draftRuntimeRegistry.liveImageRoots()).not.toContain("submit-hash");
  });

  it("keeps a submission current when the editor re-emits identical content", () => {
    // Tiptap's `setEditable` emits `update` unconditionally, and the composer
    // flips `disabled={isSubmitting}` the moment a submission starts - so every
    // send re-emits a snapshot whose content is byte-identical but a FRESH
    // object from `getJSON()`. A reference-identity guard treats that as a real
    // edit, and the create's success path then reads `content-changed` and
    // routes the epic to a background tab instead of replacing the draft in
    // place, leaving the sent prompt sitting in the landing composer.
    useLandingDraftStore.getState().createDraftWithId("draft-a", null);
    const runtime = draftRuntimeRegistry.attach("draft-a");
    if (runtime === null) throw new Error("expected keyed draft runtime");

    runtime.setSnapshot(content("send me"), null);
    const attempt = runtime.startSubmission(PLACEMENT);
    if (attempt === null) throw new Error("expected submission attempt");

    // Same text, new object - exactly what `getJSON()` hands back.
    runtime.setSnapshot(content("send me"), null);

    expect(draftRuntimeRegistry.settlement(attempt)).toEqual({
      kind: "current",
    });

    // A real edit still retires the placement.
    runtime.setSnapshot(content("send me too"), null);
    expect(draftRuntimeRegistry.settlement(attempt)).toEqual({
      kind: "content-changed",
    });
  });

  it("tracks a caret move without counting it as a content change", () => {
    // `onSelectionUpdate` re-emits the same document on every caret move. That
    // must update the stored selection (the draft restores its caret) without
    // bumping the revision an in-flight submission is pinned to.
    useLandingDraftStore.getState().createDraftWithId("draft-a", null);
    const runtime = draftRuntimeRegistry.attach("draft-a");
    if (runtime === null) throw new Error("expected keyed draft runtime");

    runtime.setSnapshot(content("caret"), { from: 1, to: 1 });
    const revision = runtime.store.getState().contentRevision;

    runtime.setSnapshot(content("caret"), { from: 3, to: 5 });

    expect(runtime.store.getState().selection).toEqual({ from: 3, to: 5 });
    expect(runtime.store.getState().contentRevision).toBe(revision);
  });

  it("releases a retired attempt by identity after same-id rehydration without touching the new runtime", () => {
    useLandingDraftStore.getState().createDraftWithId("draft-a", null);
    const retired = draftRuntimeRegistry.attach("draft-a");
    if (retired === null) throw new Error("expected retired runtime");
    retired.setSnapshot(imageContent("retired-hash"), null);
    const retiredAttempt = retired.startSubmission(PLACEMENT);
    if (retiredAttempt === null || !retired.markCreateStarted(retiredAttempt)) {
      throw new Error("expected committed retired attempt");
    }
    draftRuntimeRegistry.teardown();

    const currentContent = imageContent("current-hash");
    useLandingDraftStore
      .getState()
      .setDraftContent("draft-a", currentContent, null);
    const current = draftRuntimeRegistry.attach("draft-a");
    if (current === null) throw new Error("expected current runtime");

    expect(draftRuntimeRegistry.liveImageRoots()).toEqual(
      new Set(["retired-hash", "current-hash"]),
    );
    draftRuntimeRegistry.complete(retiredAttempt);

    expect(draftRuntimeRegistry.liveImageRoots()).toEqual(
      new Set(["current-hash"]),
    );
    expect(current.store.getState()).toMatchObject({
      content: currentContent,
      isSubmitting: false,
    });
    expect(draftRuntimeRegistry.getOrHydrate("draft-a")).toBe(current);
  });

  it("keeps an older retired generation rooted when a newer same-id generation settles first", () => {
    useLandingDraftStore.getState().createDraftWithId("draft-a", null);
    const firstRuntime = draftRuntimeRegistry.attach("draft-a");
    if (firstRuntime === null) throw new Error("expected first runtime");
    firstRuntime.setSnapshot(imageContent("first-hash"), null);
    const firstAttempt = firstRuntime.startSubmission(PLACEMENT);
    if (
      firstAttempt === null ||
      !firstRuntime.markCreateStarted(firstAttempt)
    ) {
      throw new Error("expected first committed attempt");
    }
    draftRuntimeRegistry.teardown();

    useLandingDraftStore
      .getState()
      .setDraftContent("draft-a", imageContent("second-hash"), null);
    const secondRuntime = draftRuntimeRegistry.attach("draft-a");
    if (secondRuntime === null) throw new Error("expected second runtime");
    const secondAttempt = secondRuntime.startSubmission(PLACEMENT);
    if (
      secondAttempt === null ||
      !secondRuntime.markCreateStarted(secondAttempt)
    ) {
      throw new Error("expected second committed attempt");
    }
    draftRuntimeRegistry.teardown();

    expect(draftRuntimeRegistry.liveImageRoots()).toEqual(
      new Set(["first-hash", "second-hash"]),
    );
    draftRuntimeRegistry.complete(secondAttempt);
    expect(draftRuntimeRegistry.liveImageRoots()).toEqual(
      new Set(["first-hash"]),
    );
    draftRuntimeRegistry.complete(firstAttempt);
    expect(draftRuntimeRegistry.liveImageRoots()).toEqual(new Set());
  });
});
