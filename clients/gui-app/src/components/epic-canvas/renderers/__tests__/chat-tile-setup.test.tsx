import "../../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ExternalToast } from "sonner";

vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    HostWorkspaceSelector: () => null,
  }),
);

vi.mock("@/lib/host", () => ({
  useHostClient: () => ({
    request: () => new Promise(() => {}),
    getActiveHostId: () => "host-test",
    getRequestContextUserId: () => "user-test",
    onChange: () => () => undefined,
  }),
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-test",
}));

const focusSession = vi.hoisted(() => vi.fn());
const openTileInTab = vi.hoisted(() => vi.fn());
const setActiveTileTab = vi.hoisted(() => vi.fn());
const setActiveTilePane = vi.hoisted(() => vi.fn());

vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: (selector: (state: unknown) => unknown) =>
    selector({
      openTileInTab,
      setActiveTileTab,
      setActiveTilePane,
    }),
  findOpenArtifactInTab: () => null,
}));

const sonnerToastWarning = vi.hoisted(() =>
  vi.fn<(message: ReactNode, options: ExternalToast | undefined) => string>(
    () => "warning-toast",
  ),
);
const sonnerToastError = vi.hoisted(() => vi.fn());
const sonnerToast = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => ({
  toast: Object.assign(sonnerToast, {
    warning: sonnerToastWarning,
    error: sonnerToastError,
    dismiss: vi.fn(),
  }),
  __esModule: true,
}));

import type {
  ChatEvent,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { ChatControlStrip } from "../chat-tile-control-strip";
import { ChatTileErrorNoticeToasts } from "../chat-tile-error-notice-toasts";
import { useChatSetupFailureRestoreDriver } from "@/hooks/chats/use-chat-setup-failure-restore-driver";

const EPIC_ID = "epic-x";
const CHAT_ID = "chat-x";
const OWNER_ID = "owner-x";

interface Harness {
  readonly handle: ChatSessionStoreHandle;
  readonly callbacks: () => ChatStreamCallbacks;
}

function createHarness(): Harness {
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: OWNER_ID,
    onAuthError: null,
    onProviderAuthError: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        sendAction: () => undefined,
        close: () => undefined,
      };
    },
  });
  return {
    handle,
    callbacks: () => {
      if (callbacks === null) throw new Error("expected callbacks");
      return callbacks;
    },
  };
}

function chatEvent(
  eventId: string,
  type: ChatEvent["type"],
  metadata: Record<string, unknown> | null,
  overrides: Partial<ChatEvent>,
): ChatEvent {
  return {
    eventId,
    type,
    timestamp: 1,
    clientActionId: null,
    actor: null,
    message: null,
    turnId: null,
    messageId: null,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata,
    ...overrides,
  };
}

function emitSnapshot(
  callbacks: ChatStreamCallbacks,
  events: ReadonlyArray<ChatEvent>,
  messages: ReadonlyArray<Message>,
): void {
  callbacks.onConnectionStatus("open", null);
  callbacks.onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat: {
        id: CHAT_ID,
        parentId: null,
        userId: OWNER_ID,
        hostId: "test-host",
        title: "Setup Chat",
        createdAt: 0,
        updatedAt: 0,
        isTitleEditedByUser: false,
        settings: null,
        activeSessionChain: null,
        claudePendingWakes: [],
        messages: [...messages],
        events: [...events],
      },
      access: { role: "owner", ownerUserId: OWNER_ID, canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      pendingFileEditApprovals: [],
      accumulatedFileChanges: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
    },
  });
}

function appendEvent(callbacks: ChatStreamCallbacks, event: ChatEvent): void {
  callbacks.onEventAppended({
    kind: "eventAppended",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    event,
  });
}

beforeEach(() => {
  focusSession.mockReset();
  openTileInTab.mockReset();
  setActiveTileTab.mockReset();
  setActiveTilePane.mockReset();
  sonnerToast.mockReset();
  sonnerToastWarning.mockReset();
  sonnerToastWarning.mockReturnValue("warning-toast");
  sonnerToastError.mockReset();
  useComposerDraftStore.setState({ drafts: {} });
  useDesktopDialogStore.setState({
    activeDialog: null,
    reportIssueAvailable: false,
    reportIssueContext: null,
    reportIssueDraftId: 0,
  });
});

afterEach(() => {
  cleanup();
  useDesktopDialogStore.setState({
    activeDialog: null,
    reportIssueAvailable: false,
    reportIssueContext: null,
    reportIssueDraftId: 0,
  });
});

describe("useChatSetupFailureRestoreDriver", () => {
  function DriverHost(props: { handle: ChatSessionStoreHandle }) {
    useChatSetupFailureRestoreDriver({
      handle: props.handle,
      nodeId: CHAT_ID,
    });
    return null;
  }

  it("restores the failed prompt to the composer once and removes the pending entry", () => {
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), [], []);

    const failedContent = {
      type: "doc" as const,
      content: [
        {
          type: "paragraph" as const,
          content: [{ type: "text" as const, text: "queued prompt" }],
        },
      ],
    };

    act(() => {
      harness.handle.store.getState().sendMessage(
        failedContent,
        { type: "user", userId: OWNER_ID },
        {
          harnessId: "codex",
          model: "gpt-5-codex",
          permissionMode: "supervised",
          reasoningEffort: "medium",
          serviceTier: null,
          agentMode: "epic",
          profileId: null,
        },
      );
    });
    const sent = harness.handle.store.getState().pendingUserMessages.at(0);
    if (sent === undefined) throw new Error("expected pending user message");

    render(<DriverHost handle={harness.handle} />);

    act(() => {
      appendEvent(
        harness.callbacks(),
        chatEvent(
          "evt-failed",
          "setup.failed",
          { workspacePath: "/repo", setupExitCode: 1 },
          { messageId: sent.messageId },
        ),
      );
    });

    expect(harness.handle.store.getState().pendingUserMessages).toEqual([]);
    expect(useComposerDraftStore.getState().drafts[CHAT_ID]?.content).toEqual(
      failedContent,
    );

    const epochAfterFirst =
      useComposerDraftStore.getState().drafts[CHAT_ID]?.resetEpoch ?? 0;

    // Re-emitting the same eventId after a snapshot replay must not
    // double-restore - the dedupe set keeps the composer untouched.
    act(() => {
      appendEvent(
        harness.callbacks(),
        chatEvent(
          "evt-failed",
          "setup.failed",
          { workspacePath: "/repo", setupExitCode: 1 },
          { messageId: sent.messageId },
        ),
      );
    });

    expect(useComposerDraftStore.getState().drafts[CHAT_ID]?.resetEpoch).toBe(
      epochAfterFirst,
    );
  });

  it("restores the failed prompt when actionAck and messageAccepted arrive before setup.failed", () => {
    // Bug guard for setup-gating restoration after the host accepted
    // the send. `actionAck`+`messageAccepted` clear `pendingUserMessages`
    // long before the gating `setup.failed` lands. The accepted-action
    // record retains the original prompt content so the driver can
    // still seed the composer with it exactly once.
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), [], []);

    const failedContent = {
      type: "doc" as const,
      content: [
        {
          type: "paragraph" as const,
          content: [{ type: "text" as const, text: "queued prompt" }],
        },
      ],
    };

    act(() => {
      harness.handle.store.getState().sendMessage(
        failedContent,
        { type: "user", userId: OWNER_ID },
        {
          harnessId: "codex",
          model: "gpt-5-codex",
          permissionMode: "supervised",
          reasoningEffort: "medium",
          serviceTier: null,
          agentMode: "epic",
          profileId: null,
        },
      );
    });
    const sent = harness.handle.store.getState().pendingUserMessages.at(0);
    if (sent === undefined) throw new Error("expected pending user message");

    render(<DriverHost handle={harness.handle} />);

    act(() => {
      harness.callbacks().onActionAck({
        kind: "actionAck",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        clientActionId: sent.clientActionId,
        action: "send",
        status: "accepted",
        reason: null,
        code: null,
        backgroundStopTaskIds: [],
      });
      harness.callbacks().onMessageAccepted({
        kind: "messageAccepted",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        message: {
          role: "user",
          messageId: sent.messageId,
          sender: { type: "user", userId: OWNER_ID },
          message: {
            kind: "user",
            content: failedContent,
          },
          timestamp: 2,
          sessionAnchor: null,
        },
      });
    });

    expect(harness.handle.store.getState().pendingUserMessages).toEqual([]);
    expect(useComposerDraftStore.getState().drafts[CHAT_ID]).toBeUndefined();

    act(() => {
      appendEvent(
        harness.callbacks(),
        chatEvent(
          "evt-failed",
          "setup.failed",
          { workspacePath: "/repo", setupExitCode: 1 },
          { messageId: sent.messageId, clientActionId: sent.clientActionId },
        ),
      );
    });

    expect(useComposerDraftStore.getState().drafts[CHAT_ID]?.content).toEqual(
      failedContent,
    );
    const epochAfterRestore =
      useComposerDraftStore.getState().drafts[CHAT_ID]?.resetEpoch ?? 0;

    // Replaying the same setup.failed event must be idempotent: the
    // dedupe set short-circuits the driver and the accepted-action
    // record's restoreContent slot is now `null`, so a second pass
    // also has nothing to hand back.
    act(() => {
      appendEvent(
        harness.callbacks(),
        chatEvent(
          "evt-failed",
          "setup.failed",
          { workspacePath: "/repo", setupExitCode: 1 },
          { messageId: sent.messageId, clientActionId: sent.clientActionId },
        ),
      );
    });

    expect(useComposerDraftStore.getState().drafts[CHAT_ID]?.resetEpoch).toBe(
      epochAfterRestore,
    );
  });

  it("still restores the gating prompt when a transition-only setup.failed lands afterwards", () => {
    // Bug guard for the setup-failure restore ordering bug. When the
    // orchestrator's binding-change observer emits a transition-only
    // `setup.failed` (`messageId: null`) after the gating event for the
    // same workspace, the driver must still resolve the gating event
    // and restore its content into the composer - choosing the latest
    // event would skip restoration because the transition-only entry
    // has no `messageId`.
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), [], []);

    const failedContent = {
      type: "doc" as const,
      content: [
        {
          type: "paragraph" as const,
          content: [{ type: "text" as const, text: "queued prompt" }],
        },
      ],
    };

    act(() => {
      harness.handle.store.getState().sendMessage(
        failedContent,
        { type: "user", userId: OWNER_ID },
        {
          harnessId: "codex",
          model: "gpt-5-codex",
          permissionMode: "supervised",
          reasoningEffort: "medium",
          serviceTier: null,
          agentMode: "epic",
          profileId: null,
        },
      );
    });
    const sent = harness.handle.store.getState().pendingUserMessages.at(0);
    if (sent === undefined) throw new Error("expected pending user message");

    render(<DriverHost handle={harness.handle} />);

    act(() => {
      appendEvent(
        harness.callbacks(),
        chatEvent(
          "evt-gating",
          "setup.failed",
          {
            workspacePath: "/repo",
            setupExitCode: 1,
            terminalSessionId: "term-gating",
          },
          { messageId: sent.messageId, clientActionId: "send-1" },
        ),
      );
      appendEvent(
        harness.callbacks(),
        chatEvent(
          "evt-transition",
          "setup.failed",
          {
            workspacePath: "/repo",
            setupExitCode: 1,
            terminalSessionId: "term-transition",
          },
          {},
        ),
      );
    });

    expect(harness.handle.store.getState().pendingUserMessages).toEqual([]);
    expect(useComposerDraftStore.getState().drafts[CHAT_ID]?.content).toEqual(
      failedContent,
    );
  });

  it("restores content when setup is cancelled so the message can be resubmitted", () => {
    // Stop-during-setup cancellation leaves the chat turn without a
    // completed user message. Restore the locally cached prompt to the
    // composer and clear the optimistic pending row so the user can edit
    // and resubmit instead of being stranded in read-only pending state.
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), [], []);

    const queuedContent = {
      type: "doc" as const,
      content: [
        {
          type: "paragraph" as const,
          content: [{ type: "text" as const, text: "queued prompt" }],
        },
      ],
    };

    act(() => {
      harness.handle.store.getState().sendMessage(
        queuedContent,
        { type: "user", userId: OWNER_ID },
        {
          harnessId: "codex",
          model: "gpt-5-codex",
          permissionMode: "supervised",
          reasoningEffort: "medium",
          serviceTier: null,
          agentMode: "epic",
          profileId: null,
        },
      );
    });
    const sent = harness.handle.store.getState().pendingUserMessages.at(0);
    if (sent === undefined) throw new Error("expected pending user message");

    render(<DriverHost handle={harness.handle} />);

    act(() => {
      appendEvent(
        harness.callbacks(),
        chatEvent(
          "evt-cancelled",
          "setup.cancelled",
          {
            workspacePath: "/repo",
            terminalSessionId: "term-cancelled",
          },
          { messageId: sent.messageId, clientActionId: "send-1" },
        ),
      );
    });

    expect(useComposerDraftStore.getState().drafts[CHAT_ID]?.content).toEqual(
      queuedContent,
    );
    expect(harness.handle.store.getState().pendingUserMessages).toEqual([]);
  });

  it("does not re-restore after a retry transitions setup back to running", () => {
    // After Flow 8 restoration the user typically retries setup. The
    // ensuing `setup.running` (or `setup.succeeded`) for the same
    // workspace must clear the restorable failure so a re-render of
    // the driver does not seed the composer a second time on top of
    // any edits the user has made.
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), [], []);

    const failedContent = {
      type: "doc" as const,
      content: [
        {
          type: "paragraph" as const,
          content: [{ type: "text" as const, text: "queued prompt" }],
        },
      ],
    };

    act(() => {
      harness.handle.store.getState().sendMessage(
        failedContent,
        { type: "user", userId: OWNER_ID },
        {
          harnessId: "codex",
          model: "gpt-5-codex",
          permissionMode: "supervised",
          reasoningEffort: "medium",
          serviceTier: null,
          agentMode: "epic",
          profileId: null,
        },
      );
    });
    const sent = harness.handle.store.getState().pendingUserMessages.at(0);
    if (sent === undefined) throw new Error("expected pending user message");

    render(<DriverHost handle={harness.handle} />);

    act(() => {
      appendEvent(
        harness.callbacks(),
        chatEvent(
          "evt-gating",
          "setup.failed",
          { workspacePath: "/repo", setupExitCode: 1 },
          { messageId: sent.messageId, clientActionId: "send-1" },
        ),
      );
    });
    expect(useComposerDraftStore.getState().drafts[CHAT_ID]?.content).toEqual(
      failedContent,
    );

    // Simulate the user editing the restored draft - a subsequent
    // setup.running for the retry must not stomp on this content.
    act(() => {
      useComposerDraftStore.getState().replaceDraft(
        CHAT_ID,
        {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "edited" }],
            },
          ],
        },
        null,
      );
    });
    const editedEpoch =
      useComposerDraftStore.getState().drafts[CHAT_ID]?.resetEpoch ?? 0;

    act(() => {
      appendEvent(
        harness.callbacks(),
        chatEvent(
          "evt-running",
          "setup.running",
          { workspacePath: "/repo", terminalSessionId: "term-retry" },
          {},
        ),
      );
    });

    expect(useComposerDraftStore.getState().drafts[CHAT_ID]?.resetEpoch).toBe(
      editedEpoch,
    );
    expect(
      useComposerDraftStore.getState().drafts[CHAT_ID]?.content,
    ).not.toEqual(failedContent);
  });

  it("toasts a path-less setup failure (no card can render it) and still restores the prompt", () => {
    // The generic SETUP_AWAIT_FAILED catch-all emits a `setup.failed` with no
    // `workspacePath`, so the in-transcript card can't anchor it - the toast is
    // the only failure feedback, restoring the parity the old banner provided.
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), [], []);

    const failedContent = {
      type: "doc" as const,
      content: [
        {
          type: "paragraph" as const,
          content: [{ type: "text" as const, text: "queued prompt" }],
        },
      ],
    };

    act(() => {
      harness.handle.store.getState().sendMessage(
        failedContent,
        { type: "user", userId: OWNER_ID },
        {
          harnessId: "codex",
          model: "gpt-5-codex",
          permissionMode: "supervised",
          reasoningEffort: "medium",
          serviceTier: null,
          agentMode: "epic",
          profileId: null,
        },
      );
    });
    const sent = harness.handle.store.getState().pendingUserMessages.at(0);
    if (sent === undefined) throw new Error("expected pending user message");

    render(<DriverHost handle={harness.handle} />);

    act(() => {
      appendEvent(
        harness.callbacks(),
        chatEvent(
          "evt-pathless",
          "setup.failed",
          { code: "SETUP_AWAIT_FAILED" },
          { messageId: sent.messageId },
        ),
      );
    });

    expect(sonnerToastError).toHaveBeenCalledWith(
      "Setup failed before the first message could run.",
    );
    // The prompt is still restored so the user doesn't lose their text.
    expect(useComposerDraftStore.getState().drafts[CHAT_ID]?.content).toEqual(
      failedContent,
    );
  });

  it("does not toast a path-ful setup failure (the inline card surfaces it)", () => {
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), [], []);

    const failedContent = {
      type: "doc" as const,
      content: [
        {
          type: "paragraph" as const,
          content: [{ type: "text" as const, text: "queued prompt" }],
        },
      ],
    };

    act(() => {
      harness.handle.store.getState().sendMessage(
        failedContent,
        { type: "user", userId: OWNER_ID },
        {
          harnessId: "codex",
          model: "gpt-5-codex",
          permissionMode: "supervised",
          reasoningEffort: "medium",
          serviceTier: null,
          agentMode: "epic",
          profileId: null,
        },
      );
    });
    const sent = harness.handle.store.getState().pendingUserMessages.at(0);
    if (sent === undefined) throw new Error("expected pending user message");

    render(<DriverHost handle={harness.handle} />);

    act(() => {
      appendEvent(
        harness.callbacks(),
        chatEvent(
          "evt-pathful",
          "setup.failed",
          { workspacePath: "/repo", setupExitCode: 1 },
          { messageId: sent.messageId },
        ),
      );
    });

    // A path-ful failure renders an inline failure card, so no toast fires.
    expect(sonnerToastError).not.toHaveBeenCalled();
  });

  it("does not toast a historical path-less failure with no restorable content (cold snapshot open)", () => {
    // Regression: the path-less toast must fire only alongside an actual
    // restoration. The path-less `setup.failed` already lives in `events` when
    // the store hydrates from snapshot, but nothing was sent in this session,
    // so `takeSetupFailedRestoration` returns null. Toasting here would
    // re-announce a stale failure every time the chat is reopened.
    const harness = createHarness();
    emitSnapshot(
      harness.callbacks(),
      [
        chatEvent(
          "evt-pathless-historical",
          "setup.failed",
          { code: "SETUP_AWAIT_FAILED" },
          { messageId: "msg-old" },
        ),
      ],
      [],
    );

    render(<DriverHost handle={harness.handle} />);

    expect(sonnerToastError).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().drafts[CHAT_ID]).toBeUndefined();
  });

  it("does not re-toast a path-less failure after the driver remounts (restore slot already consumed)", () => {
    // Regression for the "fresh dedupe set on remount" path. The first mount
    // toasts + restores and consumes the one-shot restore slot. On remount the
    // dedupe set is empty again and `events` still carry the failure, but
    // `takeSetupFailedRestoration` now returns null - so the toast must stay
    // silent instead of re-firing the old failure.
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), [], []);

    const failedContent = {
      type: "doc" as const,
      content: [
        {
          type: "paragraph" as const,
          content: [{ type: "text" as const, text: "queued prompt" }],
        },
      ],
    };

    act(() => {
      harness.handle.store.getState().sendMessage(
        failedContent,
        { type: "user", userId: OWNER_ID },
        {
          harnessId: "codex",
          model: "gpt-5-codex",
          permissionMode: "supervised",
          reasoningEffort: "medium",
          serviceTier: null,
          agentMode: "epic",
          profileId: null,
        },
      );
    });
    const sent = harness.handle.store.getState().pendingUserMessages.at(0);
    if (sent === undefined) throw new Error("expected pending user message");

    const first = render(<DriverHost handle={harness.handle} />);

    act(() => {
      appendEvent(
        harness.callbacks(),
        chatEvent(
          "evt-pathless",
          "setup.failed",
          { code: "SETUP_AWAIT_FAILED" },
          { messageId: sent.messageId },
        ),
      );
    });

    expect(sonnerToastError).toHaveBeenCalledTimes(1);
    sonnerToastError.mockClear();

    // Remount against the same store: events still carry the failure, but the
    // restore slot is now consumed.
    first.unmount();
    render(<DriverHost handle={harness.handle} />);

    expect(sonnerToastError).not.toHaveBeenCalled();
  });
});

describe("<ChatTileErrorNoticeToasts />", () => {
  it("keeps warning severity and reports with fixed chat context", () => {
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), [], []);
    useDesktopDialogStore.setState({ reportIssueAvailable: true });

    render(<ChatTileErrorNoticeToasts handle={harness.handle} />);

    const unsafeMessage =
      "The request for alice@example.com in /Users/alice/private failed.";
    act(() => {
      harness.callbacks().onErrorNotice({
        kind: "errorNotice",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        notice: {
          code: "SECRET_/Users/alice/private",
          message: unsafeMessage,
          severity: "warning",
          clientActionId: "interview-1",
        },
      });
    });

    expect(sonnerToastWarning.mock.lastCall?.[0]).toBe(unsafeMessage);
    expect(readWarningOptions().cancel).toMatchObject({
      label: "Report issue",
    });
    clickWarningReportAction();

    expect(useDesktopDialogStore.getState().reportIssueContext).toEqual({
      title: "Chat action failed",
      message: null,
      code: null,
      source: "Chat",
    });
    expect(
      JSON.stringify(useDesktopDialogStore.getState().reportIssueContext),
    ).not.toMatch(/alice@example\.com|\/Users\/alice|SECRET_/);
  });

  it("keeps warning notices non-reportable when capability is unavailable", () => {
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), [], []);

    render(<ChatTileErrorNoticeToasts handle={harness.handle} />);

    act(() => {
      harness.callbacks().onErrorNotice({
        kind: "errorNotice",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        notice: {
          code: "INTERVIEW_NOT_PENDING",
          message: "The interview request is no longer pending.",
          severity: "warning",
          clientActionId: "interview-1",
        },
      });
    });

    expect(sonnerToastWarning).toHaveBeenCalledWith(
      "The interview request is no longer pending.",
    );
  });

  it("does not replay notices that already existed before mount", () => {
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), [], []);

    act(() => {
      harness.callbacks().onErrorNotice({
        kind: "errorNotice",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        notice: {
          code: "APPROVAL_NOT_PENDING",
          message: "The approval request is no longer pending.",
          severity: "warning",
          clientActionId: "approval-1",
        },
      });
    });

    render(<ChatTileErrorNoticeToasts handle={harness.handle} />);

    expect(sonnerToastWarning).not.toHaveBeenCalled();
  });
});

function clickWarningReportAction(): void {
  const cancel = readWarningOptions().cancel;
  if (typeof cancel !== "object" || cancel === null || !("onClick" in cancel)) {
    throw new Error("Expected a warning report action.");
  }
  const action = render(
    <button type="button" onClick={cancel.onClick}>
      Trigger warning report
    </button>,
  );
  fireEvent.click(
    action.getByRole("button", { name: "Trigger warning report" }),
  );
  action.unmount();
}

function readWarningOptions(): ExternalToast {
  const options = sonnerToastWarning.mock.lastCall?.[1];
  if (options === undefined) {
    throw new Error("Expected warning toast options.");
  }
  return options;
}

describe("<ChatControlStrip />", () => {
  it("does not reserve persistent space for chat error notices", () => {
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), [], []);

    act(() => {
      harness.callbacks().onErrorNotice({
        kind: "errorNotice",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        notice: {
          code: "INTERVIEW_NOT_PENDING",
          message: "The interview request is no longer pending.",
          severity: "warning",
          clientActionId: "interview-1",
        },
      });
    });

    const { container, queryByText } = render(
      <ChatControlStrip
        state={harness.handle.store.getState()}
        canAct
        editingQueueItemId={null}
        onQueuePause={() => null}
        onResumeQueue={() => null}
        onQueueEdit={() => undefined}
        onQueueCancel={() => undefined}
        onQueueReorder={() => undefined}
      />,
    );

    expect(container.firstChild).toBeNull();
    expect(
      queryByText("The interview request is no longer pending."),
    ).toBeNull();
  });
});
