/**
 * Landing surface prompt-stash CAS against real draft runtimes
 * (contentRevision) and the unbound Zustand store mirror. Uses the real
 * production hooks (`landingStashIdentity`, `useLandingPromptStashSource`)
 * without mounting the full LandingComposer tree.
 *
 * Also covers Ticket 1 source-lifetime: a delayed stash save must not clear
 * a reopened draft runtime after surface detach (retiredRef + draftId lookup).
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { createStore, type StoreApi } from "zustand/vanilla";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { RefObject } from "react";
import { toast } from "sonner";

import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import {
  landingStashIdentity,
  useLandingPromptStashDestination,
  useLandingPromptStashSource,
} from "@/components/home/composer/use-landing-prompt-stash-adapters";
import { usePromptStash } from "@/hooks/composer/use-prompt-stash";
import {
  draftRuntimeRegistry,
  EMPTY_DRAFT_RUNTIME_CONTENT,
  type DraftRuntimeState,
} from "@/stores/home/draft-runtime-registry";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { usePromptStashStore } from "@/stores/composer/prompt-stash-store";

const storeMocks = vi.hoisted(() => ({
  save: vi.fn(),
  remove: vi.fn(),
  hydrate: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("@/stores/composer/prompt-stash-store", () => {
  const state = {
    rows: [] as unknown[],
    hydrate: storeMocks.hydrate,
    save: storeMocks.save,
    remove: storeMocks.remove,
    markUnavailable: (_id: string) => undefined,
  };
  const usePromptStashStoreMock = Object.assign(
    (selector: (s: typeof state) => unknown) => selector(state),
    {
      getState: () => state,
      setState: (partial: Partial<typeof state>) => {
        Object.assign(state, partial);
      },
    },
  );
  return { usePromptStashStore: usePromptStashStoreMock };
});

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("uuid", () => ({
  v4: vi.fn(() => "landing-stash-entry-id"),
}));

function textDoc(text: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

function makeEditorHandle(
  options:
    | {
        ready?: boolean;
        onClear?: () => void;
      }
    | undefined,
): ComposerPromptEditorHandle {
  return {
    isReady: () => options?.ready ?? true,
    hasFocus: () => false,
    focus: () => undefined,
    focusAtEnd: () => undefined,
    getJSON: () => textDoc("live"),
    isEmpty: () => false,
    clear: () => {
      options?.onClear?.();
    },
    setContent: () => undefined,
    syncContent: () => undefined,
    insertImageAttachments: () => undefined,
    beginPathInsertion: () => null,
    removeImageAttachmentById: () => undefined,
    rewriteImageAttachmentHashById: () => false,
    insertDictatedText: () => undefined,
    dismissActiveSuggestion: () => false,
  };
}

function renderLandingSource(args: {
  readonly stashIdentity: string;
  readonly runtimeStore: StoreApi<DraftRuntimeState>;
  readonly draftId: string | null;
  readonly unboundRuntime: StoreApi<DraftRuntimeState>;
  readonly editorRef: { current: ComposerPromptEditorHandle | null };
}) {
  return renderHook(() =>
    useLandingPromptStashSource({
      stashIdentity: args.stashIdentity,
      runtimeStore: args.runtimeStore,
      draftId: args.draftId,
      unboundRuntime: args.unboundRuntime,
      editorRef: args.editorRef,
    }),
  );
}

function makeReadyEditor(
  content: JsonContent,
): RefObject<ComposerPromptEditorHandle | null> {
  const handle = makeEditorHandle({ ready: true });
  // stashCurrent requires a ready editor; clear path is forced via nulling
  // editorRef mid-flight (simulates composer unmount).
  const ref: { current: ComposerPromptEditorHandle | null } = {
    current: {
      ...handle,
      getJSON: () => content,
    },
  };
  return ref;
}

function useLandingPromptStashController(args: {
  readonly draftId: string;
  readonly runtimeStore: StoreApi<DraftRuntimeState>;
  readonly unboundRuntime: StoreApi<DraftRuntimeState>;
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null>;
}) {
  const stashIdentity = landingStashIdentity(args.draftId, null);
  const source = useLandingPromptStashSource({
    stashIdentity,
    runtimeStore: args.runtimeStore,
    draftId: args.draftId,
    unboundRuntime: args.unboundRuntime,
    editorRef: args.editorRef,
  });
  const destination = useLandingPromptStashDestination({
    stashIdentity,
    draftId: args.draftId,
    runtimeStore: args.runtimeStore,
    editorRef: args.editorRef,
  });
  return usePromptStash({
    active: true,
    disabled: false,
    editorRef: args.editorRef,
    readHashImage: () => Promise.resolve(null),
    source,
    destination,
  });
}

describe("landing composer prompt-stash source CAS", () => {
  beforeEach(() => {
    storeMocks.save.mockReset();
    storeMocks.remove.mockReset();
    storeMocks.hydrate.mockReset();
    storeMocks.hydrate.mockResolvedValue(undefined);
    storeMocks.save.mockResolvedValue(undefined);
    storeMocks.remove.mockResolvedValue(undefined);
    usePromptStashStore.setState({
      rows: [],
    });
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.warning).mockClear();
    vi.mocked(toast.success).mockClear();
    draftRuntimeRegistry.resetForTesting();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  });

  afterEach(() => {
    cleanup();
    draftRuntimeRegistry.resetForTesting();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  });

  it("returns false across unbound→bound promotion (revisions differ; identity also changes)", () => {
    const pendingCreateId = "pending-create-1";
    // Production handleSnapshot on unbound ALWAYS bumps contentRevision
    // (no sameJsonContent gate), so the first submittable keystroke leaves
    // unbound at revision >= 1. Capture against that counter.
    const unboundRuntime = createStore<DraftRuntimeState>(() => ({
      content: textDoc("first keystroke seed"),
      selection: null,
      contentRevision: 1,
      attachmentRoots: new Set(),
      isSubmitting: false,
    }));

    const captureIdentity = landingStashIdentity(null, pendingCreateId);
    // Unbound phase is structurally different from the eventual draft id.
    expect(captureIdentity).toBe(`landing-unbound:${pendingCreateId}`);
    expect(captureIdentity).not.toBe(pendingCreateId);

    const { result: unboundResult } = renderLandingSource({
      stashIdentity: captureIdentity,
      runtimeStore: unboundRuntime,
      draftId: null,
      unboundRuntime,
      editorRef: { current: makeEditorHandle(undefined) },
    });
    const snapshot = unboundResult.current.capture();
    if (snapshot === null) throw new Error("expected snapshot");
    expect(snapshot.token.revision).toBe(1);
    expect(snapshot.token.identity).toBe(`landing-unbound:${pendingCreateId}`);

    // Promote: handleSnapshot's create branch mints the draft under the same
    // pendingCreateId. Bound identity is the draft id itself (no prefix).
    useLandingDraftStore.getState().createDraftWithId(pendingCreateId, null);
    useLandingDraftStore
      .getState()
      .setDraftContent(
        pendingCreateId,
        textDoc("typed during save after bind"),
        null,
      );
    const boundRuntime = draftRuntimeRegistry.attach(pendingCreateId);
    if (boundRuntime === null) throw new Error("expected bound runtime");
    expect(boundRuntime.store.getState().contentRevision).toBe(0);

    const boundIdentity = landingStashIdentity(pendingCreateId, null);
    expect(boundIdentity).toBe(pendingCreateId);
    expect(boundIdentity).not.toBe(captureIdentity);

    // After bind, live identity is the draft id; captured token still carries
    // the unbound-prefixed identity → never mistakenly clear.
    const { result: boundResult } = renderLandingSource({
      stashIdentity: boundIdentity,
      runtimeStore: boundRuntime.store,
      draftId: pendingCreateId,
      unboundRuntime,
      editorRef: { current: makeEditorHandle(undefined) },
    });
    const cleared = boundResult.current.clearIfUnchanged(snapshot.token);
    expect(cleared).toBe(false);
    expect(boundRuntime.store.getState().content).toEqual(
      textDoc("typed during save after bind"),
    );
  });

  it("returns false across unbound→bound even when revision numbers coincide (identity protects)", () => {
    // Explicit collision: force unbound and bound to the SAME numeric
    // revision so only the identity string can prevent a false clear.
    const pendingCreateId = "pending-create-collide";
    const sharedRevision = 0;

    const unboundRuntime = createStore<DraftRuntimeState>(() => ({
      content: textDoc("unbound capture"),
      selection: null,
      contentRevision: sharedRevision,
      attachmentRoots: new Set(),
      isSubmitting: false,
    }));

    const captureIdentity = landingStashIdentity(null, pendingCreateId);
    expect(captureIdentity).toBe(`landing-unbound:${pendingCreateId}`);

    const { result: unboundResult } = renderLandingSource({
      stashIdentity: captureIdentity,
      runtimeStore: unboundRuntime,
      draftId: null,
      unboundRuntime,
      editorRef: { current: makeEditorHandle(undefined) },
    });
    const snapshot = unboundResult.current.capture();
    if (snapshot === null) throw new Error("expected snapshot");
    expect(snapshot.token.revision).toBe(sharedRevision);
    expect(snapshot.token.identity).toBe(`landing-unbound:${pendingCreateId}`);

    useLandingDraftStore.getState().createDraftWithId(pendingCreateId, null);
    useLandingDraftStore
      .getState()
      .setDraftContent(
        pendingCreateId,
        textDoc("bound content after create"),
        null,
      );
    const boundRuntime = draftRuntimeRegistry.attach(pendingCreateId);
    if (boundRuntime === null) throw new Error("expected bound runtime");
    // Fresh bound runtime starts at contentRevision 0 — equal to capture.
    expect(boundRuntime.store.getState().contentRevision).toBe(sharedRevision);

    const boundIdentity = landingStashIdentity(pendingCreateId, null);
    expect(boundIdentity).toBe(pendingCreateId);
    // Identity strings differ even though revision numbers match.
    expect(boundIdentity).not.toBe(snapshot.token.identity);
    expect(boundRuntime.store.getState().contentRevision).toBe(
      snapshot.token.revision,
    );

    const { result: boundResult } = renderLandingSource({
      stashIdentity: boundIdentity,
      runtimeStore: boundRuntime.store,
      draftId: pendingCreateId,
      unboundRuntime,
      editorRef: { current: makeEditorHandle(undefined) },
    });
    const cleared = boundResult.current.clearIfUnchanged(snapshot.token);
    expect(cleared).toBe(false);
    expect(boundRuntime.store.getState().content).toEqual(
      textDoc("bound content after create"),
    );
  });

  it("keeps bound edits when contentRevision moves during the async gap", () => {
    const draftId = "landing-bound-1";
    useLandingDraftStore.getState().createDraftWithId(draftId, null);
    useLandingDraftStore
      .getState()
      .setDraftContent(draftId, textDoc("original"), null);
    const runtime = draftRuntimeRegistry.attach(draftId);
    if (runtime === null) throw new Error("expected runtime");

    const editorRef: { current: ComposerPromptEditorHandle | null } = {
      current: makeEditorHandle(undefined),
    };
    const unboundRuntime = createStore<DraftRuntimeState>(() => ({
      content: EMPTY_DRAFT_RUNTIME_CONTENT,
      selection: null,
      contentRevision: 0,
      attachmentRoots: new Set(),
      isSubmitting: false,
    }));
    const { result } = renderLandingSource({
      stashIdentity: landingStashIdentity(draftId, null),
      runtimeStore: runtime.store,
      draftId,
      unboundRuntime,
      editorRef,
    });

    const snapshot = result.current.capture();
    if (snapshot === null) throw new Error("expected snapshot");
    expect(snapshot.token.revision).toBe(0);

    // Edit same draftId's runtime before "save resolves".
    runtime.setSnapshot(textDoc("edited mid-save"), null);
    expect(runtime.store.getState().contentRevision).toBe(1);

    const cleared = result.current.clearIfUnchanged(snapshot.token);
    expect(cleared).toBe(false);
    expect(runtime.store.getState().content).toEqual(
      textDoc("edited mid-save"),
    );
  });

  it("clears via store fallback when editor is unmounted and nothing else changed", () => {
    const draftId = "landing-bound-unmount";
    useLandingDraftStore.getState().createDraftWithId(draftId, null);
    useLandingDraftStore
      .getState()
      .setDraftContent(draftId, textDoc("to clear"), null);
    const runtime = draftRuntimeRegistry.attach(draftId);
    if (runtime === null) throw new Error("expected runtime");
    // Seed a real content edit so revision is non-zero and content is non-empty.
    runtime.setSnapshot(textDoc("to clear"), null);

    const editorRef: { current: ComposerPromptEditorHandle | null } = {
      current: null, // editor unmounted (navigated away / draft switched)
    };
    const unboundRuntime = createStore<DraftRuntimeState>(() => ({
      content: EMPTY_DRAFT_RUNTIME_CONTENT,
      selection: null,
      contentRevision: 0,
      attachmentRoots: new Set(),
      isSubmitting: false,
    }));
    const { result } = renderLandingSource({
      stashIdentity: landingStashIdentity(draftId, null),
      runtimeStore: runtime.store,
      draftId,
      unboundRuntime,
      editorRef,
    });

    const snapshot = result.current.capture();
    if (snapshot === null) throw new Error("expected snapshot");

    const cleared = result.current.clearIfUnchanged(snapshot.token);
    expect(cleared).toBe(true);
    // Fallback path: runtime.setSnapshot(EMPTY, null) — not a silent no-op.
    expect(runtime.store.getState().content).toEqual(
      EMPTY_DRAFT_RUNTIME_CONTENT,
    );
  });

  it("does not clear a replaced canonical runtime even when its revision equals the captured token", () => {
    // Isolates the store-identity check in clearIfUnchanged's bound fallback
    // (not retiredRef / unmount). Same numeric revision as the sibling
    // "clears via store fallback" test above, but WITH a registry replacement:
    // a fresh runtime for the same draftId always starts contentRevision at 0,
    // so a token captured at revision 0 against the OLD store would pass a
    // revision-only CAS and wipe the new owner unless store identity is
    // required.
    const draftId = "landing-replaced-equal-rev";
    useLandingDraftStore.getState().createDraftWithId(draftId, null);
    useLandingDraftStore
      .getState()
      .setDraftContent(draftId, textDoc("original capture"), null);

    const oldRuntime = draftRuntimeRegistry.attach(draftId);
    if (oldRuntime === null) throw new Error("expected old runtime");
    // Fresh attach: contentRevision is 0 by construction (no edits).
    expect(oldRuntime.store.getState().contentRevision).toBe(0);

    const editorRef: { current: ComposerPromptEditorHandle | null } = {
      current: null, // force bound store-fallback branch
    };
    const unboundRuntime = createStore<DraftRuntimeState>(() => ({
      content: EMPTY_DRAFT_RUNTIME_CONTENT,
      selection: null,
      contentRevision: 0,
      attachmentRoots: new Set(),
      isSubmitting: false,
    }));
    // Adapter closes over the OLD runtime's store (stale after replacement).
    const { result } = renderLandingSource({
      stashIdentity: landingStashIdentity(draftId, null),
      runtimeStore: oldRuntime.store,
      draftId,
      unboundRuntime,
      editorRef,
    });

    const snapshot = result.current.capture();
    if (snapshot === null) throw new Error("expected snapshot");
    expect(snapshot.token.revision).toBe(0);

    // Replace: detach drops the old runtime; re-attach mints a new instance
    // that also starts at contentRevision 0.
    draftRuntimeRegistry.detach(draftId);
    useLandingDraftStore
      .getState()
      .setDraftContent(draftId, textDoc("replacement occupant"), null);
    const newRuntime = draftRuntimeRegistry.attach(draftId);
    if (newRuntime === null) throw new Error("expected new runtime");
    expect(newRuntime).not.toBe(oldRuntime);
    expect(newRuntime.store).not.toBe(oldRuntime.store);
    expect(newRuntime.store.getState().contentRevision).toBe(0);
    expect(newRuntime.store.getState().content).toEqual(
      textDoc("replacement occupant"),
    );
    // Token revision still equals the OLD store's revision (both 0).
    expect(oldRuntime.store.getState().contentRevision).toBe(
      snapshot.token.revision,
    );
    expect(newRuntime.store.getState().contentRevision).toBe(
      snapshot.token.revision,
    );

    const setSnapshotSpy = vi.spyOn(newRuntime, "setSnapshot");
    const cleared = result.current.clearIfUnchanged(snapshot.token);

    // Store identity fails: canonical is a different generation even though
    // the numeric revision matches. Contrast: "clears via store fallback"
    // above is the same numeric-revision shape WITHOUT replacement and still
    // returns true.
    expect(cleared).toBe(false);
    expect(newRuntime.store.getState().content).toEqual(
      textDoc("replacement occupant"),
    );
    expect(setSnapshotSpy).not.toHaveBeenCalled();
    setSnapshotSpy.mockRestore();
  });

  it("does not clear a ready editor after its bound runtime is replaced", () => {
    const draftId = "landing-replaced-ready-editor";
    useLandingDraftStore.getState().createDraftWithId(draftId, null);
    useLandingDraftStore
      .getState()
      .setDraftContent(draftId, textDoc("original capture"), null);
    const oldRuntime = draftRuntimeRegistry.attach(draftId);
    if (oldRuntime === null) throw new Error("expected old runtime");

    const onClear = vi.fn();
    const editorRef: { current: ComposerPromptEditorHandle | null } = {
      current: makeEditorHandle({ onClear }),
    };
    const unboundRuntime = createStore<DraftRuntimeState>(() => ({
      content: EMPTY_DRAFT_RUNTIME_CONTENT,
      selection: null,
      contentRevision: 0,
      attachmentRoots: new Set(),
      isSubmitting: false,
    }));
    const { result } = renderLandingSource({
      stashIdentity: landingStashIdentity(draftId, null),
      runtimeStore: oldRuntime.store,
      draftId,
      unboundRuntime,
      editorRef,
    });
    const snapshot = result.current.capture();
    if (snapshot === null) throw new Error("expected snapshot");

    draftRuntimeRegistry.detach(draftId);
    const replacement = draftRuntimeRegistry.attach(draftId);
    if (replacement === null) throw new Error("expected replacement runtime");

    expect(result.current.clearIfUnchanged(snapshot.token)).toBe(false);
    expect(onClear).not.toHaveBeenCalled();
  });

  it("clears via live editor when ready and revision unchanged", () => {
    const draftId = "landing-bound-live-clear";
    useLandingDraftStore.getState().createDraftWithId(draftId, null);
    useLandingDraftStore
      .getState()
      .setDraftContent(draftId, textDoc("live clear"), null);
    const runtime = draftRuntimeRegistry.attach(draftId);
    if (runtime === null) throw new Error("expected runtime");
    runtime.setSnapshot(textDoc("live clear"), null);

    const onClear = vi.fn(() => {
      // Production: editor clear re-syncs via onUpdate → handleSnapshot.
      runtime.setSnapshot(EMPTY_DRAFT_RUNTIME_CONTENT, null);
    });
    const editorRef: { current: ComposerPromptEditorHandle | null } = {
      current: makeEditorHandle({ onClear }),
    };
    const unboundRuntime = createStore<DraftRuntimeState>(() => ({
      content: EMPTY_DRAFT_RUNTIME_CONTENT,
      selection: null,
      contentRevision: 0,
      attachmentRoots: new Set(),
      isSubmitting: false,
    }));
    const { result } = renderLandingSource({
      stashIdentity: landingStashIdentity(draftId, null),
      runtimeStore: runtime.store,
      draftId,
      unboundRuntime,
      editorRef,
    });

    const snapshot = result.current.capture();
    if (snapshot === null) throw new Error("expected snapshot");
    const cleared = result.current.clearIfUnchanged(snapshot.token);
    expect(cleared).toBe(true);
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(runtime.store.getState().content).toEqual(
      EMPTY_DRAFT_RUNTIME_CONTENT,
    );
  });

  it("delayed save survives surface detach + reopen as a new runtime (retiredRef)", async () => {
    // Realistic composer unmount: editor goes away first (store-fallback
    // clear path), then the hook instance retires, then the registry detaches
    // and a later attach mints a new DraftRuntime for the same draftId.
    // Without retiredRef, post-save clearIfUnchanged would CAS against the
    // retired runtimeStore revision, getOrHydrate the NEW owner, and wipe it.
    let resolveSave: (() => void) | undefined;
    storeMocks.save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );

    const draftId = "landing-lifetime-detach";
    const original = textDoc("original stash");
    const newer = textDoc("typed after reopen");
    useLandingDraftStore.getState().createDraftWithId(draftId, null);
    useLandingDraftStore.getState().setDraftContent(draftId, original, null);

    const oldRuntime = draftRuntimeRegistry.attach(draftId);
    if (oldRuntime === null) throw new Error("expected old runtime");
    oldRuntime.setSnapshot(original, null);
    // Flush capture content into durable so reopen hydrates from it.
    draftRuntimeRegistry.flush(draftId);

    const unboundRuntime = createStore<DraftRuntimeState>(() => ({
      content: EMPTY_DRAFT_RUNTIME_CONTENT,
      selection: null,
      contentRevision: 0,
      attachmentRoots: new Set(),
      isSubmitting: false,
    }));
    const editorRef = makeReadyEditor(original);

    const { result, unmount } = renderHook(() =>
      useLandingPromptStashController({
        draftId,
        runtimeStore: oldRuntime.store,
        unboundRuntime,
        editorRef,
      }),
    );

    await act(async () => {
      result.current.stashCurrent();
      await Promise.resolve();
    });
    expect(storeMocks.save).toHaveBeenCalledTimes(1);

    // Composer unmount: editor is gone (store-fallback clear would run), then
    // the hook instance retires before the durable save resolves.
    editorRef.current = null;
    const setSnapshotAfterCapture = vi.spyOn(oldRuntime, "setSnapshot");
    unmount();
    draftRuntimeRegistry.detach(draftId);

    const newRuntime = draftRuntimeRegistry.attach(draftId);
    if (newRuntime === null) throw new Error("expected new runtime");
    expect(newRuntime).not.toBe(oldRuntime);
    newRuntime.setSnapshot(newer, null);
    expect(newRuntime.store.getState().content).toEqual(newer);

    await act(async () => {
      resolveSave?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Retired hook never cleared the reopened owner; newer content survives.
    expect(newRuntime.store.getState().content).toEqual(newer);
    expect(setSnapshotAfterCapture).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();

    // Advance past the projection debounce by flushing the live runtime's
    // pending write — durable must still hold the newer content, not an
    // empty flush from a retired clear.
    draftRuntimeRegistry.flush(draftId);
    const durable = useLandingDraftStore
      .getState()
      .drafts.find((draft) => draft.id === draftId);
    expect(durable?.content).toEqual(newer);
  });
});
