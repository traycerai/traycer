import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { ChatQueuedItem } from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * Wave-3 fixup regression (review w3):
 *
 * - Should-fix 5 ("compact dock chips ignore dockOrder"): the compact chip
 *   row used to build chips in a fixed Files -> Agents -> Background order and
 *   only the EXPANDED dock read `composer.dockOrder`. Reordering rows then
 *   folding them changed the order back. `chips` in `useChatDockChrome` is now
 *   sorted through the same `composer.dockOrder`.
 *
 * - Blocking 8 ("a temporarily expanded compact section attaches one callback
 *   ref to two nodes"): the chip and the revealed row shared ONE ref
 *   callback (`xHotspot.ref`) across two different DOM nodes at once, so
 *   whichever attached last silently won the Customize registration, and
 *   detaching the row could clear it while the chip stayed on screen. Fixed
 *   state (re-verified against the current worktree, since an earlier pass
 *   here briefly nulled both sides mid-edit): the ROW's `hotspots[section]`
 *   record always carries the real ref (it only renders at all once its
 *   section is out of `folded`, i.e. once revealed), and the CHIP's own
 *   model nulls its ref while `revealed.has(section)`. So exactly one side
 *   ever holds the callback - the chip while folded, the row once revealed -
 *   never both.
 *
 * This reuses the real-mount harness from `chat-dock-customize.test.tsx`
 * (Customize session + real `ChatLowerInteractionSurfaces`) merged with
 * `chat-tile-lower-surfaces-dock-chrome.test.tsx`'s reveal-on-click pattern,
 * so both fixes are exercised through the actual compact strip, not a
 * fabricated chip model.
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
import { ChatDockCompactStrip } from "@/components/chat/chat-dock-compact-strip";
import { NO_PROVIDER_FALLBACK } from "@/components/chat/fallback/fallback-state";
import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  ChatLowerInteractionSurfaces,
  type ChatLowerInteractionSurfacesProps,
} from "@/components/epic-canvas/renderers/chat-tile-lower-surfaces";
import {
  DEFAULT_COMPOSER_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";
import { useCustomizeStore } from "@/stores/customize/customize-store";

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
      nodeId: CHAT_ID,
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

describe("compact dock chip order follows composer.dockOrder (S5)", () => {
  it("renders the chips in dockOrder, not the fixed Files -> Agents -> Background order", () => {
    useLayoutStore.setState({
      composer: {
        ...DEFAULT_COMPOSER_LAYOUT,
        filesChanged: "compact",
        activeAgents: "compact",
        background: "compact",
        // Deliberately NOT the fixed default order.
        dockOrder: ["background", "activeAgents", "filesChanged"],
      },
    });

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

    const chips = [
      ...document.querySelectorAll("[data-testid^='chat-dock-chip-']"),
    ].map((el) => el.getAttribute("data-testid"));
    expect(chips).toEqual([
      "chat-dock-chip-background",
      "chat-dock-chip-activeAgents",
      "chat-dock-chip-filesChanged",
    ]);
  });

  it("reordering through Move and then folding keeps the new order on the chips", () => {
    useLayoutStore.setState({
      composer: {
        ...DEFAULT_COMPOSER_LAYOUT,
        filesChanged: "compact",
        activeAgents: "compact",
        background: "compact",
      },
    });
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
      useLayoutStore.setState((state) => ({
        composer: {
          ...state.composer,
          dockOrder: ["background", "filesChanged", "activeAgents"],
        },
      }));
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

describe("temporarily revealing a compact row hands off ownership instead of duplicating it (S8)", () => {
  it("the chip owns the Customize registration while folded, the ROW takes sole ownership once revealed, and the chip reclaims it on re-fold", () => {
    useLayoutStore.setState({
      composer: {
        ...DEFAULT_COMPOSER_LAYOUT,
        filesChanged: "compact",
        activeAgents: "compact",
        background: "compact",
      },
    });
    renderSurfaces(
      surfacesProps({
        queueItems: [],
        accumulatedFileChanges: [fileChangeRow("/repo/src/a.ts")],
      }),
    );

    const registeredNode = () =>
      [...useCustomizeStore.getState().instances.entries()].find(([key]) =>
        key.startsWith("composer.filesChanged@"),
      )?.[1].node;

    // Folded: the chip is the sole registered anchor - the row is not even
    // rendered yet, so there is nothing for it to compete with. The
    // registered node is the WRAPPER span the ref is attached to
    // (`chat-dock-compact-strip.tsx`'s `ref={chip.hotspotRef}`), and the
    // chip's own testid element is a child inside it - so the containment
    // check goes wrapper-contains-chip, not the other way round.
    const chip = screen.getByTestId("chat-dock-chip-filesChanged");
    const foldedNode = registeredNode();
    expect(foldedNode).toBeDefined();
    expect(foldedNode && foldedNode.contains(chip)).toBe(true);

    // Reveal the row (the same click a user makes to see it again). Both the
    // chip and the row are now on screen at once - exactly the overlap the
    // old bug mishandled by sharing one ref callback between them.
    fireEvent.click(chip);
    const panel = screen.getByTestId("accumulated-changes-panel");
    expect(panel).not.toBeNull();

    // Ownership has moved to the ROW, and only the row - not left on the
    // chip, and not on both at once (which is what let "whichever attaches
    // last wins" silently pick either one). Same wrapper-contains-child
    // direction: the row's registered node is the wrapping span around
    // `ChatAccumulatedChangesPanel` (`chat-lower-dock.tsx`'s
    // `ref={props.hotspotRef}`), which contains the panel.
    const revealedNode = registeredNode();
    expect(revealedNode).toBeDefined();
    expect(revealedNode && revealedNode.contains(panel)).toBe(true);
    expect(revealedNode && chip.contains(revealedNode)).toBe(false);

    // Folding it back (second click) must hand ownership back to the chip,
    // not leave the setting registered against a node that is about to
    // unmount - the observable half of "detaching the row can clear
    // registration while the chip remains".
    fireEvent.click(chip);
    expect(screen.queryByTestId("accumulated-changes-panel")).toBeNull();
    const refoldedNode = registeredNode();
    expect(refoldedNode).toBeDefined();
    expect(refoldedNode && refoldedNode.contains(chip)).toBe(true);
  });
});
