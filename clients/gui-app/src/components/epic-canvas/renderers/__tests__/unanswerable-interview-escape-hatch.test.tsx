/**
 * Escape hatch for the composer deadlock: the host reports a pending interview,
 * the transcript renders no answer card for it (the block is settled or
 * missing), and every send is rejected with `DETACHED_INTERVIEW_PENDING`. The
 * only way out from inside the chat is dismissing the stuck block, so these
 * pin that the affordance appears and actually dispatches local `interviewSkip`.
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

import {
  ChatLowerInteractionSurfaces,
  type ChatLowerInteractionSurfacesProps,
  type ChatLowerInterviewState,
} from "@/components/epic-canvas/renderers/chat-tile-lower-surfaces";
import { UNANSWERABLE_INTERVIEW_DISMISS_REASON } from "@/components/chat/segments/pending-interview/unanswerable-interview-notice";
import type { PendingInterviewView } from "@/components/epic-canvas/renderers/chat-tile-types";
import { WORKSPACE_COMPOSER_READY } from "@/lib/composer/workspace-composer-availability";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import { TooltipProvider } from "@/components/ui/tooltip";

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
  revertFileChanges: () => null,
};

const QUESTION: InterviewQuestion = {
  questionId: "q-1",
  question: "Which one?",
  header: null,
  options: [{ label: "A", description: null, preview: null }],
  multiSelect: false,
};

const ANSWERABLE_CARD: PendingInterviewView = {
  blockId: "streaming-block",
  toolName: "AskUserQuestion",
  title: null,
  description: null,
  questions: [QUESTION],
  assistantMessageId: null,
};

function render(ui: ReactElement) {
  return testingRender(
    <TooltipProvider delayDuration={0}>
      <LazyMotion features={domAnimation}>{ui}</LazyMotion>
    </TooltipProvider>,
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
      getActiveTurnForSteer: () => null,
      stopDisabled: true,
      onStopTurn: () => null,
    },
    interview,
    approvals: {
      pendingFileEditApprovals: [],
      pendingApprovals: [],
      onFileEditDecision: () => undefined,
      onApprovalDecision: () => undefined,
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
      onSettingsChange: null,
      workspaceControls: null,
      workspaceAvailability: WORKSPACE_COMPOSER_READY,
    },
    todo: null,
    restoreContext: RESTORE_CONTEXT,
    backgroundItems: undefined,
    backgroundStopPendingTaskIds: EMPTY_BACKGROUND_STOP_TASK_IDS,
    backgroundStopAllPending: false,
    backgroundSessionStopPending: false,
    onBackgroundItemClick: () => undefined,
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
    ...overrides,
  };
}

function dismissButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("button", {
    name: "Dismiss question",
  });
}

describe("unanswerable interview escape hatch", () => {
  afterEach(cleanup);

  it("shows no notice when every host-pending interview has a card", () => {
    render(
      <ChatLowerInteractionSurfaces {...props(interviewState({}), true)} />,
    );

    expect(screen.queryByTestId("unanswerable-interview-notice")).toBeNull();
    expect(screen.queryByTestId("composer-stub")).not.toBeNull();
  });

  it("skips the stuck block when the composer is deadlocked", async () => {
    const user = userEvent.setup();
    const onSkip = vi.fn<(blockId: string, reason: string) => string | null>(
      () => "action-1",
    );
    render(
      <ChatLowerInteractionSurfaces
        {...props(
          interviewState({
            unanswerable: [{ blockId: "settled-block", requestedAt: 10 }],
            onSkip,
          }),
          true,
        )}
      />,
    );

    expect(
      screen.queryByTestId("unanswerable-interview-notice"),
    ).not.toBeNull();
    await user.click(dismissButton());

    expect(onSkip.mock.calls).toEqual([
      ["settled-block", UNANSWERABLE_INTERVIEW_DISMISS_REASON, undefined],
    ]);
  });

  it("clears every stuck block in one dismissal, oldest first", async () => {
    const user = userEvent.setup();
    const onSkip = vi.fn<(blockId: string, reason: string) => string | null>(
      () => "action-1",
    );
    render(
      <ChatLowerInteractionSurfaces
        {...props(
          interviewState({
            unanswerable: [
              { blockId: "older-block", requestedAt: 10 },
              { blockId: "newer-block", requestedAt: 20 },
            ],
            onSkip,
          }),
          true,
        )}
      />,
    );

    // Leaving even one behind keeps the host's send gate closed, so the single
    // button has to settle all of them.
    await user.click(
      screen.getByRole("button", { name: "Dismiss 2 questions" }),
    );

    expect(onSkip.mock.calls).toEqual([
      ["older-block", UNANSWERABLE_INTERVIEW_DISMISS_REASON, undefined],
      ["newer-block", UNANSWERABLE_INTERVIEW_DISMISS_REASON, undefined],
    ]);
  });

  it("keeps the composer reachable beneath the notice", () => {
    render(
      <ChatLowerInteractionSurfaces
        {...props(
          interviewState({
            unanswerable: [{ blockId: "settled-block", requestedAt: 10 }],
          }),
          true,
        )}
      />,
    );

    // Only `detached` waits gate sends host-side and the renderer cannot see
    // that flag, so the notice must not take the composer away.
    expect(screen.queryByTestId("composer-stub")).not.toBeNull();
  });

  it("shows the notice alongside an answerable card so neither hides the other", () => {
    render(
      <ChatLowerInteractionSurfaces
        {...props(
          interviewState({
            pending: ANSWERABLE_CARD,
            unanswerable: [{ blockId: "settled-block", requestedAt: 10 }],
          }),
          true,
        )}
      />,
    );

    expect(
      screen.queryByTestId("unanswerable-interview-notice"),
    ).not.toBeNull();
    expect(screen.queryByTestId("interview-card")).not.toBeNull();
  });

  it("disables dismissal while one is already in flight", () => {
    render(
      <ChatLowerInteractionSurfaces
        {...props(
          interviewState({
            unanswerable: [{ blockId: "settled-block", requestedAt: 10 }],
            unanswerableBusy: true,
          }),
          true,
        )}
      />,
    );

    expect(dismissButton().disabled).toBe(true);
  });

  it("still explains the deadlock but cannot dismiss while the chat cannot act", () => {
    render(
      <ChatLowerInteractionSurfaces
        {...props(
          interviewState({
            unanswerable: [{ blockId: "settled-block", requestedAt: 10 }],
          }),
          false,
        )}
      />,
    );

    expect(
      screen.queryByTestId("unanswerable-interview-notice"),
    ).not.toBeNull();
    expect(dismissButton().disabled).toBe(true);
  });
});
