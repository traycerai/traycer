import {
  act,
  cleanup,
  fireEvent,
  render as testingRender,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { domAnimation, LazyMotion } from "motion/react";
import type { ReactElement, ReactNode } from "react";
import type {
  ChatRunSettings,
  OpenChatQueuedPromptItem,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import {
  newConversationSurfaceKey,
  useSurfaceHostSelectionStore,
} from "@/stores/host/surface-host-selection-store";

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
vi.mock("@/components/composer/pool-composer-actions", () => ({
  PoolComposerActions: ({
    place,
  }: {
    readonly place: (hostId: string) => void;
  }) => (
    <button type="button" onClick={() => place("team-sandbox")}>
      Use team sandbox
    </button>
  ),
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
const EDIT_SETTINGS: ChatRunSettings = {
  ultracode: false,
  harnessId: "claude",
  model: "claude-sonnet",
  permissionMode: "supervised",
  reasoningEffort: "medium",
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};
const EDITING_ITEM: OpenChatQueuedPromptItem = {
  kind: "prompt",
  queueItemId: "queue-editing",
  messageId: "message-editing",
  message: {
    kind: "user",
    content: { type: "doc", content: [] },
    browserAnnotations: [],
  },
  sender: { type: "user", userId: "owner-1" },
  settings: EDIT_SETTINGS,
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
  const interview = interviewState();
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
      // Unused by this suite - it covers the send gate, not Stop.
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
      runWorkingDirectory: null,
      fallbackToGlobalMentionRoots: true,
      currentEpicId: "epic-1",
      onSubmitMessage: () => false,
      onSideChat: () => false,
      onSettingsChange: null,
      workspaceControls: <div data-testid="host-workspace-selector" />,
      workspaceAvailability: WORKSPACE_COMPOSER_READY,
      onClone: () => undefined,
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

function interviewState(): ChatLowerInterviewState {
  return {
    pending: null,
    isBusy: false,
    unanswerable: [],
    unanswerableBusy: false,
    onAnswer: () => null,
    onSkip: () => null,
    onFork: null,
    highlightedBlockId: null,
  };
}

const VIEWER_CANNOT_ACT = {
  isViewer: true,
  isCopy: false,
  canAct: false,
  readOnlyNotice: null,
} as const;

function evictedAccess(parksEvictedSend: boolean) {
  return { ...VIEWER_CANNOT_ACT, parksEvictedSend };
}

afterEach(() => {
  cleanup();
  composerProps.length = 0;
  useSelectionAuthorityStore.getState().reset();
  useSurfaceHostSelectionStore.getState().resetForTests();
  useComposerDraftStore.setState({
    drafts: useComposerDraftStore.getInitialState().drafts,
  });
});

describe("the composer of an evicted chat the pool serves", () => {
  it("keeps the offline chat and its draft while its next chat is placed on a team sandbox", () => {
    useSelectionAuthorityStore.setState({ servingPeer: { kind: "pool" } });
    const base = props({ ...VIEWER_CANNOT_ACT, isCopy: true });
    const draftStore = useComposerDraftStore.getState();
    draftStore.setSnapshot(
      base.chatId,
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "saved draft" }],
          },
        ],
      },
      null,
    );
    const previousDraft = useComposerDraftStore.getState().drafts[base.chatId];
    render(<ChatLowerInteractionSurfaces {...base} />);

    fireEvent.click(screen.getByRole("button", { name: "Use team sandbox" }));
    expect(
      useSurfaceHostSelectionStore.getState().selections[
        newConversationSurfaceKey(base.epicId)
      ],
    ).toBe("team-sandbox");
    expect(screen.getByRole("button", { name: "Clone agent" })).toBeTruthy();
    expect(screen.queryByTestId("composer-stub")).toBeNull();
    expect(useComposerDraftStore.getState().drafts[base.chatId]).toBe(
      previousDraft,
    );

    act(() =>
      useSelectionAuthorityStore.setState({
        servingPeer: { kind: "computer", hostId: "working-computer" },
      }),
    );
    expect(
      screen.queryByRole("button", { name: "Use team sandbox" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Clone agent" })).toBeTruthy();
    expect(useComposerDraftStore.getState().drafts[base.chatId]).toBe(
      previousDraft,
    );
  });

  it("keeps a parked chat read-only for a viewer and offers Clone agent", () => {
    const onClone = vi.fn();
    const interactionProps = props(evictedAccess(true));
    render(
      <ChatLowerInteractionSurfaces
        {...interactionProps}
        composer={{ ...interactionProps.composer, onClone }}
      />,
    );

    expect(screen.queryByTestId("composer-stub")).toBeNull();
    expect(composerProps).toEqual([]);
    expect(screen.getByText("Read-only viewer.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clone agent" }));
    expect(onClone).toHaveBeenCalledTimes(1);
  });

  it("keeps send enabled while a message is parked and the session cannot act", () => {
    render(
      <ChatLowerInteractionSurfaces
        {...props({
          isViewer: false,
          isCopy: false,
          canAct: false,
          readOnlyNotice: null,
          parksEvictedSend: true,
        })}
      />,
    );

    expect(composerProps.at(-1)).toEqual({ sendDisabled: false });
  });

  it("disables send while editing a queued item, even when a send is parked", () => {
    const base = props({
      isViewer: false,
      isCopy: false,
      canAct: false,
      readOnlyNotice: null,
      parksEvictedSend: true,
    });
    render(
      <ChatLowerInteractionSurfaces
        {...base}
        queue={{ ...base.queue, editingItem: EDITING_ITEM }}
      />,
    );

    expect(composerProps.at(-1)).toEqual({ sendDisabled: true });
  });

  it("keeps a viewer's read-only surface when no message is parked", () => {
    render(<ChatLowerInteractionSurfaces {...props(evictedAccess(false))} />);

    expect(screen.queryByTestId("composer-stub")).toBeNull();
    expect(screen.getByText("Read-only viewer.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clone agent" })).toBeTruthy();
  });
});
