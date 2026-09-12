import {
  act,
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
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";

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
  type ManagedCommandChatSessionStub,
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

// U+2212 MINUS SIGN, not a hyphen - `DiffLineDeltas` prints deletions
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
let managedCommandSession: ManagedCommandChatSessionStub;

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

function backgroundWakeupItem(taskId: string, title: string): BackgroundItem {
  return {
    taskId,
    kind: "wakeup",
    title,
    blockId: `${taskId}-block`,
    parentTaskId: null,
    scheduledFor: new Date(2026, 0, 2, 9, 30).getTime(),
  };
}

/**
 * A live host-supervised shell.
 *
 * `monitoring` is deliberately a parameter: it is what a watcher following a PR
 * has on, and the point of the cases below is that it changes nothing about
 * whether the shell counts as running. The host reports a shell whose process
 * is alive as `running` either way - `monitoring` says where its OUTPUT goes,
 * not whether it has any.
 */
function runningManagedCommand(args: {
  readonly id: string;
  readonly description: string;
  readonly monitoring: boolean;
}): ManagedCommand {
  return {
    id: args.id,
    monitoring: args.monitoring,
    description: args.description,
    command: "gh pr checks --watch",
    cwd: "/repo",
    cadence: args.monitoring
      ? { debounceMs: 500, maxWaitMs: 15000, throttleMs: 5000 }
      : null,
    status: { state: "running", pid: 4242, startedAtMs: 1 },
    relaunchOnHostRestart: false,
    chatId: CHAT_ID,
    createdAtMs: 1,
    updatedAtMs: 2,
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

/** The chip's printed short form - which is the whole of what it prints. */
function chipText(section: string): string | null {
  return screen.getByTestId(`chat-dock-chip-${section}`).textContent;
}

/**
 * True when this chip is drawing the live treatment - a lit, shimmering icon.
 * The tone and the sweep arrive together on the one element, so the shimmering
 * glyph standing for them is enough; `chat-dock-compact-strip.test.tsx` pins
 * the parts.
 */
function chipWorking(section: string): boolean {
  const chipElement = screen.getByTestId(`chat-dock-chip-${section}`);
  return chipElement.querySelector("[data-chip-glyph-shimmer]") !== null;
}

beforeEach(() => {
  managedCommandSession = installManagedCommandChatSession({
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
    // The file count leads, the panel header's own totals follow. `chipText`
    // now reads the WHOLE chip, so the next line is the same assertion with
    // the deltas included rather than a second, narrower one.
    expect(chip.textContent).toBe(`2+5${MINUS}3`);
    expect(chip.getAttribute("aria-label")).toBe(
      "Files changed. 2 files, 5 lines added, 3 removed.",
    );
  });

  // A turn that only adds, and a set whose summaries have not landed yet: the
  // chip drops the side it has nothing to say about rather than printing a
  // zero, and falls back to the count alone when it has neither.
  it("omits a zero side of the files-changed chip, and its label with it", () => {
    useLayoutStore.setState({
      composer: { ...DEFAULT_COMPOSER_LAYOUT, filesChanged: "compact" },
    });
    const addedOnly = surfacesProps({
      restoreContext: {
        ...EMPTY_RESTORE,
        accumulatedFileChanges: [fileChangeRow("/repo/src/a.ts", 5, 0)],
      },
      queueItems: [],
      backgroundItems: [],
    });
    const noCounts = surfacesProps({
      restoreContext: {
        ...EMPTY_RESTORE,
        accumulatedFileChanges: [fileChangeRow("/repo/src/a.ts", 0, 0)],
      },
      queueItems: [],
      backgroundItems: [],
    });

    const deletedOnly = surfacesProps({
      restoreContext: {
        ...EMPTY_RESTORE,
        accumulatedFileChanges: [fileChangeRow("/repo/src/a.ts", 0, 4)],
      },
      queueItems: [],
      backgroundItems: [],
    });

    const { rerender } = renderSurfaces(addedOnly);

    const chip = screen.getByTestId("chat-dock-chip-filesChanged");
    expect(chip.textContent).toBe("1+5");
    expect(chip.getAttribute("aria-label")).toBe(
      "Files changed. 1 file, 5 lines added.",
    );

    rerender(tile(deletedOnly));

    // With nothing added, the noun rides on the removal clause instead.
    expect(chip.textContent).toBe(`1${MINUS}4`);
    expect(chip.getAttribute("aria-label")).toBe(
      "Files changed. 1 file, 4 lines removed.",
    );

    rerender(tile(noCounts));

    expect(chip.textContent).toBe("1");
    expect(chip.getAttribute("aria-label")).toBe("Files changed. 1 file.");
  });

  // One line each way: the sentence has to say "line", not "1 lines".
  it("names a single added or removed line in the singular", () => {
    useLayoutStore.setState({
      composer: { ...DEFAULT_COMPOSER_LAYOUT, filesChanged: "compact" },
    });
    const oneEachWay = surfacesProps({
      restoreContext: {
        ...EMPTY_RESTORE,
        accumulatedFileChanges: [fileChangeRow("/repo/src/a.ts", 1, 1)],
      },
      queueItems: [],
      backgroundItems: [],
    });
    const oneRemoved = surfacesProps({
      restoreContext: {
        ...EMPTY_RESTORE,
        accumulatedFileChanges: [fileChangeRow("/repo/src/a.ts", 0, 1)],
      },
      queueItems: [],
      backgroundItems: [],
    });

    const { rerender } = renderSurfaces(oneEachWay);

    const chip = screen.getByTestId("chat-dock-chip-filesChanged");
    expect(chip.getAttribute("aria-label")).toBe(
      "Files changed. 1 file, 1 line added, 1 removed.",
    );

    rerender(tile(oneRemoved));

    expect(chip.getAttribute("aria-label")).toBe(
      "Files changed. 1 file, 1 line removed.",
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
    expect(chipText("activeAgents")).toBe(`${expectedRunningCount}`);
    // The panel's row list, folded into the tooltip: who, and in what state.
    expect(chip.getAttribute("aria-label")).toBe(
      `Active agents. ${expectedRunningCount} running. This chat working, Child one working, Child two in background.`,
    );
  });

  it("lights the active-agents icon while any agent is mid-turn, and rests it when every one is background-only", () => {
    useLayoutStore.setState({
      composer: { ...DEFAULT_COMPOSER_LAYOUT, activeAgents: "compact" },
    });
    setAgentStopControls({
      self: agentRow("chat-1", "This chat", "background"),
      descendants: [agentRow("child-1", "Child one", "turn")],
    });
    const props = surfacesProps({
      restoreContext: EMPTY_RESTORE,
      queueItems: [],
      backgroundItems: [],
    });

    const { rerender } = renderSurfaces(props);

    const chip = screen.getByTestId("chat-dock-chip-activeAgents");
    // The icon stays `Bot` throughout - only the live treatment comes and
    // goes. Nothing the chip PRINTS changes with the state: the count is the
    // whole of its text either way, and the state it is in is the icon's to
    // say (and the sentence's).
    expect(chipWorking("activeAgents")).toBe(true);
    expect(chip.querySelector("svg.lucide-bot")).not.toBeNull();
    expect(chipText("activeAgents")).toBe("2");

    setAgentStopControls({
      self: agentRow("chat-1", "This chat", "background"),
      descendants: [agentRow("child-1", "Child one", "background")],
    });
    rerender(tile(props));

    expect(chipWorking("activeAgents")).toBe(false);
    expect(chip.querySelector("svg.lucide-bot")).not.toBeNull();
    expect(chipText("activeAgents")).toBe("2");
    expect(chip.getAttribute("aria-label")).toBe(
      "Active agents. 2 running. This chat in background, Child one in background.",
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
    expect(chipText("background")).toBe("1");
    expect(chip.getAttribute("aria-label")).toBe("Background. 1 running.");
    // Something is running, so the kind's icon pulses - it is not replaced.
    expect(chipWorking("background")).toBe(true);
    expect(chip.querySelector("svg.lucide-square-terminal")).not.toBeNull();
  });

  // Running and mixed at once: the neutral stack is still the glyph, and the
  // blink rides on it. The two axes are independent, and this is the case that
  // would have been hidden while a working chip swapped its icon out.
  it("keeps the neutral stack on a background chip whose mixed rows are running", () => {
    useLayoutStore.setState({
      composer: { ...DEFAULT_COMPOSER_LAYOUT, background: "compact" },
    });

    renderSurfaces(
      surfacesProps({
        restoreContext: EMPTY_RESTORE,
        queueItems: [],
        backgroundItems: [
          backgroundCommandItem("task-1", "bun test"),
          backgroundWakeupItem("wake-1", "Review status"),
        ],
      }),
    );

    const chip = screen.getByTestId("chat-dock-chip-background");
    expect(chipText("background")).toBe("1");
    expect(chip.getAttribute("aria-label")).toBe(
      "Background. 1 running · 1 waiting.",
    );
    expect(chipWorking("background")).toBe(true);
    expect(chip.querySelector("svg.lucide-layers")).not.toBeNull();
  });

  // A pending wake is not running, so the chip rests - and rests on the wake's
  // own icon, the one the panel row would draw, rather than a generic one.
  it("rests the background chip on the one kind present, and on the neutral stack when kinds differ", () => {
    useLayoutStore.setState({
      composer: { ...DEFAULT_COMPOSER_LAYOUT, background: "compact" },
    });
    renderSurfaces(
      surfacesProps({
        restoreContext: EMPTY_RESTORE,
        queueItems: [],
        backgroundItems: [backgroundWakeupItem("wake-1", "Review status")],
      }),
    );

    const chip = screen.getByTestId("chat-dock-chip-background");
    expect(chipText("background")).toBe("0");
    expect(chipWorking("background")).toBe(false);
    expect(chip.querySelector("svg.lucide-alarm-clock")).not.toBeNull();

    // A held shell joins the wake: two kinds, so neither icon may stand for
    // both. Held output is not running, so the chip still rests.
    act(() => {
      managedCommandSession.setHeldUpdates([
        { commandId: "cmd-1", description: "deploy watcher", heldAtMs: 1 },
      ]);
    });

    expect(chipText("background")).toBe("0");
    expect(chipWorking("background")).toBe(false);
    expect(chip.querySelector("svg.lucide-layers")).not.toBeNull();
  });

  // The report that started this: a Traycer shell following a PR drew `⏸ 1` -
  // a pause glyph over a live process. The count was right all along (the host
  // reports a monitoring shell as `running` like any other), so the glyph was
  // the whole of the lie, and one blink was too quiet to contradict it.
  //
  // `monitoring: true` is the case that was reported, and it must be
  // indistinguishable from any other live shell here.
  it("draws a running monitor shell as a lit terminal that says it is running", () => {
    useLayoutStore.setState({
      composer: { ...DEFAULT_COMPOSER_LAYOUT, background: "compact" },
    });

    renderSurfaces(
      surfacesProps({
        restoreContext: EMPTY_RESTORE,
        queueItems: [],
        backgroundItems: [],
      }),
    );
    act(() => {
      managedCommandSession.setCommands([
        runningManagedCommand({
          id: "cmd-1",
          description: "PR checks",
          monitoring: true,
        }),
      ]);
    });

    const chip = screen.getByTestId("chat-dock-chip-background");
    expect(chipText("background")).toBe("1");
    expect(chip.getAttribute("aria-label")).toBe("Background. 1 running.");
    expect(chipWorking("background")).toBe(true);
    // "running" is said in the sentence and nowhere in the chip's own text.
    expect(chipText("background")).toBe("1");
    expect(chip.querySelector("svg.lucide-terminal")).not.toBeNull();
    expect(chip.querySelector("svg.lucide-circle-pause")).toBeNull();
  });

  // The resting half of the same pair. A shell that has exited and is holding
  // its last output is the one thing on the chip that is genuinely NOT running,
  // and it is told apart by the sentence and the tone - never by a second
  // glyph, which is what made a live watcher read as paused.
  it("rests a shells-only background chip on the same terminal, and says held", () => {
    useLayoutStore.setState({
      composer: { ...DEFAULT_COMPOSER_LAYOUT, background: "compact" },
    });

    renderSurfaces(
      surfacesProps({
        restoreContext: EMPTY_RESTORE,
        queueItems: [],
        backgroundItems: [],
      }),
    );
    act(() => {
      managedCommandSession.setHeldUpdates([
        { commandId: "cmd-1", description: "deploy watcher", heldAtMs: 1 },
      ]);
    });

    const chip = screen.getByTestId("chat-dock-chip-background");
    expect(chip.getAttribute("aria-label")).toBe("Background. 1 held.");
    expect(chipWorking("background")).toBe(false);
    expect(chipText("background")).toBe("0");
    expect(chip.querySelector("svg.lucide-terminal")).not.toBeNull();
    expect(chip.querySelector("svg.lucide-circle-pause")).toBeNull();
  });

  // `BackgroundItemsPanel` counts its own header on `dedupeByTaskId(items)`, so
  // a duplicate `taskId` is ONE waiting row there. The chip counted the raw
  // list and said "2 waiting" beside that panel's "1 waiting" - the
  // disagreement `background-item-tree` exists to prevent. The host removes an
  // item atomically at its terminal, so the duplicate is transient rather than
  // expected; it is the asymmetry that is the defect, not the input.
  it("counts a duplicated wakeup task once in the background chip, as the panel header does", () => {
    useLayoutStore.setState({
      composer: { ...DEFAULT_COMPOSER_LAYOUT, background: "compact" },
    });

    renderSurfaces(
      surfacesProps({
        restoreContext: EMPTY_RESTORE,
        queueItems: [],
        backgroundItems: [
          backgroundWakeupItem("wake-1", "Review status"),
          backgroundWakeupItem("wake-1", "Review status"),
        ],
      }),
    );

    const chip = screen.getByTestId("chat-dock-chip-background");
    expect(chip.getAttribute("aria-label")).toBe("Background. 1 waiting.");
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
    expect(chipText("activeAgents")).toBe("0 · 2");
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

  // The roster is bounded by fleet size, so an uncapped join would read a
  // paragraph out before the count a listener actually wanted.
  it("names at most three agents in the chip's label and counts the rest", () => {
    useLayoutStore.setState({
      composer: { ...DEFAULT_COMPOSER_LAYOUT, activeAgents: "compact" },
    });
    setAgentStopControls({
      self: agentRow("chat-1", "This chat", "turn"),
      descendants: [
        agentRow("child-1", "Child one", "turn"),
        agentRow("child-2", "Child two", "background"),
        agentRow("child-3", "Child three", "turn"),
        agentRow("child-4", "Child four", "turn"),
      ],
    });

    renderSurfaces(
      surfacesProps({
        restoreContext: EMPTY_RESTORE,
        queueItems: [],
        backgroundItems: [],
      }),
    );

    const chip = screen.getByTestId("chat-dock-chip-activeAgents");
    expect(chipText("activeAgents")).toBe("5");
    expect(chip.getAttribute("aria-label")).toBe(
      "Active agents. 5 running. This chat working, Child one working, Child two in background, and 2 more.",
    );
  });

  // Reachable only through the received-A2A clause: with no self record the
  // count is 0 and the panel renders nothing, so the chip must not spin or
  // name working agents over that zero.
  it("keeps the spinner and the roster off a chip standing for received prompts alone", () => {
    useLayoutStore.setState({
      composer: { ...DEFAULT_COMPOSER_LAYOUT, activeAgents: "compact" },
    });
    setAgentStopControls({
      self: null,
      descendants: [agentRow("child-1", "Child one", "turn")],
    });

    renderSurfaces(
      surfacesProps({
        restoreContext: EMPTY_RESTORE,
        queueItems: [receivedAgentQueueItem("received-1", "Received prompt")],
        backgroundItems: [],
      }),
    );

    const chip = screen.getByTestId("chat-dock-chip-activeAgents");
    expect(chipText("activeAgents")).toBe("0 · 1");
    expect(chipWorking("activeAgents")).toBe(false);
    expect(chip.querySelector("svg.lucide-bot")).not.toBeNull();
    expect(chip.getAttribute("aria-label")).toBe(
      "Active agents. 0 running, 1 received from other agents and queued.",
    );
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
