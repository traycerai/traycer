import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  BackgroundItem,
  ChatQueuedItem,
  ChatQueuedPromptItem,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * `useChatDockChrome` (`chat-tile-lower-surfaces.tsx`) is the piece deciding
 * which dock rows fold into a compact chip, what those chips print, and how a
 * click gets a row back - and it carries the most logic in the file, with no
 * suite that actually renders it. `chat-lower-background-spacing.test.tsx`
 * mounts the same surface but stubs `ChatComposer` in a way that drops
 * `workspaceControls` entirely, so the strip the chips live in never renders
 * there. This suite renders it for real.
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

// Controlled per test via `setAgentStopControls` - see below. Declared here
// (rather than read fresh inside the factory) so a test can change it and
// have the very next render see the new value without re-mocking.
let agentStopControlsMock: AgentStopControls = {
  self: null,
  descendants: [],
};

vi.mock("@/hooks/agent/use-agent-stop-controls", () => ({
  useAgentStopControls: () => agentStopControlsMock,
}));

// The queue panel renders its rows through `@dnd-kit`'s sortable context.
// Faked the same way `chat-lower-dock.test.tsx` fakes it: the queue's own
// drag/reorder mechanics are not this suite's concern, only whether a
// received-agent row is folded into the chip or rendered at all.
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

// The one deliberate departure from `chat-lower-background-spacing.test.tsx`'s
// stub: that suite discards `workspaceControls`, which is exactly where
// `<ChatDockCompactStrip />` lives. This renders it, the way `chat-tile.tsx`
// composes the real composer.
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
import type {
  AgentRow,
  AgentStopControls,
} from "@/hooks/agent/use-agent-stop-controls";
import {
  DEFAULT_COMPOSER_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";
import { ChatDockCompactStrip } from "@/components/chat/chat-dock-compact-strip";
import {
  ChatLowerInteractionSurfaces,
  type ChatLowerInteractionSurfacesProps,
} from "@/components/epic-canvas/renderers/chat-tile-lower-surfaces";

const EPIC_ID = "epic-1";
const TAB_ID = "tab-1";
const CHAT_ID = "chat-1";
const HOST_ID = "host-1";

// U+2212 MINUS SIGN, not a hyphen - `changeCountsShortForm` prints deletions
// with it, and a plain "-" would silently pass a test that checked the wrong
// character.
const MINUS = "−";

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "codex-test",
  permissionMode: "supervised",
  reasoningEffort: "medium",
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

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

function setAgentStopControls(controls: AgentStopControls): void {
  agentStopControlsMock = controls;
}

function agentRow(
  id: string,
  title: string,
  activity: AgentRow["activity"],
): AgentRow {
  return { id, title, surface: "gui", activity, hostId: HOST_ID };
}

function fileChangeRow(
  filePath: string,
  additions: number,
  deletions: number,
): AccumulatedChangeRow {
  return {
    filePath,
    operation: "edit",
    diffSource: "snapshot",
    reason: "snapshot",
    undoable: true,
    artifact: null,
    counts: { additions, deletions },
    hasContents: true,
    digest: null,
    liveDiff: null,
  };
}

function backgroundCommandItem(taskId: string, title: string): BackgroundItem {
  return {
    taskId,
    kind: "command",
    title,
    blockId: `${taskId}-block`,
    parentTaskId: null,
    scheduledFor: null,
    individualStopUnavailable: null,
  };
}

function content(text: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

function queuedItem(queueItemId: string, text: string): ChatQueuedPromptItem {
  return {
    kind: "prompt",
    queueItemId,
    messageId: `${queueItemId}-message`,
    message: {
      kind: "user",
      content: content(text),
      browserAnnotations: [],
    },
    sender: { type: "user", userId: "user-1" },
    settings: SETTINGS,
    accountContext: { type: "PERSONAL" as const },
    delivery: "next_turn",
    status: "pending",
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function receivedAgentQueueItem(
  queueItemId: string,
  text: string,
): ChatQueuedPromptItem {
  return {
    ...queuedItem(queueItemId, text),
    sender: {
      type: "agent",
      harnessId: "codex",
      agentId: "sender-agent-1",
      displayName: "Sender agent",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
  };
}

function surfacesProps(patch: {
  readonly restoreContext: ChatRestoreContextValue;
  readonly queueItems: ReadonlyArray<ChatQueuedItem>;
  readonly backgroundItems: ReadonlyArray<BackgroundItem>;
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
    },
    approvals: {
      pendingFileEditApprovals: [],
      pendingApprovals: [],
      onFileEditDecision: () => undefined,
      onApprovalDecision: () => undefined,
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
      // The one required departure from the background-spacing harness: this
      // must actually contain the strip, not `null`.
      workspaceControls: <ChatDockCompactStrip />,
      workspaceAvailability: WORKSPACE_COMPOSER_READY,
    },
    todo: null,
    restoreContext: patch.restoreContext,
    backgroundItems: patch.backgroundItems,
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
  setAgentStopControls({ self: null, descendants: [] });
});

afterEach(() => {
  cleanup();
  disposeManagedCommandChatSessions();
  epicHandle.dispose();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLayoutStore.setState({ composer: DEFAULT_COMPOSER_LAYOUT });
  setAgentStopControls({ self: null, descendants: [] });
});

describe("useChatDockChrome via ChatDockCompactStrip", () => {
  it("prints the files-changed chip from the accumulated line counts and names the file count in its label", () => {
    useLayoutStore.setState({
      composer: { ...DEFAULT_COMPOSER_LAYOUT, filesChanged: "compact" },
    });

    renderSurfaces(
      surfacesProps({
        restoreContext: {
          ...EMPTY_RESTORE,
          accumulatedFileChanges: [
            fileChangeRow("/repo/src/a.ts", 5, 0),
            fileChangeRow("/repo/src/b.ts", 0, 3),
          ],
        },
        queueItems: [],
        backgroundItems: [],
      }),
    );

    const chip = screen.getByTestId("chat-dock-chip-filesChanged");
    expect(chip.textContent).toBe(`+5 ${MINUS}3`);
    expect(chip.getAttribute("aria-label")).toBe(
      "Files changed. 2 files, 5 added and 3 removed.",
    );
  });

  it("prints the active-agents chip from the same arithmetic ActiveAgentsPanel uses for its own running count", () => {
    useLayoutStore.setState({
      composer: { ...DEFAULT_COMPOSER_LAYOUT, activeAgents: "compact" },
    });
    const self = agentRow("chat-1", "This chat", "turn");
    const descendants = [
      agentRow("child-1", "Child one", "turn"),
      agentRow("child-2", "Child two", "background"),
    ];
    setAgentStopControls({ self, descendants });
    // ActiveAgentsPanel's own header: descendants.length + (self.activity === false ? 0 : 1)
    const expectedRunningCount =
      descendants.length + (self.activity === false ? 0 : 1);

    renderSurfaces(
      surfacesProps({
        restoreContext: EMPTY_RESTORE,
        queueItems: [],
        backgroundItems: [],
      }),
    );

    const chip = screen.getByTestId("chat-dock-chip-activeAgents");
    expect(chip.textContent).toBe(`${expectedRunningCount}`);
    expect(chip.getAttribute("aria-label")).toBe(
      `Active agents. ${expectedRunningCount} running.`,
    );
  });

  it("prints the background chip from the running row count and the shared header summary sentence", () => {
    useLayoutStore.setState({
      composer: { ...DEFAULT_COMPOSER_LAYOUT, background: "compact" },
    });

    renderSurfaces(
      surfacesProps({
        restoreContext: EMPTY_RESTORE,
        queueItems: [],
        backgroundItems: [backgroundCommandItem("task-1", "bun test")],
      }),
    );

    const chip = screen.getByTestId("chat-dock-chip-background");
    expect(chip.textContent).toBe("1");
    expect(chip.getAttribute("aria-label")).toBe("Background. 1 running.");
  });

  // The most important case: no self agent, no descendants, but the queue
  // holds prompts *received* from other agents. `agentsChip` in
  // `chat-tile-lower-surfaces.tsx` reads
  // `composer.activeAgents === "compact" && (input.activeAgentsVisible || receivedAgentCount > 0)`.
  // Delete the `receivedAgentCount > 0` half of that clause and two things
  // happen at once: the chip stops existing (this suite's first assertion
  // below fails), AND `folded` never gains "activeAgents" - so
  // `foldedQueue` hands the received rows straight through and they render
  // in the dock (the second assertion fails too). Both are needed to pin the
  // clause; neither alone would catch every way of dropping it.
  it("folds received A2A prompts into a '0 · N' chip and keeps only the user-typed item in the dock", () => {
    useLayoutStore.setState({
      composer: { ...DEFAULT_COMPOSER_LAYOUT, activeAgents: "compact" },
    });

    renderSurfaces(
      surfacesProps({
        restoreContext: EMPTY_RESTORE,
        queueItems: [
          receivedAgentQueueItem("received-1", "Received prompt one"),
          receivedAgentQueueItem("received-2", "Received prompt two"),
          queuedItem("queue-1", "My own message"),
        ],
        backgroundItems: [],
      }),
    );

    const chip = screen.getByTestId("chat-dock-chip-activeAgents");
    expect(chip.textContent).toBe("0 · 2");
    expect(chip.getAttribute("aria-label")).toBe(
      "Active agents. 0 running, 2 received from other agents and queued.",
    );

    const queueRows = screen.getByTestId("queued-message-rows");
    const previews = within(queueRows).getAllByTestId(
      "queued-message-content-preview",
    );
    expect(previews).toHaveLength(1);
    expect(previews[0]?.textContent).toContain("My own message");
  });

  it("reveals a folded row already expanded on chip click, and folds it back to a chip on the second click", () => {
    useLayoutStore.setState({
      composer: { ...DEFAULT_COMPOSER_LAYOUT, filesChanged: "compact" },
    });

    renderSurfaces(
      surfacesProps({
        restoreContext: {
          ...EMPTY_RESTORE,
          accumulatedFileChanges: [fileChangeRow("/repo/src/a.ts", 1, 1)],
        },
        queueItems: [],
        backgroundItems: [],
      }),
    );

    const chip = screen.getByTestId("chat-dock-chip-filesChanged");
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("accumulated-changes-panel")).toBeNull();

    fireEvent.click(chip);

    expect(chip.getAttribute("aria-pressed")).toBe("true");
    const panel = screen.getByTestId("accumulated-changes-panel");
    // Seeded open by `useChatDockSectionRevealed` - a chip click asks for the
    // panel, not for a second click to open it too.
    expect(panel.getAttribute("data-state")).toBe("open");

    fireEvent.click(chip);

    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("accumulated-changes-panel")).toBeNull();
  });

  // Landed after the initial review: a reveal belongs to its chip and must
  // not survive the chip disappearing. Otherwise the NEXT time the section
  // has something to show, it would silently arrive pre-expanded rather than
  // as a chip - the exact per-tile stickiness the reveal is supposed to grant
  // only while the chip that earned it is still there.
  it("prunes a stale reveal when its chip's predicate goes false, so the row comes back as a chip, not revealed", () => {
    useLayoutStore.setState({
      composer: { ...DEFAULT_COMPOSER_LAYOUT, filesChanged: "compact" },
    });
    const withChanges = surfacesProps({
      restoreContext: {
        ...EMPTY_RESTORE,
        accumulatedFileChanges: [fileChangeRow("/repo/src/a.ts", 1, 1)],
      },
      queueItems: [],
      backgroundItems: [],
    });
    const withoutChanges = surfacesProps({
      restoreContext: { ...EMPTY_RESTORE, accumulatedFileChanges: [] },
      queueItems: [],
      backgroundItems: [],
    });

    const { rerender } = renderSurfaces(withChanges);
    fireEvent.click(screen.getByTestId("chat-dock-chip-filesChanged"));
    expect(
      screen
        .getByTestId("accumulated-changes-panel")
        .getAttribute("data-state"),
    ).toBe("open");

    rerender(tile(withoutChanges));

    // The chip itself has nothing to show, so it disappears along with the row.
    expect(screen.queryByTestId("chat-dock-chip-filesChanged")).toBeNull();
    expect(screen.queryByTestId("accumulated-changes-panel")).toBeNull();

    rerender(tile(withChanges));

    // Back as a CHIP, not silently revealed by the stale reveal from before.
    expect(screen.getByTestId("chat-dock-chip-filesChanged")).not.toBeNull();
    expect(screen.queryByTestId("accumulated-changes-panel")).toBeNull();
  });
});
