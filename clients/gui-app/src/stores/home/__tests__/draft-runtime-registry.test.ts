import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { DraftSelection } from "@/stores/composer/composer-draft-store";
import {
  draftRuntimeRegistry,
  type DraftSubmissionPlacement,
} from "@/stores/home/draft-runtime-registry";
import * as landingDraftContent from "@/stores/home/landing-draft-content";
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

/**
 * ~2 MiB inline-image document. Large enough that accidental whole-document
 * `JSON.stringify` on a selection-only flush shows up as O(document) work.
 * Mirrors the Ticket 2 `multiMegabyteImageDoc` helper.
 */
function multiMegabyteImageDoc(): JsonContent {
  const b64content = "B".repeat(2 * 1024 * 1024);
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: "megabyte",
              fileName: "megabyte.png",
              hash: null,
              b64content,
              mimeType: "image/png",
              size: b64content.length,
            },
          },
        ],
      },
    ],
  };
}

/**
 * Counts `JSON.stringify` calls that directly serialize `content` (the old
 * `sameJsonContent` shape). Zustand persist may still stringify the store
 * envelope - that is durability, not a content-comparison path.
 */
function contentComparisonStringifies(
  spy: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  contentValue: JsonContent,
): number {
  return spy.mock.calls.filter((call) => call[0] === contentValue).length;
}

/**
 * Wire the real landing-draft store as the registry source. Module load does
 * this once; tests that reconfigure for write spies must restore afterward.
 * Spying zustand action methods directly is unreliable: `setState` copies the
 * spy onto the next state object and `vi.restoreAllMocks` cannot unwind it.
 */
function configureLandingDraftSource(): void {
  draftRuntimeRegistry.configure({
    read: (draftId) => {
      const draft = useLandingDraftStore
        .getState()
        .drafts.find((entry) => entry.id === draftId);
      return draft === undefined
        ? null
        : { content: draft.content, selection: draft.selection };
    },
    write: (draftId, content, selection) => {
      useLandingDraftStore
        .getState()
        .setDraftContent(draftId, content, selection);
    },
    writeSelection: (draftId, selection) => {
      useLandingDraftStore.getState().setDraftSelection(draftId, selection);
    },
  });
}

/** Spies at the registry source boundary (stable across zustand setState). */
function spyRegistryWrites() {
  const setDraftContentSpy = vi.fn(
    (
      _draftId: string,
      _content: JsonContent,
      _selection: DraftSelection | null,
    ) => {
      // Record-only spy; the real store write runs below.
    },
  );
  const setDraftSelectionSpy = vi.fn(
    (_draftId: string, _selection: DraftSelection | null) => {
      // Record-only spy; the real store write runs below.
    },
  );
  draftRuntimeRegistry.configure({
    read: (draftId) => {
      const draft = useLandingDraftStore
        .getState()
        .drafts.find((entry) => entry.id === draftId);
      return draft === undefined
        ? null
        : { content: draft.content, selection: draft.selection };
    },
    write: (draftId, content, selection) => {
      setDraftContentSpy(draftId, content, selection);
      useLandingDraftStore
        .getState()
        .setDraftContent(draftId, content, selection);
    },
    writeSelection: (draftId, selection) => {
      setDraftSelectionSpy(draftId, selection);
      useLandingDraftStore.getState().setDraftSelection(draftId, selection);
    },
  });
  return { setDraftContentSpy, setDraftSelectionSpy };
}

describe("DraftRuntimeRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    draftRuntimeRegistry.resetForTesting();
    configureLandingDraftSource();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  });

  afterEach(() => {
    draftRuntimeRegistry.resetForTesting();
    configureLandingDraftSource();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  it("keeps a submission current when only the caret moves after submit", () => {
    // Under the event-driven contract, `setSnapshot` is only called for real
    // document mutations (Tiptap's `docChanged`-gated `update`). The old
    // `setEditable` phantom that re-emitted identical content through
    // `setSnapshot` can no longer happen: production passes
    // `setEditable(!disabled, false)` and selection moves go through
    // `setSelection`. A caret-only path after submit must keep settlement
    // current; a real document edit still retires the placement.
    useLandingDraftStore.getState().createDraftWithId("draft-a", null);
    const runtime = draftRuntimeRegistry.attach("draft-a");
    if (runtime === null) throw new Error("expected keyed draft runtime");

    runtime.setSnapshot(content("send me"), null);
    const attempt = runtime.startSubmission(PLACEMENT);
    if (attempt === null) throw new Error("expected submission attempt");

    runtime.setSelection({ from: 2, to: 2 });

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
    // Selection-only updates must go through `setSelection`: update the
    // stored caret (draft restores it on reopen) without bumping the
    // revision an in-flight submission is pinned to, and still schedule the
    // debounced durable flush so the selection lands in the landing draft.
    useLandingDraftStore.getState().createDraftWithId("draft-a", null);
    const runtime = draftRuntimeRegistry.attach("draft-a");
    if (runtime === null) throw new Error("expected keyed draft runtime");

    runtime.setSnapshot(content("caret"), { from: 1, to: 1 });
    const revision = runtime.store.getState().contentRevision;

    runtime.setSelection({ from: 3, to: 5 });

    expect(runtime.store.getState().selection).toEqual({ from: 3, to: 5 });
    expect(runtime.store.getState().contentRevision).toBe(revision);

    vi.advanceTimersByTime(300);

    expect(
      useLandingDraftStore
        .getState()
        .drafts.find((draft) => draft.id === "draft-a")?.selection,
    ).toEqual({ from: 3, to: 5 });
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

  it("selection-only flush after debounce never compares multi-megabyte content", () => {
    // Ticket 2 proved the *synchronous* setSelection path stays cheap; this
    // advances fake timers through the real 300ms debounce and proves the
    // *deferred* write also goes through writeSelection / setDraftSelection
    // without sameJsonContent or a direct content JSON.stringify.
    useLandingDraftStore.getState().createDraftWithId("draft-mega", null);
    const runtime = draftRuntimeRegistry.attach("draft-mega");
    if (runtime === null) throw new Error("expected keyed draft runtime");

    const megaContent = multiMegabyteImageDoc();
    runtime.setSnapshot(megaContent, { from: 1, to: 1 });
    vi.advanceTimersByTime(300);

    const durableAfterSeed = useLandingDraftStore
      .getState()
      .drafts.find((draft) => draft.id === "draft-mega");
    expect(durableAfterSeed?.content).toBe(megaContent);
    expect(durableAfterSeed?.selection).toEqual({ from: 1, to: 1 });

    const sameJsonSpy = vi.spyOn(landingDraftContent, "sameJsonContent");
    const stringifySpy = vi.spyOn(JSON, "stringify");
    const sameJsonBefore = sameJsonSpy.mock.calls.length;
    const comparisonsBefore = contentComparisonStringifies(
      stringifySpy,
      megaContent,
    );

    const selections = [
      { from: 2, to: 2 },
      { from: 3, to: 3 },
      { from: 1, to: 4 },
      { from: 5, to: 5 },
    ] as const;
    for (const selection of selections) {
      runtime.setSelection(selection);
    }

    vi.advanceTimersByTime(300);

    expect(sameJsonSpy.mock.calls.length).toBe(sameJsonBefore);
    expect(contentComparisonStringifies(stringifySpy, megaContent)).toBe(
      comparisonsBefore,
    );
    expect(
      useLandingDraftStore
        .getState()
        .drafts.find((draft) => draft.id === "draft-mega")?.selection,
    ).toEqual({ from: 5, to: 5 });
  });

  it("coalesces a selection into a pending document write as one setDraftContent", () => {
    useLandingDraftStore.getState().createDraftWithId("draft-a", null);
    const runtime = draftRuntimeRegistry.attach("draft-a");
    if (runtime === null) throw new Error("expected keyed draft runtime");

    const contentA = content("alpha body");
    const selA = { from: 1, to: 1 };
    const selB = { from: 4, to: 7 };

    const { setDraftContentSpy, setDraftSelectionSpy } = spyRegistryWrites();

    runtime.setSnapshot(contentA, selA);
    runtime.setSelection(selB);
    // Both still pending - nothing durable yet.
    expect(setDraftContentSpy).not.toHaveBeenCalled();
    expect(setDraftSelectionSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);

    expect(setDraftContentSpy).toHaveBeenCalledTimes(1);
    expect(setDraftContentSpy).toHaveBeenCalledWith("draft-a", contentA, selB);
    expect(setDraftSelectionSpy).not.toHaveBeenCalled();

    const durable = useLandingDraftStore
      .getState()
      .drafts.find((draft) => draft.id === "draft-a");
    expect(durable?.content).toEqual(contentA);
    expect(durable?.selection).toEqual(selB);
  });

  it("setSnapshot supersedes a pending selection-only write with one document write", () => {
    useLandingDraftStore.getState().createDraftWithId("draft-a", null);
    const runtime = draftRuntimeRegistry.attach("draft-a");
    if (runtime === null) throw new Error("expected keyed draft runtime");

    const contentA = content("snapshot wins");
    const selA = { from: 2, to: 2 };
    const selB = { from: 9, to: 9 };

    const { setDraftContentSpy, setDraftSelectionSpy } = spyRegistryWrites();

    runtime.setSelection(selB);
    runtime.setSnapshot(contentA, selA);

    expect(setDraftContentSpy).not.toHaveBeenCalled();
    expect(setDraftSelectionSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);

    // Document write fully replaces the earlier selection-only intent - one
    // write lands contentA + selA; no separate setDraftSelection flush.
    expect(setDraftContentSpy).toHaveBeenCalledTimes(1);
    expect(setDraftContentSpy).toHaveBeenCalledWith("draft-a", contentA, selA);
    expect(setDraftSelectionSpy).not.toHaveBeenCalled();

    const durable = useLandingDraftStore
      .getState()
      .drafts.find((draft) => draft.id === "draft-a");
    expect(durable?.content).toEqual(contentA);
    expect(durable?.selection).toEqual(selA);
  });

  it("detach flushes a selection-only pending write through setDraftSelection", () => {
    useLandingDraftStore.getState().createDraftWithId("draft-a", null);
    const runtime = draftRuntimeRegistry.attach("draft-a");
    if (runtime === null) throw new Error("expected keyed draft runtime");

    runtime.setSnapshot(content("seed"), { from: 1, to: 1 });
    vi.advanceTimersByTime(300);

    const { setDraftContentSpy, setDraftSelectionSpy } = spyRegistryWrites();

    const nextSelection = { from: 3, to: 6 };
    runtime.setSelection(nextSelection);
    // Synchronous detach flush - do not advance timers.
    draftRuntimeRegistry.detach("draft-a");

    expect(setDraftContentSpy).not.toHaveBeenCalled();
    expect(setDraftSelectionSpy).toHaveBeenCalledTimes(1);
    expect(setDraftSelectionSpy).toHaveBeenCalledWith("draft-a", nextSelection);
    expect(
      useLandingDraftStore
        .getState()
        .drafts.find((draft) => draft.id === "draft-a")?.selection,
    ).toEqual(nextSelection);
  });

  it("roots and contents stay correct for a pending selection-only write", () => {
    useLandingDraftStore.getState().createDraftWithId("draft-a", null);
    const runtime = draftRuntimeRegistry.attach("draft-a");
    if (runtime === null) throw new Error("expected keyed draft runtime");

    const seeded = imageContent("live-hash");
    runtime.setSnapshot(seeded, { from: 1, to: 1 });
    vi.advanceTimersByTime(300);

    const rootsBefore = new Set(runtime.roots());
    const contentsBefore = runtime.contents();
    expect(rootsBefore).toEqual(new Set(["live-hash"]));
    expect(contentsBefore).toEqual([seeded]);

    runtime.setSelection({ from: 2, to: 2 });

    // Pending selection-only has no `.content` - must not throw or invent a
    // phantom root; store live content/attachmentRoots already cover it.
    expect(() => runtime.roots()).not.toThrow();
    expect(() => runtime.contents()).not.toThrow();
    expect(runtime.roots()).toEqual(rootsBefore);
    expect(runtime.contents()).toEqual(contentsBefore);
    expect(draftRuntimeRegistry.liveImageRoots()).toEqual(
      new Set(["live-hash"]),
    );
    expect(draftRuntimeRegistry.liveContents()).toEqual([seeded]);
  });
});
