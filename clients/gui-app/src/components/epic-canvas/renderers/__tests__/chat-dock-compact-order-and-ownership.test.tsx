import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { ChatQueuedItem } from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * Wave-3 fixup regression (review w3):
 *
 * - Should-fix 5 ("compact dock chips ignore dockOrder"): the compact chip
 *   row used to build chips in a fixed Files -> Agents -> Background order and
 *   only the EXPANDED dock read the dock's order. Reordering rows then
 *   folding them changed the order back. `chips` in `useChatDockChrome` is now
 *   sorted through the same `arrangement.dock` (`useArrangementValue("dock")`).
 *
 * Blocking 8 of that same review - "a temporarily expanded compact section
 * attaches one callback ref to two nodes" - was the other half of this file.
 * It went with its subject: a real chat tile registers no Customize region at
 * all now (L-87), because the editor's canvas is always the sample workspace
 * and no epic surface is ever presented beside it. There is one hotspot ref
 * on the dock and the sample workspace owns it, so there is no hand-off left
 * to get wrong. The order fix below is unaffected and mounts the real surface
 * exactly as before.
 */

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
  useStreamMethodSupport: () => "supported",
  useStreamMethodSchemaVersion: () => null,
}));

vi.mock(
  "@/hooks/managed-command/use-managed-command-lifecycle-mutations",
  () => ({
    useManagedCommandStart: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStop: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStopAll: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandDelete: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandConfigureIsPending: () => false,
    useManagedCommandRelaunchOnHostRestart: (
      _target: unknown,
      streamed: { relaunchOnHostRestart: boolean },
    ) => streamed.relaunchOnHostRestart,
    useManagedCommandConfigure: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStopAllIsPending: () => false,
    useManagedCommandDeliverHeld: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandDeliverHeldIsPending: () => false,
  }),
);

vi.mock("@/components/chat/chat-stop-children-dialog", () => ({
  StopChildrenDialog: () => null,
}));

vi.mock("@/hooks/agent/use-stop-agent-mutation", () => ({
  useAgentStop: () => ({ mutate: () => undefined }),
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

// `activeAgentsVisible` (and so `agentsChip`) needs more than a lone
// mid-turn self - `chat-tile-lower-surfaces-dock-chrome.test.tsx` always
// pairs `self` with at least one descendant to light it. A self-only agent
// row does not satisfy it.
vi.mock("@/hooks/agent/use-agent-stop-controls", () => ({
  useAgentStopControls: () => ({
    self: {
      id: "chat-1",
      title: "This chat",
      surface: "gui",
      activity: "turn",
      hostId: "host-1",
    },
    descendants: [
      {
        id: "child-1",
        title: "Child one",
        surface: "gui",
        activity: "turn",
        hostId: "host-1",
      },
    ],
  }),
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: (props: { readonly children: ReactNode }) => (
    <div data-testid="queued-message-dnd-provider">{props.children}</div>
  ),
  KeyboardSensor: class {},
  PointerSensor: class {},
  closestCenter: () => [],
  useSensor: () => null,
  useSensors: () => [],
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: (props: { readonly children: ReactNode }) => (
    <div data-testid="queued-message-sortable-context">{props.children}</div>
  ),
  sortableKeyboardCoordinates: () => null,
  verticalListSortingStrategy: () => [],
  useSortable: () => ({
    setNodeRef: () => null,
    setActivatorNodeRef: () => null,
    attributes: {},
    listeners: {},
    transform: null,
    transition: undefined,
    isDragging: false,
    isOver: false,
  }),
}));

vi.mock("@/components/chat/composer/chat-composer", () => ({
  ChatComposer: (props: { readonly workspaceControls: ReactNode }) => (
    <div data-testid="composer-stub">{props.workspaceControls}</div>
  ),
}));

import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import {
  disposeManagedCommandChatSessions,
  installManagedCommandChatSession,
} from "@/stores/managed-commands/test-support/managed-command-chat-session";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WORKSPACE_COMPOSER_READY } from "@/lib/composer/workspace-composer-availability";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import type { AccumulatedChangeRow } from "@/lib/chat/accumulated-change-rows";
import { NO_PROVIDER_FALLBACK } from "@/components/chat/fallback/fallback-state";
import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  ChatLowerInteractionSurfaces,
  type ChatLowerInteractionSurfacesProps,
} from "@/components/epic-canvas/renderers/chat-tile-lower-surfaces";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";

const EPIC_ID = "epic-1";
const TAB_ID = "tab-1";
const CHAT_ID = "chat-1";
const HOST_ID = "host-1";

const EMPTY_RESTORE: ChatRestoreContextValue = {
  accessRole: "owner",
  currentUserId: "user-1",
  activeHostId: HOST_ID,
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

function fileChangeRow(filePath: string): AccumulatedChangeRow {
  return {
    filePath,
    operation: "edit",
    diffSource: "snapshot",
    reason: "snapshot",
    undoable: true,
    artifact: null,
    counts: { additions: 1, deletions: 0 },
    hasContents: true,
    digest: null,
    liveDiff: null,
  };
}

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

let epicHandle: OpenedStoreForTest;

function startEditorSession(): void {
  useLayoutEditorStore.getState().beginSession({
    entry: "pointer",
    source: "direct_ui",
    startedAt: 0,
    origin: { kind: "tab" },
  });
}

function surfacesProps(patch: {
  readonly queueItems: ReadonlyArray<ChatQueuedItem>;
  readonly accumulatedFileChanges: ReadonlyArray<AccumulatedChangeRow>;
  readonly backgroundItems?: ReadonlyArray<BackgroundItem>;
}): ChatLowerInteractionSurfacesProps {
  return {
    epicId: EPIC_ID,
    viewTabId: TAB_ID,
    chatId: CHAT_ID,
    hostId: HOST_ID,
    runtime: { snapshotLoaded: true },
    access: { isViewer: false, canAct: true, readOnlyNotice: null },
    turn: {
      activeTurnStatus: null,
      steerCapable: false,
      steerProtocolSupported: true,
      autoPermissionModeProtocolSupported: null,
      getDraftBlobBridgeSupported: () => false,
      getActiveTurnForSteer: () => null,
      getStopConfirmationTarget: () => ({
        turnId: null,
        revision: 0,
        connectionEpoch: 0,
      }),
      stopDisabled: true,
      onStopTurn: () => null,
    },
    interview: {
      pending: null,
      isBusy: false,
      unanswerable: [],
      unanswerableBusy: false,
      onAnswer: () => null,
      onSkip: () => null,
      onFork: null,
      highlightedBlockId: null,
    },
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
      value: { status: "idle", items: [...patch.queueItems] },
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
      nodeId: CHAT_ID,
      isActive: true,
      mentionRoots: [],
      fallbackToGlobalMentionRoots: true,
      currentEpicId: EPIC_ID,
      onSubmitMessage: () => false,
      onSideChat: () => false,
      onSettingsChange: null,
      // The chips left the workspace row (A12, L-97): `ChatLowerDock`
      // renders the strip itself, above the composer.
      workspaceControls: <div data-testid="workspace-controls-stub" />,
      workspaceAvailability: WORKSPACE_COMPOSER_READY,
    },
    todo: null,
    restoreContext: {
      ...EMPTY_RESTORE,
      accumulatedFileChanges: patch.accumulatedFileChanges,
    },
    backgroundItems: patch.backgroundItems ?? [],
    providerFallback: NO_PROVIDER_FALLBACK,
    backgroundStopPendingTaskIds: new Set(),
    backgroundStopAllPending: false,
    backgroundSessionStopPending: false,
    onBackgroundItemClick: () => undefined,
  };
}

function tile(props: ChatLowerInteractionSurfacesProps): ReactElement {
  return (
    <EpicSessionContext.Provider value={epicHandle}>
      <TabHostProvider hostId={HOST_ID}>
        <TooltipProvider>
          <ChatLowerInteractionSurfaces {...props} />
        </TooltipProvider>
      </TabHostProvider>
    </EpicSessionContext.Provider>
  );
}

function renderSurfaces(props: ChatLowerInteractionSurfacesProps) {
  return render(tile(props));
}

beforeEach(() => {
  installManagedCommandChatSession({
    hostId: HOST_ID,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
  });
  epicHandle = openStoreForTest({
    epicId: EPIC_ID,
    userId: null,
    factories: {
      streamClientFactory: noopStreamClientFactory,
      laneSelection: null,
    },
    writeCommand: null,
  });
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useEpicCanvasStore.setState({
    tabsById: { [TAB_ID]: { tabId: TAB_ID, epicId: EPIC_ID, name: "Epic 1" } },
    openTabOrder: [TAB_ID],
    activeTabId: TAB_ID,
  });
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  useLayoutEditorStore.getState().endSession();
  useLayoutEditorStore.setState({ instances: new Map() });
  act(startEditorSession);
});

afterEach(() => {
  cleanup();
  disposeManagedCommandChatSessions();
  epicHandle.dispose();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  act(() => {
    useLayoutEditorStore.getState().endSession();
  });
});

/** Every dock region folded to its compact pill - Todo included since it
 *  became a member too (L-139). The message queue is not a region (G1-G2). */
function foldAllDockRegionsToChips(): void {
  useLayoutStore.getState().setRegionValues("changedFiles", { size: "chip" });
  useLayoutStore.getState().setRegionValues("runningAgents", { size: "chip" });
  useLayoutStore.getState().setRegionValues("background", { size: "chip" });
  useLayoutStore.getState().setRegionValues("todo", { size: "chip" });
}

describe("compact dock chip order follows arrangement.dock (S5)", () => {
  it("reordering through Move and then folding keeps the new order on the chips", () => {
    foldAllDockRegionsToChips();
    renderSurfaces(
      surfacesProps({
        queueItems: [],
        accumulatedFileChanges: [fileChangeRow("/repo/src/a.ts")],
        backgroundItems: [
          {
            taskId: "task-1",
            kind: "command",
            title: "bun test",
            blockId: "task-1-block",
            parentTaskId: null,
            scheduledFor: null,
            individualStopUnavailable: null,
          },
        ],
      }),
    );
    // Default order first.
    expect(
      [...document.querySelectorAll("[data-testid^='chat-dock-chip-']")].map(
        (el) => el.getAttribute("data-testid"),
      ),
    ).toEqual([
      "chat-dock-chip-filesChanged",
      "chat-dock-chip-activeAgents",
      "chat-dock-chip-background",
    ]);

    // Real store write, same as a Move/drag would perform.
    act(() => {
      const { arrangement } = useLayoutStore.getState();
      useLayoutStore.getState().setArrangement({
        ...arrangement,
        dock: ["background", "changedFiles", "runningAgents", "todo"],
      });
    });

    expect(
      [...document.querySelectorAll("[data-testid^='chat-dock-chip-']")].map(
        (el) => el.getAttribute("data-testid"),
      ),
    ).toEqual([
      "chat-dock-chip-background",
      "chat-dock-chip-filesChanged",
      "chat-dock-chip-activeAgents",
    ]);
  });
});
