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
import type { ChatPortForward } from "@traycer/protocol/host/port-forward";

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

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
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

// Renders `workspaceControls` rather than discarding it, so the row's own
// contents stay observable. The compact chips are NOT in it any more (A12,
// L-97) - `ChatLowerDock` draws the strip above the composer, which is outside
// this stub and is what the chip assertions below reach.
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
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import { NO_PROVIDER_FALLBACK } from "@/components/chat/fallback/fallback-state";
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

/** A live port forward, seeded through `managedCommandSession.setPortForwards`. */
function portForward(id: string): ChatPortForward {
  return {
    forwardId: id,
    description: "dev server",
    target: { hostId: HOST_ID, port: 3000 },
    listen: { hostId: HOST_ID, requestedPort: 8080, boundPort: 8080 },
    state: "active",
    stateReason: null,
    createdAtMs: 1,
    recentEvents: [],
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
    sentFromHostId: null,
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
      autoPermissionModeProtocolSupported: null,
      getDraftBlobBridgeSupported: () => false,
      getActiveTurnForSteer: () => null,
      // Unused by this suite - it covers dock-chrome folding, not Stop.
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
      // The one required departure from the background-spacing harness: this
      // must actually contain the strip, not `null`.
      // The chips are no longer in the workspace row (A12, L-97):
      // `ChatLowerDock` renders the strip itself, above the composer.
      workspaceControls: <div data-testid="workspace-controls-stub" />,
      workspaceAvailability: WORKSPACE_COMPOSER_READY,
      suggestedPrompt: undefined,
    },
    todo: null,
    restoreContext: patch.restoreContext,
    backgroundItems: patch.backgroundItems,
    // No fallback in flight: this suite is about the dock chrome, and the
    // retry row is `chat-lower-background-spacing.test.tsx`'s subject.
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
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  useLayoutEditorStore.getState().endSession();
  useLayoutEditorStore.setState({ instances: new Map() });
  setAgentStopControls({ self: null, descendants: [] });
});

afterEach(() => {
  cleanup();
  disposeManagedCommandChatSessions();
  epicHandle.dispose();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLayoutEditorStore.getState().endSession();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  setAgentStopControls({ self: null, descendants: [] });
});

describe("useChatDockChrome via ChatDockCompactStrip", () => {
  it("prints the files-changed chip from the accumulated line counts and names the file count in its label", () => {
    useLayoutStore.getState().setRegionValues("changedFiles", { size: "chip" });

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
    useLayoutStore.getState().setRegionValues("changedFiles", { size: "chip" });
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
    useLayoutStore.getState().setRegionValues("changedFiles", { size: "chip" });
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
    useLayoutStore
      .getState()
      .setRegionValues("runningAgents", { size: "chip" });
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
    useLayoutStore
      .getState()
      .setRegionValues("runningAgents", { size: "chip" });
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
    useLayoutStore.getState().setRegionValues("background", { size: "chip" });

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
    // Something is running, so the section's mark pulses - it is not replaced,
    // and it is not the row's own `square-terminal`: one kind of row does not
    // change what the chip is.
    expect(chipWorking("background")).toBe(true);
    expect(
      chip.querySelector("svg.lucide-message-square-clock"),
    ).not.toBeNull();
    expect(chip.querySelector("svg.lucide-square-terminal")).toBeNull();
    expect(chip.querySelector("svg.lucide-layers")).toBeNull();
  });

  // Running and mixed at once: the section's mark is still the glyph, and the
  // blink rides on it. The two axes are independent, and this is the case that
  // would have been hidden while a working chip swapped its icon out.
  it("keeps the section's mark on a background chip whose mixed rows are running", () => {
    useLayoutStore.getState().setRegionValues("background", { size: "chip" });

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
    // Total, not the running count alone: one running row plus one waiting.
    expect(chipText("background")).toBe("2");
    expect(chip.getAttribute("aria-label")).toBe(
      "Background. 1 running · 1 waiting.",
    );
    expect(chipWorking("background")).toBe(true);
    expect(
      chip.querySelector("svg.lucide-message-square-clock"),
    ).not.toBeNull();
    expect(chip.querySelector("svg.lucide-layers")).toBeNull();
  });

  // A pending wake is not running, so the chip rests - on the same mark. The
  // rows' kinds are the panel's to draw; the chip never borrowed the wake's
  // clock for one kind or a neutral stack for two.
  it("rests the background chip on the section's mark, one kind or mixed", () => {
    useLayoutStore.getState().setRegionValues("background", { size: "chip" });
    renderSurfaces(
      surfacesProps({
        restoreContext: EMPTY_RESTORE,
        queueItems: [],
        backgroundItems: [backgroundWakeupItem("wake-1", "Review status")],
      }),
    );

    const chip = screen.getByTestId("chat-dock-chip-background");
    // Every group the panel lists, not just the running part: one waiting wake.
    expect(chipText("background")).toBe("1");
    expect(chipWorking("background")).toBe(false);
    expect(chip.getAttribute("aria-label")).toBe("Background. 1 waiting.");
    expect(
      chip.querySelector("svg.lucide-message-square-clock"),
    ).not.toBeNull();
    expect(chip.querySelector("svg.lucide-alarm-clock")).toBeNull();

    // A held shell joins the wake: two kinds, and the mark does not change.
    // Held output is not running, so the chip still rests, but its own group
    // still joins the total.
    act(() => {
      managedCommandSession.setHeldUpdates([
        { commandId: "cmd-1", description: "deploy watcher", heldAtMs: 1 },
      ]);
    });

    expect(chipText("background")).toBe("2");
    expect(chipWorking("background")).toBe(false);
    expect(chip.getAttribute("aria-label")).toBe(
      "Background. 1 held · 1 waiting.",
    );
    expect(
      chip.querySelector("svg.lucide-message-square-clock"),
    ).not.toBeNull();
    expect(chip.querySelector("svg.lucide-layers")).toBeNull();
  });

  // The report that started this: a Traycer shell following a PR drew `⏸ 1` -
  // a pause glyph over a live process. The count was right all along (the host
  // reports a monitoring shell as `running` like any other), so the glyph was
  // the whole of the lie, and one blink was too quiet to contradict it.
  //
  // `monitoring: true` is the case that was reported, and it must be
  // indistinguishable from any other live shell here.
  it("draws a running monitor shell as the lit section mark that says it is running", () => {
    useLayoutStore.getState().setRegionValues("background", { size: "chip" });

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
    expect(
      chip.querySelector("svg.lucide-message-square-clock"),
    ).not.toBeNull();
    expect(chip.querySelector("svg.lucide-circle-pause")).toBeNull();
  });

  // The resting half of the same pair. A shell that has exited and is holding
  // its last output is the one thing on the chip that is genuinely NOT running,
  // and it is told apart by the sentence and the tone - never by a second
  // glyph, which is what made a live watcher read as paused.
  it("rests a shells-only background chip on the same mark, and says held", () => {
    useLayoutStore.getState().setRegionValues("background", { size: "chip" });

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
    // Held work joins the total, so the number no longer reads "0" over a
    // section the panel shows one row for.
    expect(chipText("background")).toBe("1");
    expect(
      chip.querySelector("svg.lucide-message-square-clock"),
    ).not.toBeNull();
    expect(chip.querySelector("svg.lucide-circle-pause")).toBeNull();
  });

  // Held-and-running is the same shell id in both sets: the panel renders it
  // ONCE, as held, so the total must not double count it either.
  it("counts a shell that is both running and held once, as held", () => {
    useLayoutStore.getState().setRegionValues("background", { size: "chip" });

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
          description: "deploy watcher",
          monitoring: false,
        }),
      ]);
    });
    act(() => {
      managedCommandSession.setHeldUpdates([
        { commandId: "cmd-1", description: "deploy watcher", heldAtMs: 1 },
      ]);
    });

    const chip = screen.getByTestId("chat-dock-chip-background");
    expect(chipText("background")).toBe("1");
    expect(chipWorking("background")).toBe(false);
    expect(chip.getAttribute("aria-label")).toBe("Background. 1 held.");
  });

  // A port forward outlives the turn that made it, so a chat that is
  // otherwise idle can still hold one - and the chip's number has to include
  // it. Seeded through the real chat session store `usePortForwardsForChat`
  // reads, not a mock of the hook.
  it("counts a live port forward in the background chip, with no items or shells", () => {
    useLayoutStore.getState().setRegionValues("background", { size: "chip" });

    renderSurfaces(
      surfacesProps({
        restoreContext: EMPTY_RESTORE,
        queueItems: [],
        backgroundItems: [],
      }),
    );
    act(() => {
      managedCommandSession.setPortForwards([portForward("forward-1")]);
    });

    const chip = screen.getByTestId("chat-dock-chip-background");
    expect(chipText("background")).toBe("1");
    expect(chipWorking("background")).toBe(false);
    expect(chip.getAttribute("aria-label")).toBe("Background. 1 port forward.");
  });

  // Every part at once: a running background item, a waiting wake, a held
  // shell and a port forward. The total sums all four, the label names each,
  // and the chip lights because something is genuinely running.
  it("sums every part of the background section in one mixed chip", () => {
    useLayoutStore.getState().setRegionValues("background", { size: "chip" });

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
    act(() => {
      managedCommandSession.setHeldUpdates([
        { commandId: "cmd-1", description: "deploy watcher", heldAtMs: 1 },
      ]);
    });
    act(() => {
      managedCommandSession.setPortForwards([portForward("forward-1")]);
    });

    const chip = screen.getByTestId("chat-dock-chip-background");
    expect(chipText("background")).toBe("4");
    expect(chipWorking("background")).toBe(true);
    expect(chip.getAttribute("aria-label")).toBe(
      "Background. 1 running · 1 held · 1 waiting · 1 port forward.",
    );
  });

  // `BackgroundItemsPanel` counts its own header on `dedupeByTaskId(items)`, so
  // a duplicate `taskId` is ONE waiting row there. The chip counted the raw
  // list and said "2 waiting" beside that panel's "1 waiting" - the
  // disagreement `background-item-tree` exists to prevent. The host removes an
  // item atomically at its terminal, so the duplicate is transient rather than
  // expected; it is the asymmetry that is the defect, not the input.
  it("counts a duplicated wakeup task once in the background chip, as the panel header does", () => {
    useLayoutStore.getState().setRegionValues("background", { size: "chip" });

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

  // The most important case now: no self agent, no descendants, but the
  // queue holds prompts *received* from other agents. Before this fix,
  // `receivedAgentCount > 0` kept `agentsChip` alive on its own and
  // `foldedQueue` hid these two rows behind it until the chip was clicked
  // open. The queue is never a pill now (G1-G2, staging round 4): a received
  // row buys the chip nothing, and every row in the queue renders
  // unconditionally. Reintroduce the old `receivedAgentCount > 0` clause on
  // `agentsChip` and the first assertion below fails (a chip with no agent
  // behind it); reintroduce `foldedQueue` and the two received rows vanish
  // from the second.
  it("keeps agent-sent queued rows out of the agents chip when nothing is running", () => {
    useLayoutStore
      .getState()
      .setRegionValues("runningAgents", { size: "chip" });

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

    expect(screen.queryByTestId("chat-dock-chip-activeAgents")).toBeNull();

    // All three rows render plainly - no click needed to reveal the two the
    // chip used to fold away.
    const queueRows = screen.getByTestId("queued-message-rows");
    expect(within(queueRows).getAllByTestId("queued-message-row")).toHaveLength(
      3,
    );
    const previews = within(queueRows).getAllByTestId(
      "queued-message-content-preview",
    );
    expect(previews.map((preview) => preview.textContent)).toEqual([
      "Received prompt one",
      "Received prompt two",
      "My own message",
    ]);
    expect(
      within(queueRows).getAllByTestId("queued-message-provenance-chip"),
    ).toHaveLength(2);
  });

  // The queue keeps its pause reason while agent-sent and user-typed rows
  // render together, so the held row still says why it paused.
  it("keeps the queue's pausedReason beside received rows", () => {
    useLayoutStore
      .getState()
      .setRegionValues("runningAgents", { size: "chip" });
    const props = surfacesProps({
      restoreContext: EMPTY_RESTORE,
      queueItems: [
        receivedAgentQueueItem("received-1", "Received prompt one"),
        { ...queuedItem("queue-held", "Held message"), status: "paused" },
      ],
      backgroundItems: [],
    });

    renderSurfaces({
      ...props,
      queue: {
        ...props.queue,
        value: {
          ...props.queue.value,
          status: "paused",
          pausedReason: "turn_error",
        },
      },
    });

    const queueRows = screen.getByTestId("queued-message-rows");
    expect(
      within(queueRows)
        .getAllByTestId("queued-message-content-preview")
        .map((row) => row.textContent),
    ).toEqual(["Received prompt one", "Held message"]);
    expect(
      within(queueRows).getByTestId("queued-message-status-badge").textContent,
    ).toBe("Paused after an error");
  });

  // The roster is bounded by fleet size, so an uncapped join would read a
  // paragraph out before the count a listener actually wanted.
  it("names at most three agents in the chip's label and counts the rest", () => {
    useLayoutStore
      .getState()
      .setRegionValues("runningAgents", { size: "chip" });
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

  it("attaches the section's panel on pill click and closes it on the second", () => {
    useLayoutStore.getState().setRegionValues("changedFiles", { size: "chip" });

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
    expect(screen.queryByTestId("chat-dock-attached-panel")).toBeNull();

    fireEvent.click(chip);

    expect(chip.getAttribute("aria-pressed")).toBe("true");
    // Attached above the composer with no collapsible header of its own
    // (L-142): the pill is the header, so the rows are simply there.
    const panel = screen.getByTestId("chat-dock-attached-panel");
    expect(panel.getAttribute("data-dock-section")).toBe("filesChanged");
    expect(screen.queryByTestId("accumulated-changes-panel")).toBeNull();

    fireEvent.click(chip);

    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("chat-dock-attached-panel")).toBeNull();
  });

  // A pill's open state belongs to its pill and must not survive the pill
  // disappearing. Otherwise the NEXT time the section has something to show,
  // it would silently arrive attached rather than as a resting pill - and
  // nothing in this dock ever opens on its own.
  it("forgets the open pill when its section empties, so the pill comes back closed", () => {
    useLayoutStore.getState().setRegionValues("changedFiles", { size: "chip" });
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
        .getByTestId("chat-dock-attached-panel")
        .getAttribute("data-dock-section"),
    ).toBe("filesChanged");

    rerender(tile(withoutChanges));

    // The pill itself has nothing to show, so it disappears with the panel.
    expect(screen.queryByTestId("chat-dock-chip-filesChanged")).toBeNull();
    expect(screen.queryByTestId("chat-dock-attached-panel")).toBeNull();

    rerender(tile(withChanges));

    // Back as a resting PILL, not re-attached by the memory from before.
    expect(screen.getByTestId("chat-dock-chip-filesChanged")).not.toBeNull();
    expect(screen.queryByTestId("chat-dock-attached-panel")).toBeNull();
  });

  // G1-G2: the Compact preset folds every dock region into a chip - but the
  // Message queue is not a dock region at all, so it never gets a chip and
  // never folds. With every real region compacted, the queue still draws its
  // full collapsible panel, and a real member's pill (Todo) still stands in
  // the strip beside it: the queue being fixed does not take the strip off
  // screen or absorb its neighbours.
  it("keeps the queue drawn as its full panel in the Compact preset, never a chip", () => {
    useLayoutStore.getState().setRegionValues("changedFiles", { size: "chip" });
    useLayoutStore
      .getState()
      .setRegionValues("runningAgents", { size: "chip" });
    useLayoutStore.getState().setRegionValues("background", { size: "chip" });
    useLayoutStore.getState().setRegionValues("todo", { size: "chip" });

    const props = surfacesProps({
      restoreContext: EMPTY_RESTORE,
      queueItems: [queuedItem("queued-1", "Do the thing")],
      backgroundItems: [],
    });
    renderSurfaces({
      ...props,
      todo: {
        id: "todo-1",
        items: [
          {
            id: "t1",
            status: "pending",
            text: "One",
            priority: null,
            activeForm: null,
          },
        ],
      },
    });

    expect(screen.queryByTestId("chat-dock-chip-queue")).toBeNull();

    const queueRows = screen.getByTestId("queued-message-rows");
    expect(within(queueRows).getAllByTestId("queued-message-row")).toHaveLength(
      1,
    );
    expect(within(queueRows).getByTestId("pause-queue-button")).not.toBeNull();

    // A real dock member's pill still renders in the strip beside the queue.
    expect(screen.getByTestId("chat-dock-chip-todo")).not.toBeNull();
  });

  // The Default preset draws every dock member as a full row rather than a
  // chip - no `setRegionValues` call in this test folds anything. The queue
  // still draws below every one of them, exactly as it does when members are
  // chips (G1-G2): its fixed position does not depend on how the rows above
  // it are sized.
  it("draws the queue below the other rows in the Default preset", () => {
    const props = surfacesProps({
      restoreContext: {
        ...EMPTY_RESTORE,
        accumulatedFileChanges: [fileChangeRow("/repo/src/a.ts", 5, 0)],
      },
      queueItems: [queuedItem("queued-1", "Do the thing")],
      backgroundItems: [],
    });
    renderSurfaces({
      ...props,
      todo: {
        id: "todo-1",
        items: [
          {
            id: "t1",
            status: "pending",
            text: "One",
            priority: null,
            activeForm: null,
          },
        ],
      },
    });

    const changes = screen.getByTestId("accumulated-changes-panel");
    const todo = screen.getByTestId("pinned-todo-panel");
    const queue = screen.getByTestId("queued-message-rows");
    expect(changes.compareDocumentPosition(queue)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(todo.compareDocumentPosition(queue)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});

/**
 * L-153: a pill's tooltip is a compact hierarchy - the member's name, then its
 * counts, then a quiet click affordance - and not the run-on accessible
 * sentence it used to repeat.
 *
 * Read through the real tile so the DETAIL LINES are the ones the dock
 * actually builds. The chip component's own test covers how the three lines
 * are drawn; what is pinned here is that every kind has one and that each says
 * something true about that section.
 */
describe("each pill's tooltip", () => {
  /** Radix opens on focus, with no timer to advance. */
  async function tooltipFor(section: string): Promise<HTMLElement> {
    fireEvent.focus(screen.getByTestId(`chat-dock-chip-${section}`));
    return screen.findByRole("tooltip");
  }

  function allPills(): void {
    for (const region of [
      "changedFiles",
      "runningAgents",
      "background",
      "todo",
    ] as const) {
      useLayoutStore.getState().setRegionValues(region, { size: "chip" });
    }
  }

  it("names the member, counts it, and offers the click - per kind", async () => {
    allPills();
    const props = surfacesProps({
      restoreContext: {
        ...EMPTY_RESTORE,
        accumulatedFileChanges: [
          fileChangeRow("/repo/src/a.ts", 47, 0),
          fileChangeRow("/repo/src/b.ts", 0, 9),
          fileChangeRow("/repo/src/c.ts", 1, 0),
        ],
      },
      queueItems: [queuedItem("queued-1", "Do the thing")],
      backgroundItems: [
        backgroundCommandItem("task-1", "bun test"),
        backgroundWakeupItem("wake-1", "Review status"),
      ],
    });
    renderSurfaces({
      ...props,
      todo: {
        id: "todo-1",
        items: [
          {
            id: "t1",
            status: "completed",
            text: "One",
            priority: null,
            activeForm: null,
          },
          {
            id: "t2",
            status: "pending",
            text: "Two",
            priority: null,
            activeForm: null,
          },
        ],
      },
    });

    // The pill's own two measurements, with the pill's own signs - not the
    // screen reader's "47 lines added, 9 removed", which stays on the button.
    // The queue is not a pill (G1-G2), so it carries no tooltip here.
    expect((await tooltipFor("filesChanged")).textContent).toBe(
      `Files changed3 files, +48 ${MINUS}9Click to open`,
    );
    expect((await tooltipFor("todo")).textContent).toBe(
      "Todo1 of 2 doneClick to open",
    );
    // The header's own summary: the running count on the pill cannot say that
    // something is merely waiting, and the tooltip is where that is said.
    expect((await tooltipFor("background")).textContent).toBe(
      "Background1 running · 1 waitingClick to open",
    );
  });

  // Its own render: the agents pill needs a genuinely running agent now that
  // a received A2A row alone no longer creates it (staging round 4) - that
  // case is covered on its own above.
  it("counts the agents rather than listing them, with the agent-sent row still in the queue", async () => {
    allPills();
    setAgentStopControls({
      self: agentRow("chat-1", "This chat", "turn"),
      descendants: [agentRow("child-1", "Child one", "background")],
    });
    renderSurfaces(
      surfacesProps({
        restoreContext: EMPTY_RESTORE,
        queueItems: [receivedAgentQueueItem("received-1", "Received prompt")],
        backgroundItems: [],
      }),
    );

    // Plain running count, no "· N" split for received rows any more.
    expect(chipText("activeAgents")).toBe("2");
    expect(chipText("activeAgents")).not.toContain("·");
    expect((await tooltipFor("activeAgents")).textContent).toBe(
      "Active agents2 runningClick to open",
    );
    // The ROSTER - who is running, by name - stays on the accessible
    // sentence. A tooltip that named three agents and "and 2 more" under a
    // heading would stop being the small block L-153 asks for, and the panel
    // one click away is the list.
    expect(
      screen
        .getByTestId("chat-dock-chip-activeAgents")
        .getAttribute("aria-label"),
    ).toBe(
      "Active agents. 2 running. This chat working, Child one in background.",
    );

    // The received row still sits in the queue, with no click needed.
    const queueRows = screen.getByTestId("queued-message-rows");
    expect(within(queueRows).getAllByTestId("queued-message-row")).toHaveLength(
      1,
    );
    expect(
      within(queueRows).getAllByTestId("queued-message-provenance-chip"),
    ).toHaveLength(1);
  });

  it("offers to CLOSE the pill that is open", async () => {
    allPills();
    renderSurfaces(
      surfacesProps({
        restoreContext: {
          ...EMPTY_RESTORE,
          accumulatedFileChanges: [fileChangeRow("/repo/src/a.ts", 5, 0)],
        },
        queueItems: [],
        backgroundItems: [],
      }),
    );

    fireEvent.click(screen.getByTestId("chat-dock-chip-filesChanged"));

    // The last line follows `aria-pressed` rather than restating it, so the
    // open pill never offers to do what it has already done.
    expect((await tooltipFor("filesChanged")).textContent).toBe(
      "Files changed1 file, +5Click to close",
    );
  });
});
