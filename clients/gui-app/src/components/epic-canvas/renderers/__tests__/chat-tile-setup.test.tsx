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

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-test",
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
const sonnerToastSuccess = vi.hoisted(() => vi.fn());
const sonnerToastDismiss = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => ({
  toast: Object.assign(sonnerToast, {
    warning: sonnerToastWarning,
    error: sonnerToastError,
    success: sonnerToastSuccess,
    dismiss: sonnerToastDismiss,
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
import { ChatTileErrorNoticeToasts } from "../chat-tile-error-notice-toasts";
import { ChatTileRestoreResultToasts } from "../chat-tile-restore-result-toasts";
import {
  PaneSurfaceActivityContext,
  PaneVisibilityContext,
} from "@/components/epic-tabs/pane-visibility-context";
import { useChatSetupFailureRestoreDriver } from "@/hooks/chats/use-chat-setup-failure-restore-driver";
import {
  dismissRetainedDraftToasts,
  resetRetainedDraftToastsForTests,
  retainedDraftToastCountForTests,
} from "@/lib/toast/retained-draft-toasts";

const EPIC_ID = "epic-x";
const CHAT_ID = "chat-x";
const OWNER_ID = "owner-x";

interface Harness {
  readonly handle: ChatSessionStoreHandle;
  readonly callbacks: () => ChatStreamCallbacks;
}

/**
 * A last-copy notice is rendered as an element so its whitespace survives, so
 * assertions read through the node rather than assuming a bare string.
 */
function toastText(message: unknown): string {
  if (typeof message === "string") return message;
  const children = (message as { props?: { children?: unknown } } | null)?.props
    ?.children;
  return typeof children === "string" ? children : "";
}

function createHarness(): Harness {
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    hostId: "host-a",
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
        sameTurnSteeringProtocolSupported: () => true,
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
        archivedAt: null,
        pinnedUserProviderHandle: null,
        lastDeliveredRolesDigest: null,
      },
      access: { role: "owner", ownerUserId: OWNER_ID, canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      pendingFileEditApprovals: [],
      accumulatedFileChanges: [],
      managedCommands: [],
      heldUpdates: [],
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
  sonnerToastSuccess.mockReset();
  sonnerToastDismiss.mockReset();
  resetRetainedDraftToastsForTests();
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
        "auto",
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
        "auto",
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
        "auto",
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
        "auto",
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
        "auto",
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
        "auto",
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
        "auto",
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
        "auto",
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
      title: "Agent action failed",
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

  // R7 `-oRs`: round 6 made the recovery STRING verbatim, but Sonner renders
  // it as ordinary HTML - so the newlines and indentation the byte guarantee
  // exists to protect collapse on screen and on copy. The presentation layer
  // has to preserve them or the guarantee stops at the store boundary.
  it("renders a last-copy notice with its whitespace preserved", () => {
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
          code: "SEND_NOT_RECORDED",
          message:
            "Copy the message below to resend it:\n    if True:\n        pass",
          severity: "warning",
          clientActionId: "send-1",
        },
      });
    });

    const rendered = sonnerToastWarning.mock.lastCall?.[0] as {
      readonly props: { readonly className: string; readonly children: string };
    };
    // Exact: a bare string is what collapses, and the class IS the guarantee.
    expect(rendered.props.className).toBe("whitespace-pre-wrap break-words");
    expect(rendered.props.children).toBe(
      "Copy the message below to resend it:\n    if True:\n        pass",
    );
  });

  // R4-3: a retained record's DELIVERY state has to be as durable as the
  // record. `clientActionIds` is FIFO-bounded at 128 while the ring exemption
  // made the records themselves unbounded, so ordinary chat traffic evicts a
  // delivered last-copy id - and the very next notice re-traverses the ring,
  // finds it "undelivered" and fires the never-expiring draft toast again.
  it("delivers a last-copy notice once, even as tracker churn evicts its id", () => {
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
          code: "SEND_NOT_RECORDED",
          message:
            "A message was not recorded.\n\nCopy the message below to resend it:\nmy draft",
          severity: "warning",
          clientActionId: "send-1",
        },
      });
    });

    // Ordinary traffic, more than the tracker's 128-id bound.
    act(() => {
      for (let index = 0; index < 200; index += 1) {
        harness.callbacks().onErrorNotice({
          kind: "errorNotice",
          hasBinaryPayload: false,
          epicId: EPIC_ID,
          chatId: CHAT_ID,
          notice: {
            code: "APPROVAL_NOT_PENDING",
            message: `no longer pending (${index})`,
            severity: "warning",
            clientActionId: `approval-${index}`,
          },
        });
      }
    });

    const draftToasts = sonnerToastWarning.mock.calls.filter((call) =>
      toastText(call[0]).includes("my draft"),
    );
    expect(draftToasts).toHaveLength(1);
  });

  // The reconnect-while-away case is exactly when a send-recovery notice
  // arrives: the pane is unfocused, so `useActivePaneEffect` has torn the
  // subscription down and the notice lands unseen. The mount-time replay used
  // to mark it delivered and then skip it for being a `warning`, which threw
  // away the only remaining copy of the user's text.
  it("replays a notice carrying the only copy of the user's text", () => {
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), [], []);

    act(() => {
      harness.callbacks().onErrorNotice({
        kind: "errorNotice",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        notice: {
          code: "SEND_NOT_RECORDED",
          message:
            "A message was not recorded before the turn stopped, and another unsent message is already waiting in the composer. Copy it from here to resend: the draft nobody has any more",
          severity: "warning",
          clientActionId: "send-1",
        },
      });
    });

    render(<ChatTileErrorNoticeToasts handle={harness.handle} />);

    expect(toastText(sonnerToastWarning.mock.lastCall?.[0])).toContain(
      "the draft nobody has any more",
    );
    // ...and it must not expire on the default fuse while it is the only copy.
    expect(sonnerToastWarning.mock.lastCall?.[1]).toMatchObject({
      duration: Number.POSITIVE_INFINITY,
    });
  });

  // `-LV77`: one ACTION legitimately has more than one thing to say. A
  // rejection states its account on a host-coded warning; if nobody saw that,
  // the ack says it again as a protected `SEND_RESTORED` under the SAME
  // `clientActionId`. Keying the tracker by id alone made the second telling a
  // duplicate of a notice that was MUTED rather than shown, so the one that
  // was supposed to reach the user was the one dropped.
  it("shows a second speaker for an action whose first was muted", () => {
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), [], []);

    act(() => {
      harness.callbacks().onErrorNotice({
        kind: "errorNotice",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        notice: {
          code: "ACTION_REJECTED",
          message: "STALE-REJECTION-TEXT",
          severity: "warning",
          clientActionId: "send-rejected-1",
        },
      });
    });

    // Mounting AFTER the notice landed is the unfocused-pane shape: the replay
    // sees a warning it will not show.
    render(<ChatTileErrorNoticeToasts handle={harness.handle} />);
    expect(sonnerToastWarning).not.toHaveBeenCalled();

    // ...so when the store later says the account properly, under the SAME
    // clientActionId, the dedup does not swallow it.
    act(() => {
      harness.callbacks().onErrorNotice({
        kind: "errorNotice",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        notice: {
          code: "SEND_RESTORED",
          message: "PROTECTED-ACCOUNT-TEXT",
          severity: "warning",
          clientActionId: "send-rejected-1",
        },
      });
    });

    // Exactly one toast, and it is the PROTECTED speaker - not the stale
    // warning resurrected out of the ring. Both assertions matter: an earlier
    // version of this test used two messages that shared a phrase, so it
    // passed while showing the wrong one.
    expect(sonnerToastWarning).toHaveBeenCalledTimes(1);
    expect(toastText(sonnerToastWarning.mock.lastCall?.[0])).toBe(
      "PROTECTED-ACCOUNT-TEXT",
    );
  });

  // The invariant the mount pass owes the subscription pass. That callback
  // re-walks the ENTIRE ring on every append with no severity gate, which is
  // only safe because everything the mount pass declined to show is already
  // remembered. Skip-without-remember turns each stale warning into a bomb
  // the next unrelated notice detonates - and a ring holding several bursts
  // them all at once.
  it("keeps a muted notice muted when an unrelated notice arrives later", () => {
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
          message: "STALE-MUTED-TEXT",
          severity: "warning",
          clientActionId: "approval-stale",
        },
      });
    });

    render(<ChatTileErrorNoticeToasts handle={harness.handle} />);
    expect(sonnerToastWarning).not.toHaveBeenCalled();

    act(() => {
      harness.callbacks().onErrorNotice({
        kind: "errorNotice",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        notice: {
          code: "INTERVIEW_NOT_PENDING",
          message: "FRESH-TEXT",
          severity: "warning",
          clientActionId: "interview-fresh",
        },
      });
    });

    // The fresh one speaks; the muted one stays muted.
    expect(sonnerToastWarning).toHaveBeenCalledTimes(1);
    expect(toastText(sonnerToastWarning.mock.lastCall?.[0])).toBe("FRESH-TEXT");
  });

  // `-IfOj`: a toast with NO lifetime needs an owner. The app-level
  // `<Toaster />` is mounted outside the auth-dependent tree, so an infinite
  // last-copy toast survives sign-out and user-switch - and its body is the
  // previous account's full draft, readable by whoever signs in next on a
  // shared desktop.
  it("hands a retained draft toast to the identity boundary", () => {
    resetRetainedDraftToastsForTests();
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
          code: "SEND_NOT_RECORDED",
          message: "A message was not recorded. the draft nobody has any more",
          severity: "warning",
          clientActionId: "send-retained-1",
        },
      });
    });

    expect(retainedDraftToastCountForTests()).toBe(1);

    dismissRetainedDraftToasts();

    expect(sonnerToastDismiss).toHaveBeenCalledWith("warning-toast");
    expect(retainedDraftToastCountForTests()).toBe(0);
  });

  // ...and ONLY those. The dismissal runs beside app-update and
  // worktree-delete toasts that own their own lifecycles, so tracking an
  // ordinary notice here would let an identity change reach through and take
  // down toasts this module never minted.
  it("does not hand ordinary notices to the identity boundary", () => {
    resetRetainedDraftToastsForTests();
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
          clientActionId: "interview-9",
        },
      });
    });

    expect(sonnerToastWarning).toHaveBeenCalled();
    expect(retainedDraftToastCountForTests()).toBe(0);
  });

  // `-CbBV`: the report affordance must not destroy what it reports about.
  //
  // Sonner's CANCEL button calls `deleteToast()` unconditionally once its
  // `onClick` returns - `preventDefault` is not consulted on that path - so
  // the auto-added "Report issue" cancel dismissed the infinite last-copy
  // toast. `CHAT_ACTION_REPORT_CONTEXT` carries `message: null`, and
  // `rememberErrorNotice` has already retained the id so nothing replays it:
  // using the report affordance destroyed the only copy of the draft.
  //
  // Sonner's ACTION button DOES check `event.defaultPrevented`, so that is
  // where a report affordance on a last-copy toast has to live.
  it("keeps a last-copy toast alive when its report affordance is used", () => {
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), [], []);
    useDesktopDialogStore.setState({ reportIssueAvailable: true });

    render(<ChatTileErrorNoticeToasts handle={harness.handle} />);

    act(() => {
      harness.callbacks().onErrorNotice({
        kind: "errorNotice",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        notice: {
          code: "SEND_NOT_RECORDED",
          message:
            "A message was not recorded before the turn stopped. Copy the message below to resend it:\nthe draft nobody has any more",
          severity: "warning",
          clientActionId: "send-report-1",
        },
      });
    });

    const options = readWarningOptions();
    // No CANCEL button: that is the one sonner always dismisses on.
    expect(options.cancel ?? null).toBeNull();
    // The report affordance rides the ACTION slot instead.
    expect(options.action).toMatchObject({ label: "Report issue" });

    // Using it opens the report dialog...
    const preventDefault = vi.fn();
    act(() => {
      const action = options.action;
      if (
        typeof action !== "object" ||
        action === null ||
        !("onClick" in action)
      ) {
        throw new Error("Expected a last-copy report action.");
      }
      action.onClick({ preventDefault } as never);
    });
    expect(useDesktopDialogStore.getState().reportIssueContext).toMatchObject({
      title: "Agent action failed",
      source: "Chat",
    });
    // ...and suppresses sonner's dismissal, so the only copy stays on screen.
    expect(preventDefault).toHaveBeenCalled();
  });
});

describe("<ChatTileRestoreResultToasts />", () => {
  function RestoreToastHost(props: {
    readonly active: boolean;
    readonly handle: ChatSessionStoreHandle;
  }) {
    const activity = {
      visible: props.active,
      focused: props.active,
    };
    return (
      <PaneSurfaceActivityContext.Provider value={activity}>
        <PaneVisibilityContext.Provider value={activity.visible}>
          <ChatTileRestoreResultToasts handle={props.handle} />
        </PaneVisibilityContext.Provider>
      </PaneSurfaceActivityContext.Provider>
    );
  }

  function completeRestore(harness: Harness, finishedAt: number): void {
    act(() => {
      harness.callbacks().onRestoreCompleted({
        kind: "restoreCompleted",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        checkpointId: "checkpoint-1",
        finishedAt,
        results: [
          {
            filePath: "/repo/src/app.ts",
            status: "restored",
            operation: "edit",
            reason: null,
          },
        ],
      });
    });
  }

  it("shows each completion once across task-tab focus changes and remounts", () => {
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), [], []);
    const view = render(
      <RestoreToastHost active={false} handle={harness.handle} />,
    );

    completeRestore(harness, 1);

    expect(sonnerToastSuccess).not.toHaveBeenCalled();

    view.rerender(<RestoreToastHost active handle={harness.handle} />);
    expect(sonnerToastSuccess).toHaveBeenCalledTimes(1);
    expect(sonnerToastSuccess).toHaveBeenLastCalledWith(
      "1 restored, 0 skipped, 0 failed",
    );

    view.rerender(<RestoreToastHost active={false} handle={harness.handle} />);
    view.rerender(<RestoreToastHost active handle={harness.handle} />);
    expect(sonnerToastSuccess).toHaveBeenCalledTimes(1);

    completeRestore(harness, 1);
    expect(sonnerToastSuccess).toHaveBeenCalledTimes(1);

    view.unmount();
    render(<RestoreToastHost active handle={harness.handle} />);
    expect(sonnerToastSuccess).toHaveBeenCalledTimes(1);

    completeRestore(harness, 2);

    expect(sonnerToastSuccess).toHaveBeenCalledTimes(2);
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
