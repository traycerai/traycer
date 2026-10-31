import { createRef, type ReactNode, type RefObject } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
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
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import { appLogger } from "@/lib/logger";
import {
  NO_QUEUED_MESSAGE_STAGES,
  QueuedMessageStagesContext,
} from "@/components/chat/queued-message-stages";
import {
  isAttachmentIngestPending,
  type UseComposerPasteResult,
} from "@/hooks/composer/use-composer-paste";

/**
 * Chat-composer submit gate.
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

vi.mock("sonner", () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

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
      purpose: "run",
      reasoningFallback: "model-default",
      seedKey: "chat-submit-gate-test",
      values: {
        ultracode: false,
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
      chatLineCarriesAutoMode: null,
      ultracodeCarried: false,
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
          sendDisabledHint: null,
          workspaceBlocked: false,
          imagesUnsupported: false,
          attachmentPreparationPending: pending,
          onSubmitMessage,
          onSideChat: null,
          targetHostId: null,
          queueEditTargetId: null,
          // The gate is off in these fixtures: they predate it and assert the
          // inline behaviour, which is what `false` preserves exactly.
          getDraftBlobBridgeSupported: () => false,
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
          chatId: taskId,
          epicId: "epic-1",
          hostId: "host-1",
          editorRef,
          editorReadyTick: tick,
          chatTitle: null,
          epicTitle: null,
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
        chatId: taskId,
        epicId: "epic-1",
        hostId: "host-1",
        editorRef: editorRefA,
        editorReadyTick: 1,
        chatTitle: null,
        epicTitle: null,
      }),
    );
    renderHook(() =>
      useChatComposerDraft({
        chatId: taskId,
        epicId: "epic-1",
        hostId: "host-1",
        editorRef: editorRefB,
        editorReadyTick: 1,
        chatTitle: null,
        epicTitle: null,
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

describe("chat-composer submit after re-key", () => {
  it("submits immediately on a draft re-keyed by detachDraftIdentity right before submit", () => {
    const taskId = "task-rekeyed-submit";
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
    act(() => {
      useComposerDraftStore.getState().detachDraftIdentity(taskId);
    });

    const { result } = mountSubmitHook({
      taskId,
      editorRef,
      onSubmitMessage,
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    expect(onSubmitMessage).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
  });
});

/**
 * A paused send leaves one line in the log (support triage could not tell a
 * paused send from a lost one). The line names ids and a status and nothing
 * the user typed.
 */
describe("chat-composer submit gate (paused send diagnostics)", () => {
  const REFUSED_LINE = "[composer] submit refused: send disabled";
  const PAUSED_HINT = "Reconnecting to the host — sending is paused";

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function mountPaused(args: {
    readonly sendDisabled: boolean;
    readonly sendDisabledHint: string | null;
    readonly connectionStatus: StreamConnectionStatus | null;
    readonly onSubmitMessage: (input: ChatComposerSubmitInput) => boolean;
  }) {
    const editorRef = createRef<ComposerPromptEditorHandle | null>();
    editorRef.current = editorHandle({ content: DIRTY, ready: true });
    return mountSubmitHookWith({
      taskId: "chat-paused",
      editorRef,
      onSubmitMessage: args.onSubmitMessage,
      sendDisabled: args.sendDisabled,
      sendDisabledHint: args.sendDisabledHint,
      modelSlug: "claude-sonnet",
      targetHostId: "host-tab",
      wrapper: ({ children }) => (
        <QueuedMessageStagesContext
          value={{
            ...NO_QUEUED_MESSAGE_STAGES,
            connectionStatus: args.connectionStatus,
          }}
        >
          {children}
        </QueuedMessageStagesContext>
      ),
    });
  }

  function refusedLines(info: {
    readonly mock: { readonly calls: unknown[][] };
  }) {
    return info.mock.calls.filter(([message]) => message === REFUSED_LINE);
  }

  it("logs the chat, host and connection status once for a refused submit, and repeats of the same key press add nothing", () => {
    const info = vi.spyOn(appLogger, "info");
    const onSubmitMessage = vi.fn(acceptSubmit);
    const { result } = mountPaused({
      sendDisabled: true,
      sendDisabledHint: PAUSED_HINT,
      connectionStatus: "reconnecting",
      onSubmitMessage,
    });

    act(() => {
      result.current.submitDraft("enter");
      result.current.submitDraft("enter");
      result.current.submitDraft("enter");
    });

    expect(onSubmitMessage).not.toHaveBeenCalled();
    expect(refusedLines(info)).toEqual([
      [
        REFUSED_LINE,
        {
          chatId: "chat-paused",
          hostId: "host-tab",
          connectionStatus: "reconnecting",
          reason: "stream-not-open",
          stage: "initial",
        },
      ],
    ]);
    expect(JSON.stringify(info.mock.calls)).not.toContain("hello");
  });

  it("writes a second line once the window from the last line has passed", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    const info = vi.spyOn(appLogger, "info");
    const { result } = mountPaused({
      sendDisabled: true,
      sendDisabledHint: PAUSED_HINT,
      connectionStatus: "reconnecting",
      onSubmitMessage: vi.fn(acceptSubmit),
    });

    act(() => {
      result.current.submitDraft("enter");
    });
    vi.setSystemTime(new Date("2026-10-15T12:00:01.999Z"));
    act(() => {
      result.current.submitDraft("enter");
    });
    expect(refusedLines(info)).toHaveLength(1);

    vi.setSystemTime(new Date("2026-10-15T12:00:02Z"));
    act(() => {
      result.current.submitDraft("enter");
    });
    expect(refusedLines(info)).toHaveLength(2);
  });

  it("names an open stream's refusal as send-disabled (viewer or signed-out profile)", () => {
    const info = vi.spyOn(appLogger, "info");
    const { result } = mountPaused({
      sendDisabled: true,
      sendDisabledHint: PAUSED_HINT,
      connectionStatus: "open",
      onSubmitMessage: vi.fn(acceptSubmit),
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    expect(refusedLines(info)).toEqual([
      [
        REFUSED_LINE,
        {
          chatId: "chat-paused",
          hostId: "host-tab",
          connectionStatus: "open",
          reason: "send-disabled",
          stage: "initial",
        },
      ],
    ]);
  });

  it("logs nothing for an empty composer, where no sendable message was refused", () => {
    const info = vi.spyOn(appLogger, "info");
    const editorRef = createRef<ComposerPromptEditorHandle | null>();
    editorRef.current = editorHandle({ content: EMPTY_DOC, ready: true });
    const { result } = mountSubmitHookWith({
      taskId: "chat-paused-empty",
      editorRef,
      onSubmitMessage: vi.fn(acceptSubmit),
      sendDisabled: true,
      sendDisabledHint: PAUSED_HINT,
      modelSlug: "claude-sonnet",
      targetHostId: "host-tab",
      wrapper: ({ children }) => (
        <QueuedMessageStagesContext
          value={{
            ...NO_QUEUED_MESSAGE_STAGES,
            connectionStatus: "reconnecting",
          }}
        >
          {children}
        </QueuedMessageStagesContext>
      ),
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    expect(refusedLines(info)).toEqual([]);
  });

  it("logs nothing when the send is not disabled", () => {
    const info = vi.spyOn(appLogger, "info");
    const { result } = mountPaused({
      sendDisabled: false,
      sendDisabledHint: PAUSED_HINT,
      connectionStatus: "open",
      onSubmitMessage: vi.fn(acceptSubmit),
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    expect(refusedLines(info)).toEqual([]);
  });
});

/**
 * Enter while send is disabled used to be a silent no-op - the one cue was a
 * status line and a tooltip. A submit refused BECAUSE send is disabled now says
 * why once, with the composer's own hint text; one notice per attempt, so a
 * held Enter does not stack them.
 */
describe("chat-composer submit gate (paused send notice)", () => {
  const HINT = "Reconnecting to the host — sending is paused";
  const NOTICE_ID = "chat-composer-send-disabled:chat-notice";

  // Other suites in this file refuse a send too, and each now raises the
  // notice, so the count starts from a clean mock.
  beforeEach(() => {
    vi.mocked(toast.info).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mountNotice(args: {
    readonly content: JsonContent;
    readonly sendDisabled: boolean;
    readonly sendDisabledHint: string | null;
    readonly modelSlug: string;
  }) {
    const editorRef = createRef<ComposerPromptEditorHandle | null>();
    editorRef.current = editorHandle({ content: args.content, ready: true });
    const onSubmitMessage = vi.fn(acceptSubmit);
    const mounted = mountSubmitHookWith({
      taskId: "chat-notice",
      editorRef,
      onSubmitMessage,
      sendDisabled: args.sendDisabled,
      sendDisabledHint: args.sendDisabledHint,
      modelSlug: args.modelSlug,
      targetHostId: "host-tab",
      wrapper: ({ children }) => children,
    });
    return { ...mounted, onSubmitMessage };
  }

  it("shows the existing hint once, under a stable id, for a blocked Enter", () => {
    const { result, onSubmitMessage } = mountNotice({
      content: DIRTY,
      sendDisabled: true,
      sendDisabledHint: HINT,
      modelSlug: "claude-sonnet",
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    expect(onSubmitMessage).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith(HINT, { id: NOTICE_ID });
  });

  it("does not stack for repeats of the same blocked state, and re-arms once the window has passed", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
    const { result } = mountNotice({
      content: DIRTY,
      sendDisabled: true,
      sendDisabledHint: HINT,
      modelSlug: "claude-sonnet",
    });

    act(() => {
      result.current.submitDraft("enter");
      result.current.submitDraft("enter");
      result.current.submitDraft("enter");
    });
    vi.setSystemTime(new Date("2026-10-16T12:00:01.999Z"));
    act(() => {
      result.current.submitDraft("enter");
    });
    expect(toast.info).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-10-16T12:00:02Z"));
    act(() => {
      result.current.submitDraft("enter");
    });
    expect(toast.info).toHaveBeenCalledTimes(2);
  });

  it("shows nothing for an empty draft, where there is no message to refuse", () => {
    const { result } = mountNotice({
      content: EMPTY_DOC,
      sendDisabled: true,
      sendDisabledHint: HINT,
      modelSlug: "claude-sonnet",
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    expect(toast.info).not.toHaveBeenCalled();
  });

  it("still shows the hint while the model catalog has not resolved a slug", () => {
    const { result, onSubmitMessage } = mountNotice({
      content: DIRTY,
      sendDisabled: true,
      sendDisabledHint: HINT,
      modelSlug: "",
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    expect(onSubmitMessage).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith(HINT, { id: NOTICE_ID });
  });

  it("shows nothing for an empty draft while the model slug is unresolved", () => {
    const { result } = mountNotice({
      content: EMPTY_DOC,
      sendDisabled: true,
      sendDisabledHint: HINT,
      modelSlug: "",
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    expect(toast.info).not.toHaveBeenCalled();
  });

  it("shows nothing when send is not disabled", () => {
    const { result, onSubmitMessage } = mountNotice({
      content: DIRTY,
      sendDisabled: false,
      sendDisabledHint: HINT,
      modelSlug: "claude-sonnet",
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    expect(onSubmitMessage).toHaveBeenCalledTimes(1);
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("shows nothing when send is disabled but there is no hint to say", () => {
    const { result } = mountNotice({
      content: DIRTY,
      sendDisabled: true,
      sendDisabledHint: null,
      modelSlug: "claude-sonnet",
    });

    act(() => {
      result.current.submitDraft("enter");
    });

    expect(toast.info).not.toHaveBeenCalled();
  });
});

function mountSubmitHook(args: {
  readonly taskId: string;
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly onSubmitMessage: (input: ChatComposerSubmitInput) => boolean;
}) {
  return mountSubmitHookWith({
    ...args,
    sendDisabled: false,
    sendDisabledHint: null,
    modelSlug: "claude-sonnet",
    targetHostId: null,
    wrapper: ({ children }) => children,
  });
}

function mountSubmitHookWith(args: {
  readonly taskId: string;
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly onSubmitMessage: (input: ChatComposerSubmitInput) => boolean;
  readonly sendDisabled: boolean;
  readonly sendDisabledHint: string | null;
  readonly modelSlug: string;
  readonly targetHostId: string | null;
  readonly wrapper: (props: { readonly children: ReactNode }) => ReactNode;
}) {
  const pickerStore = createComposerPickerStore();
  const toolbarStore = createComposerToolbarStore({
    purpose: "run",
    reasoningFallback: "model-default",
    seedKey: "chat-submit-gate-ready-test",
    values: {
      ultracode: false,
      permission: "supervised",
      selection: {
        harnessId: "claude",
        modelSlug: args.modelSlug,
        profileId: null,
      },
      reasoning: "medium",
      serviceTier: "",
    },
    onSettingsChange: null,
    tuiOnly: false,
    chatLineCarriesAutoMode: null,
    ultracodeCarried: false,
    hostId: null,
  });

  return renderHook(
    () =>
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
        sendDisabled: args.sendDisabled,
        sendDisabledHint: args.sendDisabledHint,
        workspaceBlocked: false,
        imagesUnsupported: false,
        attachmentPreparationPending: false,
        onSubmitMessage: args.onSubmitMessage,
        onSideChat: null,
        targetHostId: args.targetHostId,
        queueEditTargetId: null,
        // The gate is off in these fixtures: they predate it and assert the
        // inline behaviour, which is what `false` preserves exactly.
        getDraftBlobBridgeSupported: () => false,
      }),
    { wrapper: args.wrapper },
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
