import "../../../../../__tests__/test-browser-apis";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { useChatComposerSubmit } from "@/components/chat/composer/use-chat-composer-submit";
import type { ChatComposerSubmitInput } from "@/components/chat/composer/chat-composer";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { useChatComposerDraft } from "@/components/chat/composer/use-chat-composer-draft";
import type { ModelOption } from "@/components/home/data/landing-options";
import type { BrowserAnnotationRecord } from "@/lib/browser-view/annotation/browser-annotation-record";
import { STUB_ANNOTATION_ELEMENT } from "@/lib/browser-view/annotation/__tests__/browser-annotation-fixtures";
import { selectedModelRejectsImageAttachments } from "@/lib/composer/chat-run-settings";
import { collectImageAtoms } from "@/lib/composer/image-atoms";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";

const imageStoreMocks = vi.hoisted(() => ({
  sessionImageBytes: vi.fn<(hash: string) => Uint8Array | null>(() => null),
  getImageBytes: vi.fn<(hash: string) => Promise<Uint8Array | undefined>>(() =>
    Promise.resolve(undefined),
  ),
}));

const toastMocks = vi.hoisted(() => ({
  reportableErrorToast: vi.fn(),
}));

vi.mock("@/lib/reportable-error-toast", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/reportable-error-toast")>();
  return { ...actual, reportableErrorToast: toastMocks.reportableErrorToast };
});

vi.mock("@/lib/composer/landing-image-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/composer/landing-image-store")>();
  return {
    ...actual,
    sessionImageBytes: imageStoreMocks.sessionImageBytes,
    getImageBytes: imageStoreMocks.getImageBytes,
  };
});

const EMPTY_DOC: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

const TYPED_DOC: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }],
};

const CROP_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const ANNOTATION_ID = "ann-7f3a";
const IMAGE_FILE_NAME = `browser-annotation-${ANNOTATION_ID}.png`;
const IMAGE_HASH = "hash-ann-7f3a";

function annotationRecord(
  overrides: Partial<BrowserAnnotationRecord> | null,
): BrowserAnnotationRecord {
  const input = overrides ?? {};
  return {
    kind: "browser-annotation",
    annotationId: input.annotationId ?? ANNOTATION_ID,
    tabId: input.tabId ?? "t-1",
    sessionId: input.sessionId ?? "s-1",
    origin: input.origin ?? "https://example.com",
    pageUrl: input.pageUrl ?? "https://example.com/",
    pageTitle: input.pageTitle ?? "Example Domain",
    capturedAt: input.capturedAt ?? 1_700_000_000_000,
    comment: input.comment ?? "Make this hero section pop more",
    counts: input.counts ?? { elements: 1, regions: 0, strokes: 0 },
    elements: input.elements ?? [STUB_ANNOTATION_ELEMENT],
    imageFileName: input.imageFileName ?? IMAGE_FILE_NAME,
    imageHash: input.imageHash ?? IMAGE_HASH,
    droppedElementCount: input.droppedElementCount ?? 0,
  };
}

function imageRejectingModel(): ModelOption {
  return {
    harnessId: "codex",
    slug: "text-only",
    label: "Text Only",
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: {},
  };
}

function imageCapableModel(): ModelOption {
  return {
    harnessId: "codex",
    slug: "vision",
    label: "Vision",
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: { inputModalities: ["text", "image"] },
  };
}

function fakeEditor(content: JsonContent): ComposerPromptEditorHandle {
  return {
    isReady: () => true,
    getEditorIncarnation: () => null,
    hasFocus: () => false,
    focus: () => undefined,
    focusAtEnd: () => undefined,
    getJSON: () => content,
    isEmpty: () => false,
    clear: () => undefined,
    setContent: () => undefined,
    syncContent: () => undefined,
    insertImageAttachments: () => undefined,
    insertMentionAttachment: () => false,
    beginPathInsertion: () => null,
    removeImageAttachmentById: () => undefined,
    rewriteImageAttachmentHashById: () => false,
    insertDictatedText: () => undefined,
    dismissActiveSuggestion: () => false,
  };
}

function mutableFakeEditor(initial: JsonContent): {
  readonly handle: ComposerPromptEditorHandle;
  readonly setJSON: (next: JsonContent) => void;
} {
  let content = initial;
  return {
    handle: { ...fakeEditor(initial), getJSON: () => content },
    setJSON: (next: JsonContent) => {
      content = next;
    },
  };
}

function mountSubmit(args: {
  readonly taskId: string;
  readonly editor: ComposerPromptEditorHandle;
  readonly imagesUnsupported: boolean;
  readonly onSubmitMessage: (input: ChatComposerSubmitInput) => boolean;
}) {
  const toolbarStore = createComposerToolbarStore({
    purpose: "run",
    seedKey: "browser-annotation-submit",
    values: {
      permission: "supervised",
      selection: {
        harnessId: "codex",
        modelSlug: "gpt-5",
        profileId: null,
      },
      reasoning: "medium",
      serviceTier: "auto",
    },
    onSettingsChange: null,
    tuiOnly: false,
    chatLineCarriesAutoMode: null,
    hostId: null,
  });
  return renderHook(() =>
    useChatComposerSubmit({
      taskId: args.taskId,
      editorRef: { current: args.editor },
      pickerStore: createComposerPickerStore(),
      toolbarStore,
      activeTurnStatus: null,
      steerCapable: false,
      steerEnabled: true,
      steerProtocolSupported: true,
      getActiveTurnForSteer: () => null,
      hasPendingApprovals: false,
      sendDisabled: false,
      workspaceBlocked: false,
      imagesUnsupported: args.imagesUnsupported,
      attachmentPreparationPending: false,
      onSubmitMessage: args.onSubmitMessage,
      onSideChat: null,
      targetHostId: null,
      queueEditTargetId: null,
      // T5's gate is off in these fixtures: they predate it and assert the
      // inline behaviour, which is what `false` preserves exactly.
      getDraftBlobBridgeSupported: () => false,
    }),
  );
}

beforeEach(() => {
  imageStoreMocks.sessionImageBytes.mockReset();
  imageStoreMocks.sessionImageBytes.mockReturnValue(null);
  imageStoreMocks.getImageBytes.mockReset();
  imageStoreMocks.getImageBytes.mockResolvedValue(undefined);
  toastMocks.reportableErrorToast.mockReset();
});

afterEach(() => {
  useComposerDraftStore.setState({ drafts: {} });
});

const DOC_HASH = "hash-doc-image-1";
const DOC_BYTES = new Uint8Array([1, 2, 3, 4]);

/** A document carrying one hash-only image, so the submit has to read bytes. */
const COLD_IMAGE_DOC: JsonContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "imageAttachment",
          attrs: {
            id: "doc-node-1",
            fileName: "shot.png",
            mimeType: "image/png",
            size: 4,
            byHashEligible: true,
            hash: DOC_HASH,
          },
        },
        { type: "text", text: "look" },
      ],
    },
  ],
};

/**
 * The annotation crop resolves from the session cache; the DOCUMENT image does
 * not, and its read is held open so the test can change the sidecar underneath
 * it. Returns the release handle for that one read - every later read resolves
 * at once, which is what the bounded retry needs.
 */
function coldDocumentImageRead(): { readonly release: () => void } {
  imageStoreMocks.sessionImageBytes.mockImplementation((hash: string) =>
    hash === IMAGE_HASH ? CROP_BYTES : null,
  );
  let resolveFirst: ((bytes: Uint8Array) => void) | null = null;
  imageStoreMocks.getImageBytes.mockImplementation(() => {
    if (resolveFirst !== null) return Promise.resolve(DOC_BYTES);
    return new Promise<Uint8Array | undefined>((resolve) => {
      resolveFirst = resolve;
    });
  });
  return {
    release: () => {
      resolveFirst?.(DOC_BYTES);
    },
  };
}

function annotationAtomFileNames(content: JsonContent): ReadonlyArray<string> {
  return collectImageAtoms(content)
    .map((atom) => atom.fileName)
    .filter((name) => name === IMAGE_FILE_NAME);
}

// The stale-generation retry re-runs the submit against the live draft. The
// SIDECAR is part of that draft, so a retry that reuses the crop atoms resolved
// at the first submit sends a screenshot for an annotation the user has since
// removed - as an ordinary image, with no record beside it - and sends no crop
// at all for one attached during the read.
describe("useChatComposerSubmit: the retry re-resolves the live sidecar", () => {
  it("an annotation removed during the read is not sent", async () => {
    const taskId = "chat-ann-removed-mid-read";
    const record = annotationRecord(null);
    useComposerDraftStore.getState().addBrowserAnnotation(taskId, record);
    const read = coldDocumentImageRead();

    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: fakeEditor(COLD_IMAGE_DOC),
      imagesUnsupported: false,
      onSubmitMessage: submit,
    });

    act(() => {
      result.current.submitDraft("enter");
    });
    // The annotation stage resolved, and the document's cold image is now being
    // read - the window this is about.
    await waitFor(() => {
      expect(imageStoreMocks.getImageBytes).toHaveBeenCalledWith(DOC_HASH);
    });
    expect(submit).not.toHaveBeenCalled();

    // The user takes the annotation back while that read is outstanding.
    act(() => {
      useComposerDraftStore
        .getState()
        .removeBrowserAnnotation(taskId, ANNOTATION_ID);
    });

    await act(async () => {
      read.release();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });

    const input = submit.mock.calls[0][0];
    // No record, and - the actual defect - no crop atom either. Reusing the
    // captured atoms appended this screenshot as an ordinary image.
    expect(input.attachments).not.toContainEqual(record);
    expect(annotationAtomFileNames(input.content)).toHaveLength(0);
  });

  it("a draft emptied during the read sends nothing", async () => {
    // The empty-submit guard moved down into the annotation stage so the retry
    // gets it too: the retry exists BECAUSE the draft changed, and one of the
    // things it can have changed into is empty. Nothing further out re-asks.
    const taskId = "chat-ann-emptied-mid-read";
    useComposerDraftStore
      .getState()
      .addBrowserAnnotation(taskId, annotationRecord(null));
    const read = coldDocumentImageRead();
    const editor = mutableFakeEditor(COLD_IMAGE_DOC);

    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: editor.handle,
      imagesUnsupported: false,
      onSubmitMessage: submit,
    });

    act(() => {
      result.current.submitDraft("enter");
    });
    await waitFor(() => {
      expect(imageStoreMocks.getImageBytes).toHaveBeenCalledWith(DOC_HASH);
    });

    // The user clears the prompt and takes the annotation back.
    act(() => {
      editor.setJSON(EMPTY_DOC);
      useComposerDraftStore
        .getState()
        .removeBrowserAnnotation(taskId, ANNOTATION_ID);
    });

    await act(async () => {
      read.release();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(submit).not.toHaveBeenCalled();
  });

  it("an annotation added during the read is sent WITH its crop", async () => {
    const taskId = "chat-ann-added-mid-read";
    const record = annotationRecord(null);
    const read = coldDocumentImageRead();

    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: fakeEditor(COLD_IMAGE_DOC),
      imagesUnsupported: false,
      onSubmitMessage: submit,
    });

    // No sidecar yet: the submit goes straight to the document's cold image.
    act(() => {
      result.current.submitDraft("enter");
    });
    await waitFor(() => {
      expect(imageStoreMocks.getImageBytes).toHaveBeenCalledWith(DOC_HASH);
    });
    expect(submit).not.toHaveBeenCalled();

    act(() => {
      useComposerDraftStore.getState().addBrowserAnnotation(taskId, record);
    });

    await act(async () => {
      read.release();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });

    const input = submit.mock.calls[0][0];
    expect(input.attachments).toContainEqual(record);
    // The crop, not just the record. Carrying the first attempt's (empty) atoms
    // forward sent the record with nothing to look at.
    expect(annotationAtomFileNames(input.content)).toEqual([IMAGE_FILE_NAME]);
    const crop = collectImageAtoms(input.content).find(
      (atom) => atom.fileName === IMAGE_FILE_NAME,
    );
    expect(crop?.b64content).toBe(btoa(String.fromCharCode(...CROP_BYTES)));
  });
});

describe("useChatComposerSubmit browser annotations", () => {
  it("sends the record and the crop image atom together with matching id/filename", async () => {
    const taskId = "chat-ann-send";
    const record = annotationRecord(null);
    useComposerDraftStore.getState().addBrowserAnnotation(taskId, record);
    imageStoreMocks.sessionImageBytes.mockReturnValue(CROP_BYTES);

    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: fakeEditor(EMPTY_DOC),
      imagesUnsupported: false,
      onSubmitMessage: submit,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });

    const input = submit.mock.calls[0][0];
    expect(input.attachments).toContainEqual(record);
    expect(input.attachments).toContainEqual(
      expect.objectContaining({
        kind: "image",
        name: IMAGE_FILE_NAME,
        mediaType: "image/png",
      }),
    );
    const atoms = collectImageAtoms(input.content);
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.fileName).toBe(IMAGE_FILE_NAME);
    expect(atoms[0]?.fileName).toBe(
      `browser-annotation-${record.annotationId}.png`,
    );
    expect(atoms[0]?.mimeType).toBe("image/png");
    expect(atoms[0]?.b64content).toBe(btoa(String.fromCharCode(...CROP_BYTES)));
    expect(imageStoreMocks.sessionImageBytes).toHaveBeenCalledWith(IMAGE_HASH);
    expect(imageStoreMocks.getImageBytes).not.toHaveBeenCalled();
    expect(input.restore.content).toEqual(EMPTY_DOC);
    expect(collectImageAtoms(input.restore.content)).toHaveLength(0);
    expect(input.restore.browserAnnotations).toEqual([record]);
  });

  it("falls back to getImageBytes when the session cache misses", async () => {
    const taskId = "chat-ann-idb";
    const record = annotationRecord(null);
    useComposerDraftStore.getState().addBrowserAnnotation(taskId, record);
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    imageStoreMocks.getImageBytes.mockResolvedValue(CROP_BYTES);

    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: fakeEditor(EMPTY_DOC),
      imagesUnsupported: false,
      onSubmitMessage: submit,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    expect(imageStoreMocks.getImageBytes).toHaveBeenCalledWith(IMAGE_HASH);
    const atoms = collectImageAtoms(
      submit.mock.calls[0]?.[0]?.content ?? EMPTY_DOC,
    );
    expect(atoms[0]?.fileName).toBe(IMAGE_FILE_NAME);
  });

  it("does not send when landing-image-store has no crop bytes", async () => {
    const taskId = "chat-ann-missing";
    useComposerDraftStore
      .getState()
      .addBrowserAnnotation(taskId, annotationRecord(null));
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    imageStoreMocks.getImageBytes.mockResolvedValue(undefined);

    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: fakeEditor(EMPTY_DOC),
      imagesUnsupported: false,
      onSubmitMessage: submit,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(submit).not.toHaveBeenCalled();
    expect(imageStoreMocks.sessionImageBytes).toHaveBeenCalledWith(IMAGE_HASH);
    expect(imageStoreMocks.getImageBytes).toHaveBeenCalledWith(IMAGE_HASH);
  });

  it("reports the missing-image failure when the crop read REJECTS", async () => {
    // An IndexedDB open/transaction failure is a rejection, not `undefined`.
    // Unhandled, it abandoned the submit with no toast at all - the composer
    // just stopped sending with nothing on screen to act on.
    const taskId = "chat-ann-idb-throws";
    useComposerDraftStore
      .getState()
      .addBrowserAnnotation(taskId, annotationRecord(null));
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    imageStoreMocks.getImageBytes.mockRejectedValue(
      new Error("IndexedDB unavailable"),
    );

    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: fakeEditor(EMPTY_DOC),
      imagesUnsupported: false,
      onSubmitMessage: submit,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    await waitFor(() => {
      expect(toastMocks.reportableErrorToast).toHaveBeenCalledTimes(1);
    });
    expect(toastMocks.reportableErrorToast.mock.calls[0][0]).toBe(
      "Couldn't attach the annotation image.",
    );
    expect(submit).not.toHaveBeenCalled();
    // The single-flight gate must be released so a retry is possible.
    expect(result.current.annotationPreparationPending).toBe(false);
  });

  it("single-flights a second submit while crop bytes are still resolving", async () => {
    const taskId = "chat-ann-double";
    useComposerDraftStore
      .getState()
      .addBrowserAnnotation(taskId, annotationRecord(null));
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    let release: (() => void) | null = null;
    imageStoreMocks.getImageBytes.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(CROP_BYTES);
        }),
    );
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: fakeEditor(EMPTY_DOC),
      imagesUnsupported: false,
      onSubmitMessage: submit,
    });

    act(() => {
      result.current.submitDraft("enter");
      result.current.submitDraft("enter");
    });
    expect(imageStoreMocks.getImageBytes).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
  });

  it("sends the live document when the user types while crop bytes resolve", async () => {
    const taskId = "chat-ann-typing";
    useComposerDraftStore
      .getState()
      .addBrowserAnnotation(taskId, annotationRecord(null));
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    let release: (() => void) | null = null;
    imageStoreMocks.getImageBytes.mockImplementation(() => {
      // Only the FIRST read is held open, the same shape
      // `coldDocumentImageRead` above uses and for the same reason: typing
      // during the read bumps the draft `revision`, which re-enters the submit
      // and resolves the live sidecar from scratch. A mock that held EVERY read
      // open would leave that second resolution pending forever and the case
      // would read as a send that never goes out, which is a fact about the
      // harness driving one handoff rather than about the send.
      if (release !== null) return Promise.resolve(CROP_BYTES);
      return new Promise<Uint8Array | undefined>((resolve) => {
        release = () => resolve(CROP_BYTES);
      });
    });
    const editor = mutableFakeEditor(EMPTY_DOC);
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: editor.handle,
      imagesUnsupported: false,
      onSubmitMessage: submit,
    });

    act(() => {
      result.current.submitDraft("enter");
    });
    // One character typed during the IndexedDB read moves both the editor
    // document and the draft `revision`. The send must still go out - and it
    // must carry what the user is looking at, since acceptance clears the
    // editor.
    act(() => {
      editor.setJSON(TYPED_DOC);
      useComposerDraftStore
        .getState()
        .setSnapshot(taskId, TYPED_DOC, { from: 1, to: 2 });
    });
    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    const input = submit.mock.calls[0][0];
    expect(input.contentText).toBe("x");
    expect(input.restore.content).toEqual(TYPED_DOC);
  });

  // This case used to assert the send was HELD BACK here, on the premise that
  // `commit` is synchronous by contract and so cannot grow an atom for a record
  // that arrived during the read. The premise is right and the conclusion no
  // longer follows: the preparation does not have to be the thing that grows
  // it, because the submit RE-ENTERS and resolves the live sidecar from
  // scratch. Holding back left a user who pressed Enter with an info toast and
  // an unsent draft, which is the outcome the generation guard exists to
  // remove - see the `the retry re-resolves the live sidecar` describe above,
  // where the one-annotation form of this is pinned.
  it("an annotation attached while crop bytes resolve joins the send with its crop", async () => {
    const taskId = "chat-ann-late-attach";
    const first = annotationRecord(null);
    const late = annotationRecord({
      annotationId: "ann-late",
      imageFileName: "browser-annotation-ann-late.png",
      imageHash: "hash-ann-late",
    });
    useComposerDraftStore.getState().addBrowserAnnotation(taskId, first);
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    let release: (() => void) | null = null;
    imageStoreMocks.getImageBytes.mockImplementation(() => {
      // Only the FIRST read is held open; the re-entered pass resolves at once.
      if (release !== null) return Promise.resolve(CROP_BYTES);
      return new Promise<Uint8Array | undefined>((resolve) => {
        release = () => resolve(CROP_BYTES);
      });
    });
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: fakeEditor(TYPED_DOC),
      imagesUnsupported: false,
      onSubmitMessage: submit,
    });

    act(() => {
      result.current.submitDraft("enter");
    });
    // Attached while the IndexedDB read is in flight, so the first pass has a
    // record it resolved no crop atom for.
    act(() => {
      useComposerDraftStore.getState().addBrowserAnnotation(taskId, late);
    });
    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });

    // BOTH records, and both crops. The protocol needs the crop to ride an
    // `imageAttachment` and acceptance clears the sidecar, so a record sent
    // without one loses its image for good - which is why the re-entry has to
    // resolve the whole live set rather than patch the late one in.
    const input = submit.mock.calls[0][0];
    expect(input.attachments).toContainEqual(first);
    expect(input.attachments).toContainEqual(late);
    expect(
      collectImageAtoms(input.content).map((atom) => atom.fileName),
    ).toEqual(
      expect.arrayContaining([first.imageFileName, late.imageFileName]),
    );
  });
});

describe("browser annotation image gating", () => {
  it("annotation-only draft sets draftHasImages so an image-rejecting model blocks send", async () => {
    const taskId = "chat-ann-gate";
    const editorRef = { current: fakeEditor(EMPTY_DOC) };

    act(() => {
      useComposerDraftStore
        .getState()
        .addBrowserAnnotation(taskId, annotationRecord(null));
    });

    const draft = renderHook(() =>
      useChatComposerDraft({
        chatId: taskId,
        epicId: "epic-1",
        hostId: "host-1",
        editorRef,
        editorReadyTick: 1,
        chatTitle: null,
        epicTitle: null,
      }),
    );

    expect(draft.result.current.draftHasText).toBe(false);
    expect(draft.result.current.draftHasImages).toBe(true);

    const rejecting = selectedModelRejectsImageAttachments(
      imageRejectingModel(),
    );
    const capable = selectedModelRejectsImageAttachments(imageCapableModel());
    expect(rejecting).toBe(true);
    expect(capable).toBe(false);

    // Mirrors chat-composer.tsx imageAttachmentsUnsupported /
    // canSubmitDraft: annotation crops are mandatory images.
    const imagesUnsupported = draft.result.current.draftHasImages && rejecting;
    expect(imagesUnsupported).toBe(true);
    expect(draft.result.current.draftHasImages && capable).toBe(false);

    imageStoreMocks.sessionImageBytes.mockReturnValue(CROP_BYTES);
    const submit = vi.fn((_input: ChatComposerSubmitInput) => true);
    const { result } = mountSubmit({
      taskId,
      editor: editorRef.current,
      imagesUnsupported,
      onSubmitMessage: submit,
    });

    act(() => {
      result.current.submitDraft("enter");
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(submit).not.toHaveBeenCalled();
  });
});
