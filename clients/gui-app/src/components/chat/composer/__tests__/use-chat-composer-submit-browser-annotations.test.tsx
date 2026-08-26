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
import type { BrowserAnnotationRecord } from "@/lib/browser-view/browser-annotation-record";
import { STUB_ANNOTATION_ELEMENT } from "@/lib/browser-view/__tests__/browser-annotation-fixtures";
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

function mountSubmit(args: {
  readonly taskId: string;
  readonly editor: ComposerPromptEditorHandle;
  readonly imagesUnsupported: boolean;
  readonly onSubmitMessage: (input: ChatComposerSubmitInput) => boolean;
}) {
  const toolbarStore = createComposerToolbarStore({
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
    }),
  );
}

beforeEach(() => {
  imageStoreMocks.sessionImageBytes.mockReset();
  imageStoreMocks.sessionImageBytes.mockReturnValue(null);
  imageStoreMocks.getImageBytes.mockReset();
  imageStoreMocks.getImageBytes.mockResolvedValue(undefined);
});

afterEach(() => {
  useComposerDraftStore.setState({ drafts: {} });
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
    expect(input.restoreContent).toEqual(EMPTY_DOC);
    expect(collectImageAtoms(input.restoreContent)).toHaveLength(0);
    expect(input.restoreBrowserAnnotations).toEqual([record]);
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

  it("does not finalize a send if the draft revision changed while bytes resolved", async () => {
    const taskId = "chat-ann-stale";
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
    });
    act(() => {
      useComposerDraftStore
        .getState()
        .setSnapshot(taskId, EMPTY_DOC, { from: 1, to: 1 });
    });
    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(submit).not.toHaveBeenCalled();
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
        taskId,
        editorRef,
        editorReadyTick: 1,
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
