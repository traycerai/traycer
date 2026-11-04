/**
 * A chat the pool serves because its host dropped the records takes a typed
 * message (parked until the host brings the chat back), whoever the viewer is.
 * The line above the composer holds or leaves the send by what it says.
 */
import {
  cleanup,
  render as testingRender,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { domAnimation, LazyMotion } from "motion/react";
import type { ReactElement, ReactNode } from "react";

const composerProps = vi.hoisted(
  () => [] as Array<{ sendDisabled: boolean | undefined }>,
);
vi.mock("@/components/chat/composer/chat-composer", () => ({
  ChatComposer: (props: {
    readonly sendDisabled: boolean | undefined;
    readonly topSlot: ReactNode;
  }) => {
    composerProps.push({ sendDisabled: props.sendDisabled });
    return <div data-testid="composer-stub">{props.topSlot}</div>;
  },
}));
vi.mock("@/components/chat/composer/team-epic-personal-line", () => ({
  TeamEpicPersonalLine: () => null,
}));
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: () => undefined }),
}));
vi.mock("@/lib/epic-selectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/epic-selectors")>()),
  useEpicLiveArtifactTitle: () => null,
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
import {
  EVICTED_CHAT_HEAD_MOVED_LINE,
  EVICTED_CHAT_HYDRATING_LINE,
  EVICTED_CHAT_UNREACHABLE_LINE,
} from "@/components/chat/composer/evicted-chat-line";
import type { EvictedChatLineKind } from "@/hooks/chats/use-evicted-chat-send";

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
      ultracodeProtocolSupported: false,
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

const VIEWER_CANNOT_ACT = {
  isViewer: true,
  isCopy: false,
  canAct: false,
  readOnlyNotice: null,
} as const;

function evictedAccess(line: EvictedChatLineKind | null) {
  return {
    ...VIEWER_CANNOT_ACT,
    evictedChat: { parks: true, line, ownerUserId: "owner-1" },
  };
}

afterEach(() => {
  cleanup();
  composerProps.length = 0;
});

describe("the composer of an evicted chat the pool serves", () => {
  it("renders the live composer with send enabled for a viewer who cannot act", () => {
    render(<ChatLowerInteractionSurfaces {...props(evictedAccess(null))} />);

    expect(screen.getByTestId("composer-stub")).toBeTruthy();
    expect(composerProps.at(-1)).toEqual({ sendDisabled: false });
  });

  it.each([
    ["hydrating", EVICTED_CHAT_HYDRATING_LINE],
    ["unreachable", EVICTED_CHAT_UNREACHABLE_LINE],
  ] as const)("holds send and shows the %s line", (line, text) => {
    render(<ChatLowerInteractionSurfaces {...props(evictedAccess(line))} />);

    expect(screen.getByText(text)).toBeTruthy();
    expect(composerProps.at(-1)).toEqual({ sendDisabled: true });
  });

  it("shows the head-moved line and leaves send enabled", () => {
    render(
      <ChatLowerInteractionSurfaces {...props(evictedAccess("head-moved"))} />,
    );

    expect(screen.getByText(EVICTED_CHAT_HEAD_MOVED_LINE)).toBeTruthy();
    expect(composerProps.at(-1)).toEqual({ sendDisabled: false });
  });

  it("keeps a viewer's read-only surface when no message is parked", () => {
    render(
      <ChatLowerInteractionSurfaces
        {...props({
          ...VIEWER_CANNOT_ACT,
          evictedChat: { parks: false, line: null, ownerUserId: "owner-1" },
        })}
      />,
    );

    expect(screen.queryByTestId("composer-stub")).toBeNull();
  });
});
