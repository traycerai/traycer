/**
 * A chat whose sandbox rests can still be typed into: the message waits for the
 * sandbox's own wake. Only the composer's send opens up; the viewer's read-only
 * surface and the stream-bound actions are unchanged.
 */
import {
  cleanup,
  render as testingRender,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { domAnimation, LazyMotion } from "motion/react";
import type { ReactElement, ReactNode } from "react";
import type { OpenChatQueuedPromptItem } from "@traycer/protocol/host/agent/gui/subscribe";
import { PICKED_SETTINGS } from "@/lib/sandboxes/__tests__/pending-send-fixtures";

const composerProps = vi.hoisted(
  () =>
    [] as Array<{
      sendDisabled: boolean | undefined;
      hint: string | null | undefined;
      editingQueueItemId: string | null;
      canCancelEdit: boolean;
      hasWorkspaceControls: boolean;
    }>,
);
vi.mock("@/components/chat/composer/chat-composer", () => ({
  ChatComposer: (props: {
    readonly sendDisabled: boolean | undefined;
    readonly sendDisabledHint: string | null | undefined;
    readonly editingQueueItemId: string | null;
    readonly onCancelQueueEdit: (() => void) | undefined;
    readonly workspaceControls: ReactNode;
  }) => {
    composerProps.push({
      sendDisabled: props.sendDisabled,
      hint: props.sendDisabledHint,
      editingQueueItemId: props.editingQueueItemId,
      canCancelEdit: typeof props.onCancelQueueEdit === "function",
      hasWorkspaceControls: props.workspaceControls !== null,
    });
    return <div data-testid="composer-stub" />;
  },
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
  type ChatLowerAccessState,
  type ChatLowerInterviewState,
} from "@/components/epic-canvas/renderers/chat-tile-lower-surfaces";
import { WORKSPACE_COMPOSER_READY } from "@/lib/composer/workspace-composer-availability";
import { NO_PROVIDER_FALLBACK } from "@/components/chat/fallback/fallback-state";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";

const EMPTY_BACKGROUND_STOP_TASK_IDS: ReadonlySet<string> = new Set();

const RESTORE_CONTEXT: ChatRestoreContextValue = {
  accessRole: "owner",
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
  access: ChatLowerAccessState,
  editingItem: OpenChatQueuedPromptItem | null,
): ChatLowerInteractionSurfacesProps {
  const interview = interviewState({});
  return {
    epicId: "epic-1",
    viewTabId: "tab-1",
    chatId: "chat-1",
    hostId: "host-1",
    runtime: { snapshotLoaded: true },
    access,
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
      editingItem,
      editingItemId: editingItem?.queueItemId ?? null,
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
      workspaceControls: <div data-testid="host-workspace-selector" />,
      workspaceAvailability: WORKSPACE_COMPOSER_READY,
      onContinueOnTeamHosts: () => undefined,
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

const FRESH_ACCESS = {
  isViewer: false,
  isCopy: false,
  canAct: false,
  readOnlyNotice: null,
} as const;

function lastComposer() {
  return composerProps.at(-1);
}

afterEach(() => {
  cleanup();
  composerProps.length = 0;
});

describe("the composer of a chat on a resting sandbox", () => {
  it("lets a reconnecting non-viewer send, with no disabled hint", () => {
    render(
      <ChatLowerInteractionSurfaces
        {...props({ ...FRESH_ACCESS, restingSandbox: true }, null)}
      />,
    );

    expect(screen.getByTestId("composer-stub")).toBeTruthy();
    expect(lastComposer()).toMatchObject({
      sendDisabled: false,
      hint: null,
      hasWorkspaceControls: true,
    });
  });

  it("still blocks the same non-viewer's send without a resting sandbox", () => {
    render(<ChatLowerInteractionSurfaces {...props(FRESH_ACCESS, null)} />);

    expect(lastComposer()).toMatchObject({
      sendDisabled: true,
      hasWorkspaceControls: true,
    });
    expect(lastComposer()?.hint).not.toBeNull();
  });

  it.each([false, true])(
    "keeps a resting copy's send enabled without live workspace controls (viewer: %s)",
    (isViewer) => {
      render(
        <ChatLowerInteractionSurfaces
          {...props(
            {
              isViewer,
              isCopy: true,
              canAct: false,
              readOnlyNotice: null,
              restingSandbox: true,
            },
            null,
          )}
        />,
      );

      expect(screen.getByTestId("composer-stub")).toBeTruthy();
      expect(lastComposer()).toMatchObject({
        sendDisabled: false,
        hint: null,
        hasWorkspaceControls: false,
      });
    },
  );

  it("keeps a viewer's read-only surface, with no composer, when the sandbox is not resting", () => {
    render(
      <ChatLowerInteractionSurfaces
        {...props(
          {
            isViewer: true,
            isCopy: false,
            canAct: false,
            readOnlyNotice: null,
          },
          null,
        )}
      />,
    );

    expect(screen.queryByTestId("composer-stub")).toBeNull();
    expect(composerProps).toEqual([]);
  });

  it("keeps a queue edit that was already open blocked on a resting sandbox, so Save cannot send a duplicate, while Cancel edit stays", () => {
    const editing: OpenChatQueuedPromptItem = {
      kind: "prompt",
      queueItemId: "queue-edit-1",
      messageId: "queue-edit-1-message",
      message: {
        kind: "user",
        content: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "queued" }] },
          ],
        },
        browserAnnotations: [],
      },
      sender: { type: "user", userId: "owner-1" },
      settings: PICKED_SETTINGS,
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
    render(
      <ChatLowerInteractionSurfaces
        {...props(
          { ...FRESH_ACCESS, isCopy: true, restingSandbox: true },
          editing,
        )}
      />,
    );

    expect(lastComposer()).toMatchObject({
      editingQueueItemId: "queue-edit-1",
      sendDisabled: true,
      canCancelEdit: true,
      hasWorkspaceControls: false,
    });
    expect(lastComposer()?.hint).not.toBeNull();
  });
});
