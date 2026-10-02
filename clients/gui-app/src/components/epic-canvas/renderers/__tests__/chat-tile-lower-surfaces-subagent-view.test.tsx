/**
 * While a subagent's conversation covers the transcript the lower surface
 * stops presenting the PARENT chat's composer and dock: a notice says whose
 * conversation this is and offers the way back. Pending approvals and an
 * interview question stay, since the subagent on screen may be waiting on one.
 */
import {
  cleanup,
  render as testingRender,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { domAnimation, LazyMotion } from "motion/react";
import type { ReactElement } from "react";
import type { InterviewQuestion } from "@traycer/protocol/persistence/epic/schemas";
import type {
  BackgroundItem,
  ChatQueuedPromptItem,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { JsonContent } from "@traycer/protocol/common/registry";

vi.mock("@/components/chat/composer/chat-composer", () => ({
  ChatComposer: () => <div data-testid="composer-stub" />,
}));
vi.mock("@/components/chat/chat-lower-dock", () => ({
  ChatLowerDock: () => <div data-testid="dock-stub" />,
}));
vi.mock("@/components/chat/chat-stop-children-dialog", () => ({
  StopChildrenDialog: () => null,
}));
vi.mock("@/hooks/agent/use-agent-stop-controls", () => ({
  useAgentStopControls: () => ({ self: null, descendants: [] }),
}));
vi.mock("@/hooks/agent/use-stop-agent-mutation", () => ({
  useAgentStop: () => ({ mutate: () => undefined }),
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

import {
  ChatLowerInteractionSurfaces,
  type ChatLowerInteractionSurfacesProps,
  type ChatLowerInterviewState,
} from "@/components/epic-canvas/renderers/chat-tile-lower-surfaces";
import type { SubagentDockView } from "@/components/chat/segments/subagent-open-as-chat";
import type { PendingInterviewView } from "@/components/epic-canvas/renderers/chat-tile-types";
import { WORKSPACE_COMPOSER_READY } from "@/lib/composer/workspace-composer-availability";
import { NO_PROVIDER_FALLBACK } from "@/components/chat/fallback/fallback-state";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";

const EMPTY_BACKGROUND_STOP_TASK_IDS: ReadonlySet<string> = new Set();

const RESTORE_CONTEXT: ChatRestoreContextValue = {
  accessRole: "owner",
  currentUserId: "user-1",
  activeHostId: "host-1",
  activeTurnStatus: null,
  localSnapshotsClearedAt: null,
  restore: null,
  restoreActionPending: false,
  restoreCheckpoint: () => null,
  accumulatedFileChanges: [],
  undeliveredChangeCount: 0,
  accumulatedSetComplete: true,
  revertFileChanges: () => null,
};

const QUESTION: InterviewQuestion = {
  questionId: "q-1",
  question: "Which one?",
  header: null,
  options: [{ label: "A", description: null, preview: null }],
  multiSelect: false,
  allowsCustomAnswer: null,
};

const ANSWERABLE_CARD: PendingInterviewView = {
  blockId: "streaming-block",
  questions: [QUESTION],
  assistantMessageId: null,
};

function render(ui: ReactElement) {
  return testingRender(
    <TabHostProvider hostId="host-1">
      <TooltipProvider delayDuration={0}>
        <LazyMotion features={domAnimation}>{ui}</LazyMotion>
      </TooltipProvider>
    </TabHostProvider>,
  );
}

function props(
  interview: ChatLowerInterviewState,
  canAct: boolean,
): ChatLowerInteractionSurfacesProps {
  return {
    epicId: "epic-1",
    viewTabId: "tab-1",
    chatId: "chat-1",
    hostId: "host-1",
    runtime: { snapshotLoaded: true },
    access: { isViewer: false, canAct, readOnlyNotice: null },
    turn: {
      activeTurnStatus: null,
      steerCapable: false,
      steerProtocolSupported: true,
      autoPermissionModeProtocolSupported: null,
      getDraftBlobBridgeSupported: () => false,
      getActiveTurnForSteer: () => null,
      // Unused by this suite - it covers the unanswerable-interview escape
      // hatch, not Stop.
      getStopConfirmationTarget: () => ({
        turnId: null,
        revision: 0,
        connectionEpoch: 0,
      }),
      stopDisabled: true,
      onStopTurn: () => null,
    },
    interview,
    approvals: {
      pendingFileEditApprovals: [],
      pendingApprovals: [],
      onFileEditDecision: () => undefined,
      onApprovalDecision: () => undefined,
      highlightedApprovalId: null,
      ruleDraftWorkspace: { remote: null, branch: null },
      onOpenSettings: () => undefined,
    },
    queue: {
      editingItem: null,
      editingItemId: null,
      value: { status: "idle", items: [] },
      resumeRequested: false,
      keepPausedRequested: false,
      onPause: () => null,
      onResume: () => null,
      onEdit: () => undefined,
      onCancel: () => undefined,
      onAbortSteer: () => undefined,
      onCancelEdit: () => undefined,
      onStopBackgroundItem: () => null,
      onStopAllBackgroundItems: () => null,
      onStopBackgroundSession: () => null,
      onReorder: () => undefined,
      onSteerNow: () => undefined,
    },
    composer: {
      sessionSettingsSeed: null,
      fallbackSettingsSeed: null,
      nodeId: "chat-1",
      isActive: true,
      mentionRoots: [],
      fallbackToGlobalMentionRoots: true,
      currentEpicId: "epic-1",
      onSubmitMessage: () => false,
      onSideChat: () => false,
      onSettingsChange: null,
      workspaceControls: null,
      workspaceAvailability: WORKSPACE_COMPOSER_READY,
      suggestedPrompt: undefined,
    },
    todo: null,
    restoreContext: RESTORE_CONTEXT,
    providerFallback: NO_PROVIDER_FALLBACK,
    backgroundItems: undefined,
    backgroundStopPendingTaskIds: EMPTY_BACKGROUND_STOP_TASK_IDS,
    backgroundStopAllPending: false,
    backgroundSessionStopPending: false,
    onBackgroundItemClick: () => undefined,
    subagentView: null,
  };
}

function interviewState(
  overrides: Partial<ChatLowerInterviewState>,
): ChatLowerInterviewState {
  return {
    pending: null,
    isBusy: false,
    unanswerable: [],
    unanswerableBusy: false,
    onAnswer: () => null,
    onSkip: () => null,
    onFork: null,
    highlightedBlockId: null,
    ...overrides,
  };
}

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "codex-test",
  permissionMode: "supervised",
  reasoningEffort: "medium",
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

const QUEUE_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Next" }] }],
};

const QUEUED_PROMPT: ChatQueuedPromptItem = {
  kind: "prompt",
  queueItemId: "queued-1",
  messageId: "queued-1-message",
  message: { kind: "user", content: QUEUE_CONTENT, browserAnnotations: [] },
  sender: { type: "user", userId: "owner-1" },
  settings: SETTINGS,
  accountContext: { type: "PERSONAL" },
  sentFromHostId: null,
  delivery: "next_turn",
  status: "pending",
  targetTurnId: null,
  steerRequest: null,
  fallbackReason: null,
  createdAt: 1,
  updatedAt: 1,
};

const RUNNING_COMMAND: BackgroundItem = {
  taskId: "task-1",
  kind: "command",
  title: "Command task-1",
  blockId: "task-1-block",
  parentTaskId: null,
  scheduledFor: null,
  individualStopUnavailable: null,
};

/** Props that would draw the dock and a composer if `subagentView` were null. */
function dockWorthyProps(
  subagentView: SubagentDockView | null,
): ChatLowerInteractionSurfacesProps {
  const base = props(interviewState({}), true);
  return {
    ...base,
    queue: {
      ...base.queue,
      value: { status: "idle", items: [QUEUED_PROMPT] },
    },
    backgroundItems: [RUNNING_COMMAND],
    subagentView,
  };
}

function view(
  name: string | null,
  runningCount: number,
  close: () => void,
): SubagentDockView {
  return { name, runningCount, close };
}

function noticeText(): string {
  return screen.getByTestId("subagent-view-notice").textContent;
}

describe("subagent view lower surface", () => {
  afterEach(cleanup);

  it("control: without a subagent view the composer and dock are drawn", () => {
    render(<ChatLowerInteractionSurfaces {...dockWorthyProps(null)} />);

    expect(screen.queryByTestId("composer-stub")).not.toBeNull();
    expect(screen.queryByTestId("dock-stub")).not.toBeNull();
    expect(screen.queryByTestId("subagent-view-notice")).toBeNull();
  });

  it("replaces the composer and dock with a notice naming the subagent", () => {
    render(
      <ChatLowerInteractionSurfaces
        {...dockWorthyProps(view("Mendel", 0, () => undefined))}
      />,
    );

    expect(noticeText()).toContain(
      "You're viewing Mendel's conversation. Subagents can't take messages.",
    );
    expect(screen.queryByTestId("composer-stub")).toBeNull();
    expect(screen.queryByTestId("dock-stub")).toBeNull();
    expect(screen.queryByText(/running/)).toBeNull();
  });

  it("shows how many of the subagent's background items are running", () => {
    render(
      <ChatLowerInteractionSurfaces
        {...dockWorthyProps(view("Mendel", 2, () => undefined))}
      />,
    );

    expect(screen.queryByText("2 running")).not.toBeNull();
  });

  it("uses the generic sentence when the subagent has no name", () => {
    render(
      <ChatLowerInteractionSurfaces
        {...dockWorthyProps(view(null, 0, () => undefined))}
      />,
    );

    expect(noticeText()).toContain(
      "You're viewing a subagent's conversation. Subagents can't take messages.",
    );
  });

  it("closes the subagent view from Back to chat", async () => {
    const user = userEvent.setup();
    const close = vi.fn<() => void>();
    render(
      <ChatLowerInteractionSurfaces
        {...dockWorthyProps(view("Mendel", 0, close))}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Back to chat" }));

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("still draws a pending interview card, which stands in the composer's slot", () => {
    const base = dockWorthyProps(view("Mendel", 0, () => undefined));
    render(
      <ChatLowerInteractionSurfaces
        {...base}
        interview={interviewState({ pending: ANSWERABLE_CARD })}
      />,
    );

    expect(screen.queryByTestId("interview-card")).not.toBeNull();
    expect(screen.queryByTestId("composer-stub")).toBeNull();
    expect(screen.queryByTestId("dock-stub")).toBeNull();
  });

  it("shows a viewer the notice and nothing that could take a message", () => {
    const base = dockWorthyProps(view("Mendel", 1, () => undefined));
    render(
      <ChatLowerInteractionSurfaces
        {...base}
        access={{ isViewer: true, canAct: false, readOnlyNotice: null }}
      />,
    );

    expect(noticeText()).toContain("You're viewing Mendel's conversation.");
    expect(screen.queryByTestId("composer-stub")).toBeNull();
    expect(screen.queryByTestId("dock-stub")).toBeNull();
  });
});
