import { renderHook, act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";

import { useChatMessageActions } from "@/components/epic-canvas/renderers/use-chat-message-actions";
import type { ChatMessageActionsInput } from "@/components/epic-canvas/renderers/use-chat-message-actions";
import type { InlineEditState } from "@/components/epic-canvas/renderers/chat-tile-session-state";
import type { ChatActions } from "@/hooks/chats/use-chat-actions";
import type { ChatMessage } from "@/stores/composer/chat-store";

/**
 * B2-2: an inline edit whose images have to be read back out of IndexedDB is
 * CANCELLABLE across that read - Escape and the Cancel button both just clear
 * the inline-edit state. The settled read used to call `editUserMessage`
 * anyway, with the captured target and the captured revert flags, so a
 * cancelled edit rewrote message history and reverted files on disk.
 *
 * `inlineEditIsPending` is no defence: it is set INSIDE the dispatch, so during
 * the read there is nothing for Cancel to refuse and nothing for the dispatch
 * to notice. The epoch is.
 */

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-1",
}));

// `performEditSubmit` now resolves a tab client for the edit-and-resend by-hash
// gate, and the real hook needs a `<HostRuntimeProvider>` these `renderHook`
// cases do not mount. `null` is also the RIGHT answer for them: with no client
// the gate cannot be taken, so every case here stays on the inline arms that
// are what it is pinning. The gate's own cases live in
// `use-chat-message-actions-edit-by-hash.test.tsx`, which supplies one.
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

const inliningMocks = vi.hoisted(() => ({
  inlineImageHashesFromSession: vi.fn<
    (content: JsonContent) => JsonContent | null
  >(() => null),
  inlineLocalImageHashes:
    vi.fn<(content: JsonContent) => Promise<JsonContent>>(),
}));

vi.mock("@/lib/composer/composer-image-inlining", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/composer/composer-image-inlining")
    >();
  return {
    ...actual,
    inlineImageHashesFromSession: inliningMocks.inlineImageHashesFromSession,
    inlineLocalImageHashes: inliningMocks.inlineLocalImageHashes,
  };
});

const SETTINGS: ChatRunSettings = {
  harnessId: "claude",
  model: "claude-sonnet",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

const EDIT_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "edited" }] }],
};

const TARGET_MESSAGE_ID = "persistent-message-1";

function originalMessage(): ChatMessage {
  return {
    id: "message-1",
    role: "user",
    content: "before",
    segments: [],
    structuredContent: EDIT_CONTENT,
    attachments: [],
    settings: SETTINGS,
    createdAt: 0,
    completedAt: null,
    stopped: null,
    persistentMessageId: TARGET_MESSAGE_ID,
    senderLabel: null,
    assistantMeta: null,
    statusLabel: null,
    agentSenderInfo: null,
    agentMessage: null,
    runState: null,
    sessionAnchor: null,
    steerBadge: null,
  };
}

function inlineEdit(): InlineEditState {
  return {
    targetMessageId: TARGET_MESSAGE_ID,
    originalMessage: originalMessage(),
    initialContent: EDIT_CONTENT,
    currentContent: EDIT_CONTENT,
    revision: 0,
    dirty: true,
    pendingClientActionId: null,
    pendingMessageId: null,
  };
}

const editUserMessage = vi.fn<ChatActions["editUserMessage"]>(() => ({
  clientActionId: "action-1",
  messageId: "sent-message-1",
}));

// Every member is present and typed: a partial stub behind a cast would hide a
// newly called action from the compiler and fail only at runtime.
function chatActionsStub(): ChatActions {
  return {
    sendMessage: vi.fn(),
    deleteMessageSuffix: vi.fn(),
    editUserMessage,
    revertFileChanges: vi.fn(),
    stopTurn: vi.fn(),
    stopBackgroundItem: vi.fn(),
    stopAllBackgroundItems: vi.fn(),
    stopBackgroundSession: vi.fn(),
    pauseQueue: vi.fn(),
    resumeQueue: vi.fn(),
    queueEdit: vi.fn(),
    queueSettingsUpdate: vi.fn(),
    restampQueuedItemSettings: vi.fn(),
    updateActivePermissionMode: vi.fn(),
    updateActiveProfile: vi.fn(),
    queueCancel: vi.fn(),
    queueReorder: vi.fn(),
    queueSteerNow: vi.fn(),
    queueAbortSteer: vi.fn(),
    approvalDecision: vi.fn(),
    fileEditApprovalDecision: vi.fn(),
    restoreCheckpoint: vi.fn(),
    interviewAnswer: vi.fn(),
    interviewSkip: vi.fn(),
    interviewDeliveryRetry: vi.fn(),
    ackFailedSendRestoration: vi.fn(),
    ackAcceptedAction: vi.fn(),
    takeSetupFailedRestoration: vi.fn(),
  };
}

/**
 * `activeInlineEdit` has to be spelled nullable HERE, not inferred: `renderHook`
 * takes `Props` from `initialProps`, so seeding it with a live edit would infer
 * a non-null `Props` and reject the `rerender({ activeInlineEdit: null })` that
 * IS the cancel these cases are about.
 */
interface EditSessionProps {
  readonly activeInlineEdit: InlineEditState | null;
}

function editSessionProps(
  activeInlineEdit: InlineEditState | null,
): EditSessionProps {
  return { activeInlineEdit };
}

function inputFor(
  activeInlineEdit: InlineEditState | null,
): ChatMessageActionsInput {
  return {
    dispatchUi: vi.fn(),
    activeInlineEdit,
    canModifyMessages: true,
    canAct: true,
    interviewDeliveryRetryProtocolSupported: true,
    currentComposerSettings: SETTINGS,
    editSettings: SETTINGS,
    slashCatalog: null,
    mentionRoots: [],
    fallbackToGlobalMentionRoots: false,
    currentEpicId: "epic-1",
    node: { id: "chat-1", instanceId: "instance-1", name: "Chat" },
    chatTitle: null,
    chatParentId: null,
    messages: [],
    events: [],
    transcriptWindow: null,
    profile: { userId: "user-1", userName: "Tester", email: "t@example.com" },
    chatActions: chatActionsStub(),
    pendingActions: {},
    acceptedActions: {},
    confirmingDeleteMessageId: null,
    setForkTarget: vi.fn(),
    worktreeBinding: null,
    revertOnEditOpen: false,
    queuedCount: 0,
  };
}

beforeEach(() => {
  editUserMessage.mockClear();
  inliningMocks.inlineImageHashesFromSession.mockReset();
  // `null` = at least one hash is session-cold, which is what forces the
  // asynchronous arm this whole pin is about.
  inliningMocks.inlineImageHashesFromSession.mockReturnValue(null);
  inliningMocks.inlineLocalImageHashes.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

const TYPED_CONTENT: JsonContent = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "edited and more" }] },
  ],
};

/** The same edit SESSION, one content revision later. */
function typedInlineEdit(): InlineEditState {
  return { ...inlineEdit(), currentContent: TYPED_CONTENT, revision: 1 };
}

describe("useChatMessageActions: edit session across the image read", () => {
  /**
   * W-3: the submit captures the document BEFORE the await, and until now the
   * only guard across that await was the edit-session epoch - which typing
   * deliberately does not bump. `editing.pending` stays false until
   * `markInlineEditPending` runs inside the dispatch, so the editor is enabled
   * the whole time.
   *
   * Submit image edit A, type B during the upload, let it settle: A was
   * dispatched and `normalizeInlineEditForSession` then cleared the live editor
   * on acceptance, destroying B unsent and unrecoverable. Cancel/retarget cases
   * cannot see this - the session is the SAME one throughout.
   */
  it("typing during the read does not dispatch the stale capture", async () => {
    let releaseRead: ((content: JsonContent) => void) | null = null;
    inliningMocks.inlineLocalImageHashes.mockImplementation(
      () =>
        new Promise<JsonContent>((resolve) => {
          releaseRead = resolve;
        }),
    );

    const { result, rerender } = renderHook(
      (props: EditSessionProps) =>
        useChatMessageActions(inputFor(props.activeInlineEdit)),
      { initialProps: editSessionProps(inlineEdit()) },
    );

    act(() => {
      result.current.revertOnEdit.onDontRevert();
    });
    expect(inliningMocks.inlineLocalImageHashes).toHaveBeenCalledTimes(1);

    // The user keeps typing while the read is outstanding. Same session, same
    // target, same revert flags - only the DOCUMENT moved.
    rerender(editSessionProps(typedInlineEdit()));

    await act(async () => {
      releaseRead?.(EDIT_CONTENT);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Nothing dispatched, so nothing clears the editor: the newer text is still
    // on screen and Enter re-sends it. Dispatching would have sent the older
    // document AND destroyed the newer one.
    expect(editUserMessage).not.toHaveBeenCalled();
  });

  it("cancelling during the read dispatches nothing", async () => {
    let releaseRead: ((content: JsonContent) => void) | null = null;
    inliningMocks.inlineLocalImageHashes.mockImplementation(
      () =>
        new Promise<JsonContent>((resolve) => {
          releaseRead = resolve;
        }),
    );

    const { result, rerender } = renderHook(
      (props: EditSessionProps) =>
        useChatMessageActions(inputFor(props.activeInlineEdit)),
      { initialProps: editSessionProps(inlineEdit()) },
    );

    act(() => {
      result.current.revertOnEdit.onDontRevert();
    });
    expect(inliningMocks.inlineLocalImageHashes).toHaveBeenCalledTimes(1);
    expect(editUserMessage).not.toHaveBeenCalled();

    // Escape / Cancel: the tile clears the inline-edit state while the read is
    // still outstanding.
    rerender(editSessionProps(null));

    await act(async () => {
      releaseRead?.(EDIT_CONTENT);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Nothing was written. Rewriting history and reverting files for an edit the
    // user took back is not something a later undo can put right, so the guard
    // has to land before the FIRST write, not unwind after it.
    expect(editUserMessage).not.toHaveBeenCalled();
  });

  it("an edit left alone across the read still dispatches", async () => {
    // The control for the control: the epoch must not refuse an edit that was
    // never cancelled, or the pin above would pass on a hook that dispatches
    // nothing at all.
    let releaseRead: ((content: JsonContent) => void) | null = null;
    inliningMocks.inlineLocalImageHashes.mockImplementation(
      () =>
        new Promise<JsonContent>((resolve) => {
          releaseRead = resolve;
        }),
    );

    const { result } = renderHook(
      (props: EditSessionProps) =>
        useChatMessageActions(inputFor(props.activeInlineEdit)),
      { initialProps: editSessionProps(inlineEdit()) },
    );

    act(() => {
      result.current.revertOnEdit.onDontRevert();
    });

    await act(async () => {
      releaseRead?.(EDIT_CONTENT);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(editUserMessage).toHaveBeenCalledTimes(1);
    });
    expect(editUserMessage.mock.calls[0][0].targetMessageId).toBe(
      TARGET_MESSAGE_ID,
    );
  });

  it("a second submit during the read is a no-op, including via the synchronous path", async () => {
    // The guard used to sit BETWEEN the synchronous session-cache dispatch and
    // the async arm. So: start a cold read, warm the cache (or remove the cold
    // image), press Enter again - the second submit dispatched at once, and the
    // first read then dispatched the same edit a second time.
    // `markInlineEditPending` changes neither the target id nor the epoch, so
    // the settling read still recognised its own session.
    let releaseRead: ((content: JsonContent) => void) | null = null;
    inliningMocks.inlineLocalImageHashes.mockImplementation(
      () =>
        new Promise<JsonContent>((resolve) => {
          releaseRead = resolve;
        }),
    );

    const { result } = renderHook(
      (props: EditSessionProps) =>
        useChatMessageActions(inputFor(props.activeInlineEdit)),
      { initialProps: editSessionProps(inlineEdit()) },
    );

    act(() => {
      result.current.revertOnEdit.onDontRevert();
    });
    expect(inliningMocks.inlineLocalImageHashes).toHaveBeenCalledTimes(1);
    expect(editUserMessage).not.toHaveBeenCalled();

    // Warm: the second press would now take the SYNCHRONOUS path.
    inliningMocks.inlineImageHashesFromSession.mockReturnValue(EDIT_CONTENT);
    act(() => {
      result.current.revertOnEdit.onDontRevert();
    });
    expect(editUserMessage).not.toHaveBeenCalled();

    await act(async () => {
      releaseRead?.(EDIT_CONTENT);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(editUserMessage).toHaveBeenCalledTimes(1);
    // The second submit never started a read of its own either.
    expect(inliningMocks.inlineLocalImageHashes).toHaveBeenCalledTimes(1);
  });

  it("retargeting to another message during the read dispatches nothing", async () => {
    // Cancel is not the only way out of an edit session: clicking Edit on a
    // different message replaces it. A guard keyed on the target ID alone would
    // also have to answer cancel-and-reopen-the-SAME-message, which reads as
    // the same session; the monotonic epoch answers both.
    let releaseRead: ((content: JsonContent) => void) | null = null;
    inliningMocks.inlineLocalImageHashes.mockImplementation(
      () =>
        new Promise<JsonContent>((resolve) => {
          releaseRead = resolve;
        }),
    );

    const { result, rerender } = renderHook(
      (props: EditSessionProps) =>
        useChatMessageActions(inputFor(props.activeInlineEdit)),
      { initialProps: editSessionProps(inlineEdit()) },
    );

    act(() => {
      result.current.revertOnEdit.onDontRevert();
    });

    rerender(
      editSessionProps({
        ...inlineEdit(),
        targetMessageId: "persistent-message-2",
      }),
    );

    await act(async () => {
      releaseRead?.(EDIT_CONTENT);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(editUserMessage).not.toHaveBeenCalled();
  });
});
