import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { ChatQueuedItem } from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * Ticket w3-chat-surfaces: the three reorderable dock rows as Customize
 * hotspots. `chat-tile-lower-surfaces-dock-chrome.test.tsx` already renders
 * this same surface for the compact-chip half of `useChatDockChrome`; this
 * suite renders it for the OTHER half - ghosting, reordering, and undo - and
 * covers the option-spec factories (`composer-dock-options.ts`) directly.
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

vi.mock("@/hooks/agent/use-agent-stop-controls", () => ({
  useAgentStopControls: () => ({ self: null, descendants: [] }),
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
import { ChatDockCompactStrip } from "@/components/chat/chat-dock-compact-strip";
import { NO_PROVIDER_FALLBACK } from "@/components/chat/fallback/fallback-state";
import {
  ChatLowerInteractionSurfaces,
  type ChatLowerInteractionSurfacesProps,
} from "@/components/epic-canvas/renderers/chat-tile-lower-surfaces";
import {
  DEFAULT_COMPOSER_LAYOUT,
  useLayoutStore,
  type DockSection,
} from "@/stores/settings/layout-store";
import {
  getCustomizeOptions,
  type CustomizeMove,
} from "@/lib/customize/customize-options";
import { registerComposerDockCustomizeOptions } from "@/lib/customize/options/composer-dock-options";
import { undo } from "@/lib/customize/history";
import {
  selectedInstances,
  useCustomizeStore,
  type HotspotInstance,
} from "@/stores/customize/customize-store";

registerComposerDockCustomizeOptions();

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

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

let epicHandle: OpenedStoreForTest;

function startCustomizeSession(): void {
  useCustomizeStore.setState({
    session: { scene: "in-place", opener: { kind: "none" }, startedAt: 0 },
    instances: new Map(),
    activeKey: null,
    popoverKey: null,
    invoker: null,
    disclosure: null,
    pendingTarget: null,
    preferredTileId: null,
    history: { past: [], future: [] },
  });
}

function surfacesProps(patch: {
  readonly chatId: string;
  readonly queueItems: ReadonlyArray<ChatQueuedItem>;
}): ChatLowerInteractionSurfacesProps {
  return {
    epicId: EPIC_ID,
    viewTabId: TAB_ID,
    chatId: patch.chatId,
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
      nodeId: patch.chatId,
      isActive: true,
      mentionRoots: [],
      fallbackToGlobalMentionRoots: true,
      currentEpicId: EPIC_ID,
      onSubmitMessage: () => false,
      onSideChat: () => false,
      onSettingsChange: null,
      workspaceControls: <ChatDockCompactStrip />,
      workspaceAvailability: WORKSPACE_COMPOSER_READY,
    },
    todo: null,
    restoreContext: EMPTY_RESTORE,
    backgroundItems: [],
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
  useLayoutStore.setState({ composer: DEFAULT_COMPOSER_LAYOUT });
  startCustomizeSession();
});

afterEach(() => {
  cleanup();
  disposeManagedCommandChatSessions();
  epicHandle.dispose();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLayoutStore.setState({ composer: DEFAULT_COMPOSER_LAYOUT });
  act(() => {
    useCustomizeStore.setState({ session: null });
  });
});

describe("chat dock ghost rows", () => {
  it("draws three ghost rows with their truthful conditions when the chat is empty", () => {
    renderSurfaces(surfacesProps({ chatId: CHAT_ID, queueItems: [] }));

    const ghosts = screen.getAllByTestId("chat-dock-ghost-row");
    expect(ghosts).toHaveLength(3);
    expect(ghosts.map((node) => node.textContent)).toEqual([
      "nothing changed in this chat",
      "no agents running",
      "nothing in the background",
    ]);
  });

  it("registers each empty row under this chat's tile id", () => {
    renderSurfaces(surfacesProps({ chatId: CHAT_ID, queueItems: [] }));

    const instances = [...useCustomizeStore.getState().instances.values()];
    for (const settingId of [
      "composer.filesChanged",
      "composer.activeAgents",
      "composer.background",
    ] as const) {
      const instance = instances.find((i) => i.settingId === settingId);
      expect(instance?.tileId).toBe(CHAT_ID);
      expect(instance?.ghost).toBe(true);
    }
  });
});

describe("composer.background option", () => {
  function dockInstance(section: DockSection): HotspotInstance {
    return {
      key: `composer.${section}@shell:${CHAT_ID}`,
      settingId: `composer.${section}`,
      sceneId: "shell",
      tileId: CHAT_ID,
      node: document.createElement("div"),
      ghost: false,
      condition: null,
    };
  }

  it("setting it to Compact writes the layout store, and Undo restores it", () => {
    const options = getCustomizeOptions(dockInstance("background"));
    act(() => {
      if (options?.control?.kind === "choice")
        options.control.change("compact");
    });
    expect(useLayoutStore.getState().composer.background).toBe("compact");

    act(() => undo());
    expect(useLayoutStore.getState().composer.background).toBe("visible");
  });

  it("dragging Background above Files changed persists the new dockOrder", () => {
    const dragging = getCustomizeOptions(dockInstance("background"));
    const move = dragging?.drag?.resolveDrop(
      "composer.filesChanged@shell:chat-1",
    );
    expect(move).not.toBeNull();
    act(() => {
      if (move !== null && move !== undefined) (move as CustomizeMove).run();
    });
    expect(useLayoutStore.getState().composer.dockOrder).toEqual([
      "background",
      "filesChanged",
      "activeAgents",
    ]);
  });

  it("Move up on the middle row swaps it with the row above", () => {
    const options = getCustomizeOptions(dockInstance("activeAgents"));
    const moveUp = options?.moves.find((move) => move.id === "move-up");
    expect(moveUp?.disabled).toBe(false);
    act(() => moveUp?.run());
    expect(useLayoutStore.getState().composer.dockOrder).toEqual([
      "activeAgents",
      "filesChanged",
      "background",
    ]);
  });
});

describe("preferred-tile selection across two chat tiles", () => {
  it("keeps only the focused tile's instance selected for a shared settingId", () => {
    const instances = new Map<string, HotspotInstance>();
    const tileA: HotspotInstance = {
      key: "composer.filesChanged@shell:chat-a",
      settingId: "composer.filesChanged",
      sceneId: "shell",
      tileId: "chat-a",
      node: document.createElement("div"),
      ghost: false,
      condition: null,
    };
    const tileB: HotspotInstance = {
      ...tileA,
      key: "composer.filesChanged@shell:chat-b",
      tileId: "chat-b",
    };
    instances.set(tileA.key, tileA);
    instances.set(tileB.key, tileB);

    const preferringA = selectedInstances({
      instances,
      preferredTileId: "chat-a",
    });
    expect(preferringA).toHaveLength(1);
    expect(preferringA[0]?.tileId).toBe("chat-a");

    const preferringB = selectedInstances({
      instances,
      preferredTileId: "chat-b",
    });
    expect(preferringB).toHaveLength(1);
    expect(preferringB[0]?.tileId).toBe("chat-b");
  });
});
