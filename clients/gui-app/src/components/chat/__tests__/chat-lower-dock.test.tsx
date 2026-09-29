import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  BackgroundItem,
  ChatQueuedItem,
  ChatQueuedPromptItem,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  ChatLowerDock,
  type DockRowHotspot,
} from "@/components/chat/chat-lower-dock";
import {
  ChatDockCompactStripProvider,
  type ChatDockCompactChipModel,
} from "@/components/chat/chat-dock-compact-strip";
import type { ChatDockSection } from "@/lib/chat/chat-dock-sections";
import type { AccumulatedChangeRow } from "@/lib/chat/accumulated-change-rows";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import type { PinnedTodoSnapshot } from "@/components/chat/chat-pinned-todos";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import type { SegmentTodoItem } from "@/stores/composer/chat-store";
import type { AgentRow } from "@/hooks/agent/use-agent-stop-controls";

interface CapturedDndContextProps {
  readonly children: ReactNode;
}

interface CapturedSortableContextProps {
  readonly children: ReactNode;
}

vi.mock("@dnd-kit/core", () => ({
  DndContext: (props: CapturedDndContextProps) => (
    <div data-testid="queued-message-dnd-provider">{props.children}</div>
  ),
  KeyboardSensor: class {},
  PointerSensor: class {},
  closestCenter: () => [],
  useSensor: () => null,
  useSensors: () => [],
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: (props: CapturedSortableContextProps) => (
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

vi.mock("@/components/chat/agent-stop-button", () => ({
  AgentStopButton: (props: { readonly label: string }) => (
    <button type="button">{props.label}</button>
  ),
}));

// The background panel reaches for the managed half's RPCs whether or not any
// managed command is on screen; this suite is about the dock's layout and
// dispatch, so the host boundary behind them is the one thing faked.
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

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "codex-test",
  permissionMode: "supervised",
  reasoningEffort: "medium",
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

describe("<ChatLowerDock />", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  // Every remaining member is a dock REGION (L-139), so the frame's vertical
  // order among them is the arrangement's. The queue is not a region at all
  // (G1-G2): it is a fixed slot that always draws as the frame's LAST child,
  // below every row, regardless of what `dockOrder` says.
  it("renders the frame's rows in dock order, with the queue fixed last", () => {
    renderDock({
      folded: undefined,
      queue: queueState([queuedItem("queue-1", "Queued prompt")]),
      todo: todoSnapshot([todoItem("Current task")]),
      changes: [fileChange()],
      backgroundItems: undefined,
      heldManagedCommandCount: 0,
      selfAgent: null,
      activeAgents: [],
      onBackgroundItemClick: () => undefined,
      onBackgroundItemStop: () => null,
      onBackgroundItemsStopAll: () => null,
    });

    const dock = screen.getByTestId("chat-lower-dock");
    const queue = screen.getByTestId("queued-message-rows");
    const todo = screen.getByTestId("pinned-todo-panel");
    const changes = screen.getByTestId("accumulated-changes-panel");

    expect(dock.contains(queue)).toBe(true);
    expect(dock.contains(todo)).toBe(true);
    expect(dock.contains(changes)).toBe(true);
    // `DEFAULT_DOCK_ORDER`: todo, then the three reorderable rows.
    expect(todo.compareDocumentPosition(changes)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // The queue sits after every row, whatever `dockOrder` says.
    expect(changes.compareDocumentPosition(queue)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("keeps the first visible section flush to the rounded top frame", () => {
    renderDock({
      folded: undefined,
      queue: queueState([]),
      todo: null,
      changes: [fileChange()],
      backgroundItems: undefined,
      heldManagedCommandCount: 0,
      selfAgent: null,
      activeAgents: [],
      onBackgroundItemClick: () => undefined,
      onBackgroundItemStop: () => null,
      onBackgroundItemsStopAll: () => null,
    });

    const dock = screen.getByTestId("chat-lower-dock");
    const frame = dock.querySelector(".rounded-t-lg");
    const changes = screen.getByTestId("accumulated-changes-panel");

    expect(frame).not.toBeNull();
    expect(changes.className).not.toContain("border-t");
  });

  // L-97: the full rows keep ONE frame tucked under the composer, and that
  // frame's fill is not `bg-muted` at any alpha - every preset's dark variant
  // defines `--muted` identical to `--card`, so a muted fill on this bordered
  // box over `bg-canvas` is invisible in most of the eighteen themes.
  it("draws one joined frame with no muted fill", () => {
    renderDock({
      ...emptyDock(),
      changes: [fileChange()],
      todo: todoSnapshot([todoItem("Current task")]),
    });

    const dock = screen.getByTestId("chat-lower-dock");
    const frames = dock.querySelectorAll(".rounded-t-lg");
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    expect(frame.className).toContain("border-b-0");
    expect(frame.className).toContain("-mb-px");
    // The frame's OWN fill. (`Collapsible variant="panel"` paints its own
    // `bg-muted/30` inside; that is the design system's call and lives in
    // `components/ui/collapsible.tsx`, not here.)
    expect(frame.className).not.toContain("bg-muted");
    expect(frame.className).toContain("bg-foreground/3");
    // Both panels live inside that one frame rather than in cards of their own.
    expect(frame.contains(screen.getByTestId("pinned-todo-panel"))).toBe(true);
    expect(
      frame.contains(screen.getByTestId("accumulated-changes-panel")),
    ).toBe(true);
  });

  // A12: the pills stand ABOVE the frame at the composer's left edge, not in
  // the workspace row at its right. `ml-auto` was what pushed them right.
  it("puts the pill row first in the stack and left-aligned", () => {
    renderDock({
      ...emptyDock(),
      changes: [fileChange()],
      chips: [compactChip("background")],
    });

    const dock = screen.getByTestId("chat-lower-dock");
    const strip = screen.getByTestId("chat-dock-compact-strip");
    const frame = dock.querySelector(".rounded-t-lg");

    expect(strip.className).not.toContain("ml-auto");
    expect(strip.className).toContain("flex-wrap");
    expect(frame).not.toBeNull();
    expect(strip.compareDocumentPosition(frame as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // L-153: a clear STEP between the pill row and the frame tucked into the
    // composer, not the 6px that made the owner read them as stuck together.
    // Read as a class of the stack the two clusters are children of.
    const stack = strip.parentElement;
    const stackClasses = (stack?.getAttribute("class") ?? "")
      .split(/\s+/)
      .filter(Boolean);
    expect(stackClasses).toContain("gap-3");
    expect(stackClasses).not.toContain("gap-1.5");
  });

  // A.4.4 / risk 2: a fully compact chat has no todo, no queue and no row, so
  // the dock's own null gate used to take the chips off screen with it the
  // moment they moved into the dock. Mutation check: drop the `anyChipVisible`
  // term in `ChatLowerDock` and this goes red.
  it("stays on screen for a chip-only chat", () => {
    renderDock({
      ...emptyDock(),
      changes: [fileChange()],
      folded: new Set(["filesChanged", "activeAgents", "background"]),
      chips: [compactChip("filesChanged")],
    });

    expect(screen.getByTestId("chat-lower-dock")).not.toBeNull();
    expect(screen.getByTestId("chat-dock-compact-strip")).not.toBeNull();
    expect(screen.queryByTestId("accumulated-changes-panel")).toBeNull();
    // The queue is empty (`emptyDock()`), so it draws no node either.
    expect(screen.queryByTestId("queued-message-rows")).toBeNull();
    // And the frame collapses rather than drawing an empty bordered box.
    const frame = screen
      .getByTestId("chat-lower-dock")
      .querySelector(".rounded-t-lg");
    expect(frame?.childElementCount).toBe(0);
  });

  // G1-G2: the queue is a fixed slot, not a dock region, so it draws
  // whenever it holds anything regardless of what the rest of the dock is
  // doing. With every real member folded to a chip, the frame holds nothing
  // BUT the queue.
  it("holds only the queue in the frame when every other member is a chip", () => {
    renderDock({
      ...emptyDock(),
      queue: queueState([queuedItem("queue-1", "Queued prompt")]),
      folded: new Set(["filesChanged", "activeAgents", "background", "todo"]),
      chips: [compactChip("filesChanged")],
    });

    const frame = screen
      .getByTestId("chat-lower-dock")
      .querySelector(".rounded-t-lg");
    expect(frame).not.toBeNull();
    expect(frame?.childElementCount).toBe(1);
    const queue = screen.getByTestId("queued-message-rows");
    expect(frame?.contains(queue)).toBe(true);
  });

  // The attached panel is the frame's topmost, replaceable slot (L-142); the
  // queue is fixed below every row and every panel, including an open one.
  it("draws an open pill's attached panel before the queue", () => {
    renderDock({
      ...emptyDock(),
      queue: queueState([queuedItem("queue-1", "Queued prompt")]),
      folded: new Set(["filesChanged"]),
      chips: [compactChip("filesChanged")],
      openSection: "filesChanged",
      changes: [fileChange()],
    });

    const attached = screen.getByTestId("chat-dock-attached-panel");
    const queue = screen.getByTestId("queued-message-rows");
    expect(attached.compareDocumentPosition(queue)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  // A pill can exist while its panel draws nothing: `dockPanelContent`
  // declines to draw the Active agents panel without a self record even when
  // the chip itself is showing. Clicking that pill used to leave three wrong
  // outputs behind - a pressed pill, an `aria-controls` naming an id no
  // element carries, and the frame's first row drawing a separator under
  // nothing. Everything now follows the NODE the dock built, so a panel that
  // renders nothing is not open. Mutation check: derive `separatedBefore` and
  // the strip's `openSection` from the pill again and all three go red.
  it("claims nothing is open when the open pill's panel renders nothing", () => {
    renderDock({
      ...emptyDock(),
      // No self record, so `dockPanelContent` draws no Active agents panel.
      selfAgent: null,
      activeAgents: [],
      changes: [fileChange()],
      folded: new Set(["activeAgents"]),
      chips: [compactChip("activeAgents")],
      openSection: "activeAgents",
    });

    expect(screen.queryByTestId("chat-dock-attached-panel")).toBeNull();
    const pill = screen.getByTestId("chat-dock-chip-activeAgents");
    expect(pill.getAttribute("aria-pressed")).toBe("false");
    expect(pill.getAttribute("aria-controls")).toBeNull();
    // The first full row is still flush to the frame's rounded top.
    expect(
      screen.getByTestId("accumulated-changes-panel").className,
    ).not.toContain("border-t");
  });

  it("renders background items and dispatches item actions", () => {
    const onBackgroundItemClick = vi.fn();
    const onBackgroundItemStop = vi.fn(() => null);
    const onBackgroundItemsStopAll = vi.fn(() => null);
    const item: BackgroundItem = {
      taskId: "task-1",
      kind: "command",
      title: "bun test",
      blockId: "tool-1",
      parentTaskId: null,
      scheduledFor: null,
      individualStopUnavailable: null,
    };

    renderDock({
      folded: undefined,
      queue: queueState([]),
      todo: null,
      changes: [],
      backgroundItems: [item],
      heldManagedCommandCount: 0,
      selfAgent: null,
      activeAgents: [],
      onBackgroundItemClick,
      onBackgroundItemStop,
      onBackgroundItemsStopAll,
    });

    const backgroundPanel = screen.getByRole("button", {
      name: /Background.*1 running/,
    });
    expect(backgroundPanel).not.toBeNull();
    const stopAll = screen.getByRole("button", { name: "Stop all" });
    fireEvent.click(stopAll);
    expect(onBackgroundItemsStopAll).toHaveBeenCalledTimes(1);

    fireEvent.click(backgroundPanel);
    fireEvent.click(stopAll);
    expect(onBackgroundItemsStopAll).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: /bun test.*Command/ }));
    expect(onBackgroundItemClick).toHaveBeenCalledWith(item);

    fireEvent.click(screen.getByRole("button", { name: "Stop Command" }));
    expect(onBackgroundItemStop).toHaveBeenCalledWith("task-1");
  });

  // The dock's own half of the hold gate. A hold lingers only on a shell that
  // has FINISHED, so it reaches neither the harness's background items nor the
  // running-command count - and on those two alone the dock returned null,
  // taking the only affordance that clears a hold off screen. The count is the
  // parent's to compute (the surfaces below size themselves from the same one);
  // what this pins is that the dock opens the section on it.
  it("opens the Background section on the held count alone", () => {
    renderDock({
      folded: undefined,
      queue: queueState([]),
      todo: null,
      changes: [],
      backgroundItems: [],
      heldManagedCommandCount: 1,
      selfAgent: null,
      activeAgents: [],
      onBackgroundItemClick: () => undefined,
      onBackgroundItemStop: () => null,
      onBackgroundItemsStopAll: () => null,
    });

    expect(screen.getByTestId("chat-lower-dock")).not.toBeNull();
    expect(screen.getByTestId("background-items-panel")).not.toBeNull();
  });

  it("stays closed when nothing is held, running, or queued", () => {
    renderDock({
      folded: undefined,
      queue: queueState([]),
      todo: null,
      changes: [],
      backgroundItems: [],
      heldManagedCommandCount: 0,
      selfAgent: null,
      activeAgents: [],
      onBackgroundItemClick: () => undefined,
      onBackgroundItemStop: () => null,
      onBackgroundItemsStopAll: () => null,
    });

    expect(screen.queryByTestId("chat-lower-dock")).toBeNull();
  });

  it("mounts the parent Active agents bar when awareness reports an active child", () => {
    renderDock({
      folded: undefined,
      queue: queueState([]),
      todo: null,
      changes: [],
      backgroundItems: undefined,
      heldManagedCommandCount: 0,
      selfAgent: agentRow("parent", "Parent agent", false),
      activeAgents: [agentRow("child", "Unopened child", true)],
      onBackgroundItemClick: () => undefined,
      onBackgroundItemStop: () => null,
      onBackgroundItemsStopAll: () => null,
    });

    expect(screen.getByTestId("active-agents-panel")).toBeDefined();
    expect(
      screen.getByRole("button", { name: /Active agents.*1 running/i }),
    ).toBeDefined();
  });

  // Layout ▸ Composer folding: a folded section's row is not rendered, but a
  // fold never suppresses a NEIGHBOURING section - each predicate keeps its
  // own answer and `folded` only subtracts from it.
  describe("folded sections", () => {
    it("drops the changes panel but keeps the todo panel when filesChanged is folded", () => {
      renderDock({
        folded: new Set(["filesChanged"]),
        queue: queueState([]),
        todo: todoSnapshot([todoItem("Current task")]),
        changes: [fileChange()],
        backgroundItems: undefined,
        heldManagedCommandCount: 0,
        selfAgent: null,
        activeAgents: [],
        onBackgroundItemClick: () => undefined,
        onBackgroundItemStop: () => null,
        onBackgroundItemsStopAll: () => null,
      });

      expect(screen.getByTestId("pinned-todo-panel")).not.toBeNull();
      expect(screen.queryByTestId("accumulated-changes-panel")).toBeNull();
    });

    it("renders nothing when every foldable section is folded and there is no todo", () => {
      const backgroundItem: BackgroundItem = {
        taskId: "task-1",
        kind: "command",
        title: "bun test",
        blockId: "tool-1",
        parentTaskId: null,
        scheduledFor: null,
        individualStopUnavailable: null,
      };

      renderDock({
        folded: new Set(["filesChanged", "activeAgents", "background"]),
        queue: queueState([]),
        todo: null,
        changes: [fileChange()],
        backgroundItems: [backgroundItem],
        heldManagedCommandCount: 0,
        selfAgent: agentRow("parent", "Parent agent", true),
        activeAgents: [agentRow("child", "Unopened child", true)],
        onBackgroundItemClick: () => undefined,
        onBackgroundItemStop: () => null,
        onBackgroundItemsStopAll: () => null,
      });

      expect(screen.queryByTestId("chat-lower-dock")).toBeNull();
    });

    it("hides the active agents panel when activeAgents is folded", () => {
      renderDock({
        folded: new Set(["activeAgents"]),
        queue: queueState([]),
        todo: todoSnapshot([todoItem("Keep the dock open")]),
        changes: [],
        backgroundItems: undefined,
        heldManagedCommandCount: 0,
        selfAgent: agentRow("parent", "Parent agent", true),
        activeAgents: [agentRow("child", "Unopened child", true)],
        onBackgroundItemClick: () => undefined,
        onBackgroundItemStop: () => null,
        onBackgroundItemsStopAll: () => null,
      });

      expect(screen.getByTestId("chat-lower-dock")).not.toBeNull();
      expect(screen.getByTestId("pinned-todo-panel")).not.toBeNull();
      expect(screen.queryByTestId("active-agents-panel")).toBeNull();
    });

    it("hides the background panel when background is folded", () => {
      const backgroundItem: BackgroundItem = {
        taskId: "task-1",
        kind: "command",
        title: "bun test",
        blockId: "tool-1",
        parentTaskId: null,
        scheduledFor: null,
        individualStopUnavailable: null,
      };

      renderDock({
        folded: new Set(["background"]),
        queue: queueState([]),
        todo: todoSnapshot([todoItem("Keep the dock open")]),
        changes: [],
        backgroundItems: [backgroundItem],
        heldManagedCommandCount: 0,
        selfAgent: null,
        activeAgents: [],
        onBackgroundItemClick: () => undefined,
        onBackgroundItemStop: () => null,
        onBackgroundItemsStopAll: () => null,
      });

      expect(screen.getByTestId("chat-lower-dock")).not.toBeNull();
      expect(screen.getByTestId("pinned-todo-panel")).not.toBeNull();
      expect(screen.queryByTestId("background-items-panel")).toBeNull();
    });
  });

  // The queue is never filtered by any dock fold (G1-G2, staging round 4):
  // there is no upstream `foldedQueue` any more, and this dock does no A2A
  // filtering of its own either. Handing it a queue that still carries a
  // received response, even while "activeAgents" is folded, proves the dock
  // renders exactly the array it is given rather than deriving a fold of its
  // own.
  it("renders every row in the queue it is handed, including a received A2A item, regardless of the activeAgents fold", () => {
    const receivedItem = receivedAgentQueueItem(
      "received-1",
      "From another agent",
    );
    const userSentItem = queuedItem("queue-1", "From me");

    renderDock({
      folded: new Set(["activeAgents"]),
      queue: queueState([receivedItem, userSentItem]),
      todo: null,
      changes: [],
      backgroundItems: undefined,
      heldManagedCommandCount: 0,
      selfAgent: null,
      activeAgents: [],
      onBackgroundItemClick: () => undefined,
      onBackgroundItemStop: () => null,
      onBackgroundItemsStopAll: () => null,
    });

    const queueRows = screen.getByTestId("queued-message-rows");
    const previews = within(queueRows).getAllByTestId(
      "queued-message-content-preview",
    );
    const text = previews.map((preview) => preview.textContent).join(" | ");

    expect(text).toContain("From another agent");
    expect(text).toContain("From me");
  });
});

interface DockInput {
  /** The compact chips the surrounding strip context is holding, if any. */
  readonly chips?: ReadonlyArray<ChatDockCompactChipModel>;
  readonly queue: ChatSessionState["queue"];
  readonly todo: PinnedTodoSnapshot | null;
  readonly changes: ReadonlyArray<AccumulatedChangeRow>;
  readonly backgroundItems: ReadonlyArray<BackgroundItem> | undefined;
  readonly heldManagedCommandCount: number;
  readonly selfAgent: AgentRow | null;
  readonly activeAgents: ReadonlyArray<AgentRow>;
  readonly folded: ReadonlySet<ChatDockSection> | undefined;
  /** The pill whose panel is attached above the composer, if any (L-142). */
  readonly openSection?: ChatDockSection;
  readonly onBackgroundItemClick: (item: BackgroundItem) => void;
  readonly onBackgroundItemStop: (taskId: string) => string | null;
  readonly onBackgroundItemsStopAll: () => string | null;
}

/** `DEFAULT_DOCK_ORDER` as the registry holds it: today's top-to-bottom frame
 *  (Todo, then the three reorderable rows), so a user who never opens the
 *  editor sees exactly the dock they see now. The queue is not a dock region
 *  (G1-G2) and is never part of this order - it always draws fixed, last. */
const DEFAULT_DOCK_ORDER: ReadonlyArray<ChatDockSection> = [
  "todo",
  "filesChanged",
  "activeAgents",
  "background",
];

function dockHotspot(hasContent: boolean): DockRowHotspot {
  return {
    hotspotRef: () => undefined,
    // Every dock region in this suite is shown and none is materialising; only
    // `folded` and whether the row has content are what these tests are about.
    shown: true,
    hasContent,
    ghost: false,
    editing: false,
  };
}

/** Mirrors the real "has content" gates `useChatDockChrome` computes, so a
 *  fixture built from the same `DockInput` the test already passes in cannot
 *  drift from what the row would actually decide in the app. */
function dockHotspotsFor(
  input: DockInput,
): Readonly<Record<ChatDockSection, DockRowHotspot>> {
  return {
    filesChanged: dockHotspot(input.changes.length > 0),
    activeAgents: dockHotspot(
      input.activeAgents.length > 0 && input.selfAgent !== null,
    ),
    background: dockHotspot(
      (input.backgroundItems?.length ?? 0) > 0 ||
        input.heldManagedCommandCount > 0,
    ),
    todo: dockHotspot(input.todo !== null),
  };
}

/** A dock with nothing in it, for the tests that add exactly one thing. */
function emptyDock(): DockInput {
  return {
    folded: undefined,
    queue: queueState([]),
    todo: null,
    changes: [],
    backgroundItems: undefined,
    heldManagedCommandCount: 0,
    selfAgent: null,
    activeAgents: [],
    onBackgroundItemClick: () => undefined,
    onBackgroundItemStop: () => null,
    onBackgroundItemsStopAll: () => null,
  };
}

function compactChip(section: ChatDockSection): ChatDockCompactChipModel {
  return {
    section,
    glyph: section,
    hotspotRef: null,
    working: false,
    text: "1",
    lineDeltas: null,
    label: `${section} chip`,
    detail: `${section} detail`,
    pulseToken: null,
  };
}

function renderDock(input: DockInput) {
  return render(
    // The dock's background panel reads the tile's bound host to open a
    // managed command's output window, the same as it does inside a real tile.
    <TabHostProvider hostId="host-1">
      <TooltipProvider delay={0}>
        <ChatDockCompactStripProvider
          value={{
            chips: input.chips ?? [],
            openSection: input.openSection ?? null,
            panelId: "dock-panel-1",
            onToggle: () => undefined,
          }}
        >
          <ChatLowerDock
            snapshotLoaded
            epicId="epic-1"
            chatId="chat-1"
            viewTabId="tab-1"
            selfAgent={input.selfAgent}
            activeAgents={input.activeAgents}
            todo={input.todo}
            restore={baseRestore(input.changes)}
            queue={input.queue}
            folded={input.folded ?? new Set()}
            dockOrder={DEFAULT_DOCK_ORDER}
            hotspots={dockHotspotsFor(input)}
            queueResumeRequested={false}
            queueKeepPausedRequested={false}
            backgroundItems={input.backgroundItems}
            runningManagedCommandCount={0}
            heldManagedCommandCount={input.heldManagedCommandCount}
            portForwardCount={0}
            backgroundStopPendingTaskIds={new Set()}
            backgroundStopAllPending={false}
            backgroundSessionStopPending={false}
            activeTurnStatus="running"
            canAct
            readOnly={false}
            editingQueueItemId={null}
            topSpacing="normal"
            scrollRegionMaxHeightClass="max-h-96"
            onQueuePause={() => null}
            onQueueResume={() => null}
            onQueueEdit={vi.fn()}
            onQueueCancel={vi.fn()}
            onQueueAbortSteer={vi.fn()}
            onQueueReorder={vi.fn()}
            onQueueSteerNow={vi.fn()}
            onBackgroundItemClick={input.onBackgroundItemClick}
            onBackgroundItemStop={input.onBackgroundItemStop}
            onBackgroundItemsStopAll={input.onBackgroundItemsStopAll}
            onBackgroundSessionStop={() => null}
          />
        </ChatDockCompactStripProvider>
      </TooltipProvider>
    </TabHostProvider>,
  );
}

function agentRow(id: string, title: string, active: boolean): AgentRow {
  return {
    id,
    title,
    surface: "gui",
    activity: active ? "turn" : false,
    hostId: "host-1",
  };
}

function baseRestore(
  changes: ReadonlyArray<AccumulatedChangeRow>,
): ChatRestoreContextValue {
  return {
    accessRole: "owner",
    currentUserId: "owner-1",
    activeHostId: "host-1",
    activeTurnStatus: null,
    localSnapshotsClearedAt: null,
    restore: null,
    restoreActionPending: false,
    restoreCheckpoint: vi.fn().mockReturnValue(null),
    accumulatedFileChanges: changes,
    undeliveredChangeCount: 0,
    accumulatedSetComplete: true,
    revertFileChanges: vi.fn().mockReturnValue(null),
  };
}

function queueState(
  items: ReadonlyArray<ChatQueuedItem>,
): ChatSessionState["queue"] {
  return { status: "idle", items: [...items] };
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
    sender: { type: "user", userId: "owner-1" },
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

function todoSnapshot(
  items: ReadonlyArray<SegmentTodoItem>,
): PinnedTodoSnapshot {
  return { id: "todo-1", items };
}

function todoItem(text: string): SegmentTodoItem {
  return {
    id: `todo-${text}`,
    status: "in_progress",
    text,
    priority: null,
    activeForm: null,
  };
}

function fileChange(): AccumulatedChangeRow {
  return {
    filePath: "/repo/src/app.ts",
    operation: "edit",
    diffSource: "snapshot",
    reason: "snapshot",
    undoable: true,
    artifact: null,
    counts: { additions: 1, deletions: 1 },
    hasContents: true,
    digest: null,
    liveDiff: null,
  };
}
