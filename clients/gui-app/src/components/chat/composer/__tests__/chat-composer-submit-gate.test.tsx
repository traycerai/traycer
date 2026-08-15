import { createRef, type RefObject } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChatQueueDeliveryPolicy,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { createComposerPickerStore } from "../picker/composer-picker-store";
import type { ComposerPromptEditorHandle } from "../composer-prompt-editor";
import { useChatComposerSubmit } from "../use-chat-composer-submit";
import { useChatComposerDraft } from "../use-chat-composer-draft";
import { createFakeComposerPromptEditorHandle } from "./composer-prompt-editor-handle-fixtures";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import type { Attachment } from "@/lib/composer/types";
import {
  isAttachmentIngestPending,
  type UseComposerPasteResult,
} from "@/hooks/composer/use-composer-paste";

/**
 * Chat-composer submit gate (finding 3).
 *
 * `chat-composer.tsx` feeds `attachmentPreparationPending` into
 * `useChatComposerSubmit` from `isAttachmentIngestPending({isIngestingImages,
 * isResolvingFilePaths})`. Mounting the full ChatComposer surface is heavy;
 * this tests the exact submit path the surface uses, plus the pure-path
 * composition of the pending helper.
 *
 * Also covers the isReady() submit gate and multi-surface clear broadcast
 * that fix the "queued message reappears in the composer" bug.
 */

const DIRTY: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
};

const EMPTY_DOC: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

const EMPTY_SELECTION = { from: 1, to: 1 } as const;

interface ChatComposerSubmitInput {
  readonly content: JsonContent;
  readonly contentText: string;
  readonly attachments: ReadonlyArray<Attachment>;
  readonly settings: ChatRunSettings;
  readonly deliveryPolicy: ChatQueueDeliveryPolicy;
}

function acceptSubmit(_input: ChatComposerSubmitInput): boolean {
  return true;
}

afterEach(() => {
  cleanup();
  useComposerDraftStore.setState({ drafts: {} });
});

describe("chat-composer submit gate (path resolution)", () => {
  it("blocks useChatComposerSubmit while attachmentPreparationPending is true", () => {
    const onSubmitMessage = vi.fn(acceptSubmit);
    const editorRef = createRef<ComposerPromptEditorHandle | null>();
    editorRef.current = editorHandle({ content: DIRTY, ready: true });
    const pickerStore = createComposerPickerStore();
    const toolbarStore = createComposerToolbarStore({
      seedKey: "chat-submit-gate-test",
      values: {
        permission: "supervised",
        selection: {
          harnessId: "claude",
          modelSlug: "claude-sonnet",
          profileId: null,
        },
        reasoning: "medium",
        serviceTier: "",
      },
      onSettingsChange: null,
      tuiOnly: false,
      hostId: null,
    });

    const { result, rerender } = renderHook(
      (pending: boolean) =>
        useChatComposerSubmit({
          taskId: "task-1",
          editorRef,
          pickerStore,
          toolbarStore,
          activeTurnStatus: null,
          steerCapable: false,
          steerEnabled: true,
          steerProtocolSupported: true,
          getActiveTurnForSteer: () => null,
          hasPendingApprovals: false,
          sendDisabled: false,
          workspaceBlocked: false,
          imagesUnsupported: false,
          attachmentPreparationPending: pending,
          onSubmitMessage,
        }),
      { initialProps: true },
    );

    result.current.submitDraft("enter");
    expect(onSubmitMessage).not.toHaveBeenCalled();

    rerender(false);
    result.current.submitDraft("enter");
    expect(onSubmitMessage).toHaveBeenCalledTimes(1);
  });

  it("treats pure isResolvingFilePaths as attachment-pending (chat-composer composition)", () => {
    const paste: Pick<
      UseComposerPasteResult,
      "isIngestingImages" | "isResolvingFilePaths"
    > = {
      isIngestingImages: false,
      isResolvingFilePaths: true,
    };
    // Mirrors chat-composer.tsx:
    //   isAttachmentIngestPending({ isIngestingImages, isResolvingFilePaths })
    expect(isAttachmentIngestPending(paste)).toBe(true);
  });
});

/**
 * Root cause 1: the imperative handle exists from first commit, before async
 * useEditor resolves. Old submit only checked `editor !== null`, so it could
 * submit stale fallback JSON, clear the store, no-op clear(), then the editor
 * would init from the same stale captured initial content and resurrect text.
 */
describe("chat-composer submit gate (editor readiness)", () => {
  it("blocks submit while the handle is not ready and leaves the draft uncleared", () => {
    const taskId = "task-not-ready-submit";
    const onSubmitMessage = vi.fn(acceptSubmit);
    const clear = vi.fn(() => undefined);
    const editor = controllableEditorHandle({
      content: DIRTY,
      ready: false,
      clear,
    });
    const editorRef = createRef<ComposerPromptEditorHandle | null>();
    editorRef.current = editor.handle;

    act(() => {
      useComposerDraftStore.getState().setSnapshot(taskId, DIRTY, null);
    });
    const epochBefore =
      useComposerDraftStore.getState().drafts[taskId]?.resetEpoch ?? 0;

    const { result } = mountSubmitHook({
      taskId,
      editorRef,
      onSubmitMessage,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    // Pre-ready submit must be a silent no-op - no message, no clear.
    expect(onSubmitMessage).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    const draft = useComposerDraftStore.getState().drafts[taskId];
    expect(draft?.content).toEqual(DIRTY);
    expect(draft?.resetEpoch).toBe(epochBefore);
  });

  it("accepts a submit once ready and clears the store draft (positive control)", () => {
    const taskId = "task-ready-submit";
    const onSubmitMessage = vi.fn(acceptSubmit);
    const clear = vi.fn(() => undefined);
    const editor = controllableEditorHandle({
      content: DIRTY,
      ready: true,
      clear,
    });
    const editorRef = createRef<ComposerPromptEditorHandle | null>();
    editorRef.current = editor.handle;

    act(() => {
      useComposerDraftStore.getState().setSnapshot(taskId, DIRTY, null);
    });
    const epochBefore =
      useComposerDraftStore.getState().drafts[taskId]?.resetEpoch ?? 0;

    const { result } = mountSubmitHook({
      taskId,
      editorRef,
      onSubmitMessage,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    expect(onSubmitMessage).toHaveBeenCalledTimes(1);
    expect(onSubmitMessage.mock.calls[0][0].contentText).toBe("hello");
    expect(clear).toHaveBeenCalledTimes(1);

    // clearDraft now keeps the entry and bumps resetEpoch (old code deleted it).
    const draft = useComposerDraftStore.getState().drafts[taskId];
    expect(draft).toBeDefined();
    if (draft === undefined) return;
    expect(draft.content).toEqual(EMPTY_DOC);
    expect(draft.resetEpoch).toBe(epochBefore + 1);
  });

  it("blocks pre-ready submit, then succeeds after markReady without resurrecting draft text", () => {
    const taskId = "task-deferred-ready-submit";
    const onSubmitMessage = vi.fn(acceptSubmit);
    const clear = vi.fn(() => undefined);
    const editor = controllableEditorHandle({
      content: DIRTY,
      ready: false,
      clear,
    });
    const editorRef = createRef<ComposerPromptEditorHandle | null>();
    editorRef.current = editor.handle;

    act(() => {
      useComposerDraftStore.getState().setSnapshot(taskId, DIRTY, null);
    });

    // Bridge mounted so a clear after ready would push empty into the editor
    // via resetEpoch (the path that used to be skipped by delete-based clear).
    const { rerender: rerenderDraft } = renderHook(
      (tick: number) =>
        useChatComposerDraft({
          taskId,
          editorRef,
          editorReadyTick: tick,
        }),
      { initialProps: 0 },
    );

    const { result } = mountSubmitHook({
      taskId,
      editorRef,
      onSubmitMessage,
    });

    act(() => {
      result.current.submitDraft("enter");
    });
    expect(onSubmitMessage).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().drafts[taskId]?.content).toEqual(
      DIRTY,
    );

    // Async useEditor resolves - owner bumps editorReadyTick via onEditorReady.
    editor.markReady();
    rerenderDraft(1);

    act(() => {
      result.current.submitDraft("enter");
    });

    expect(onSubmitMessage).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(editor.syncContent).toHaveBeenCalledWith(EMPTY_DOC, EMPTY_SELECTION);
    expect(useComposerDraftStore.getState().drafts[taskId]?.content).toEqual(
      EMPTY_DOC,
    );
  });
});

/**
 * Root cause 2: multiple composers share one draft-store entry per taskId.
 * Submit clears only the submitting editor's local Tiptap doc via clear();
 * siblings must observe clearDraft's resetEpoch and syncContent(empty).
 */
describe("chat-composer submit multi-surface clear", () => {
  it("clears a sibling composer's Tiptap document when A submits for the same taskId", () => {
    const taskId = "task-multi-submit";
    const onSubmitMessage = vi.fn(acceptSubmit);
    const clearA = vi.fn(() => undefined);
    const clearB = vi.fn(() => undefined);

    const a = controllableEditorHandle({
      content: DIRTY,
      ready: true,
      clear: clearA,
    });
    const b = controllableEditorHandle({
      content: DIRTY,
      ready: true,
      clear: clearB,
    });
    const editorRefA: RefObject<ComposerPromptEditorHandle | null> = {
      current: a.handle,
    };
    const editorRefB: RefObject<ComposerPromptEditorHandle | null> = {
      current: b.handle,
    };

    act(() => {
      useComposerDraftStore.getState().setSnapshot(taskId, DIRTY, null);
    });

    renderHook(() =>
      useChatComposerDraft({
        taskId,
        editorRef: editorRefA,
        editorReadyTick: 1,
      }),
    );
    renderHook(() =>
      useChatComposerDraft({
        taskId,
        editorRef: editorRefB,
        editorReadyTick: 1,
      }),
    );

    const { result } = mountSubmitHook({
      taskId,
      editorRef: editorRefA,
      onSubmitMessage,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    expect(onSubmitMessage).toHaveBeenCalledTimes(1);
    // A is cleared by the direct clear() call in finalizeSend.
    expect(clearA).toHaveBeenCalledTimes(1);
    // B never gets clear() - it must learn via the store's resetEpoch broadcast.
    // Old clearDraft deleted the map entry and B.syncContent was never called.
    expect(b.syncContent).toHaveBeenCalledWith(EMPTY_DOC, EMPTY_SELECTION);
    expect(useComposerDraftStore.getState().drafts[taskId]?.content).toEqual(
      EMPTY_DOC,
    );
  });
});

function mountSubmitHook(args: {
  readonly taskId: string;
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly onSubmitMessage: (input: ChatComposerSubmitInput) => boolean;
}) {
  const pickerStore = createComposerPickerStore();
  const toolbarStore = createComposerToolbarStore({
    seedKey: "chat-submit-gate-ready-test",
    values: {
      permission: "supervised",
      selection: {
        harnessId: "claude",
        modelSlug: "claude-sonnet",
        profileId: null,
      },
      reasoning: "medium",
      serviceTier: "",
    },
    onSettingsChange: null,
    tuiOnly: false,
    hostId: null,
  });

  return renderHook(() =>
    useChatComposerSubmit({
      taskId: args.taskId,
      editorRef: args.editorRef,
      pickerStore,
      toolbarStore,
      activeTurnStatus: null,
      steerCapable: false,
      steerEnabled: true,
      steerProtocolSupported: true,
      getActiveTurnForSteer: () => null,
      hasPendingApprovals: false,
      sendDisabled: false,
      workspaceBlocked: false,
      imagesUnsupported: false,
      attachmentPreparationPending: false,
      onSubmitMessage: args.onSubmitMessage,
    }),
  );
}

interface ControllableEditorArgs {
  readonly content: JsonContent;
  readonly ready: boolean;
  readonly clear: () => void;
}

function controllableEditorHandle(args: ControllableEditorArgs): {
  readonly handle: ComposerPromptEditorHandle;
  readonly setContent: ComposerPromptEditorHandle["setContent"];
  readonly syncContent: ComposerPromptEditorHandle["syncContent"];
  readonly clear: () => void;
  readonly markReady: () => void;
} {
  const fake = createFakeComposerPromptEditorHandle({
    ready: args.ready,
    content: args.content,
    selection: null,
    isEmpty: false,
    onFocus: null,
    onClear: null,
  });
  // Preserve the explicit clear mock the submit-gate suite spies on.
  const handle: ComposerPromptEditorHandle = {
    ...fake.handle,
    clear: args.clear,
  };
  return {
    handle,
    setContent: fake.setContent,
    syncContent: fake.syncContent,
    clear: args.clear,
    markReady: () => {
      fake.markReady(true);
    },
  };
}

function editorHandle(args: {
  readonly content: JsonContent;
  readonly ready: boolean;
}): ComposerPromptEditorHandle {
  return controllableEditorHandle({
    content: args.content,
    ready: args.ready,
    clear: () => undefined,
  }).handle;
}
