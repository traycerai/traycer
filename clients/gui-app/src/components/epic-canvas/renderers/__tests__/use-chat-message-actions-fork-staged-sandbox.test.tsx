import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  FORK_ON_SOURCE_HOST,
  useChatMessageActions,
} from "@/components/epic-canvas/renderers/use-chat-message-actions";
import type { ChatMessageActionsInput } from "@/components/epic-canvas/renderers/use-chat-message-actions";
import type { ChatForkDialogTarget } from "@/components/chat/chat-fork-dialog";
import type { ChatActions } from "@/hooks/chats/use-chat-actions";
import type { NewStagedSandboxTarget } from "@/components/composer/use-sandbox-staging";
import { openChatClone } from "@/lib/chats/chat-clone-registry";

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-1",
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

// A mounted hook keeps its chat's clone flow registered: unmount every one.
afterEach(cleanup);

const SETTINGS: ChatRunSettings = {
  ultracode: false,
  harnessId: "claude",
  model: "claude-sonnet",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

const NEW_SANDBOX: NewStagedSandboxTarget = {
  kind: "new",
  configuration: { kind: "personal" },
  shape: {
    os: "linux",
    cpus: 2,
    memoryMb: 4096,
    diskMb: 20_480,
    region: "us-east",
    idleMinutes: 30,
    destroyAfterRestingMinutes: 10_080,
  },
  name: "",
  wakeString: "Suspend keeps memory",
};

// Every member present and typed: a partial stub behind a cast would hide a
// newly called action from the compiler and fail only at runtime.
function chatActionsStub(): ChatActions {
  return {
    sendMessage: vi.fn(),
    deleteMessageSuffix: vi.fn(),
    editUserMessage: vi.fn(),
    revertFileChanges: vi.fn(),
    stopTurn: vi.fn(),
    stopBackgroundItem: vi.fn(),
    stopAllBackgroundItems: vi.fn(),
    stopBackgroundSession: vi.fn(),
    pauseQueue: vi.fn(),
    resumeQueue: vi.fn(),
    queueEdit: vi.fn(),
    queueSettingsUpdate: vi.fn(),
    submitQueueEdit: vi.fn(),
    checkSendDelivery: vi.fn(),
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
    messageDeliveryRestored: vi.fn(),
  };
}

function inputFor(
  setForkTarget: (target: ChatForkDialogTarget | null) => void,
): ChatMessageActionsInput {
  return {
    dispatchUi: vi.fn(),
    activeInlineEdit: null,
    canModifyMessages: true,
    canAct: true,
    messageDelivery: null,
    setupCardShown: false,
    workingRowShown: false,
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
    setForkTarget,
    worktreeBinding: null,
    revertOnEditOpen: false,
    queuedCount: 0,
    getDraftBlobBridgeSupported: () => true,
  };
}

describe("forkAtAssistantMessage's staged sandbox", () => {
  it("lands the fork dialog on the new sandbox a host chip's New row described", () => {
    const setForkTarget =
      vi.fn<(target: ChatForkDialogTarget | null) => void>();
    const { result } = renderHook(() =>
      useChatMessageActions(inputFor(setForkTarget)),
    );

    act(() => {
      result.current.forkAtAssistantMessage(null, "plain", null, {
        initialHostId: null,
        onlyHostIds: null,
        stagedSandbox: NEW_SANDBOX,
        carriesComposerDraft: false,
      });
    });

    expect(setForkTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceChatId: "chat-1",
        initialHostId: null,
        onlyHostIds: null,
        stagedSandbox: NEW_SANDBOX,
      }),
    );
  });

  it("stages no sandbox for a per-message fork", () => {
    const setForkTarget =
      vi.fn<(target: ChatForkDialogTarget | null) => void>();
    const { result } = renderHook(() =>
      useChatMessageActions(inputFor(setForkTarget)),
    );

    act(() => {
      result.current.forkAtAssistantMessage(
        "message-1",
        "plain",
        null,
        FORK_ON_SOURCE_HOST,
      );
    });

    expect(setForkTarget).toHaveBeenCalledWith(
      expect.objectContaining({ stagedSandbox: null }),
    );
  });
});

describe("the chat's clone flow, opened from beside its tile", () => {
  it("opens the fork dialog on the whole chat, carrying the draft, while the tile is mounted", () => {
    const setForkTarget =
      vi.fn<(target: ChatForkDialogTarget | null) => void>();
    const { unmount } = renderHook(() =>
      useChatMessageActions(inputFor(setForkTarget)),
    );

    act(() => {
      expect(openChatClone("chat-1")).toBe(true);
    });

    expect(setForkTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceChatId: "chat-1",
        assistantMessageId: null,
        initialHostId: null,
        onlyHostIds: null,
        stagedSandbox: null,
        carriesComposerDraft: true,
      }),
    );
    unmount();
    expect(openChatClone("chat-1")).toBe(false);
  });
});
