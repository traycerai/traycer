import "../../../../../__tests__/test-browser-apis";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { CommGraphThreadPanel } from "@/components/epic-canvas/comm-graph/comm-graph-thread-panel";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import { aggregateCommGraphEdges } from "@/lib/comm-graph/comm-graph-model";
import { useCommGraphRowOpenStore } from "@/stores/epics/comm-graph-row-open-store";
import {
  DEFAULT_COMM_GRAPH_PANEL_WIDTH_PX,
  useCommGraphPanelStore,
} from "@/stores/epics/comm-graph-panel-store";
import { TooltipProvider } from "@/components/ui/tooltip";

function event(
  overrides: Partial<CommGraphEvent> & {
    readonly id: number;
    readonly timestamp: number;
  },
): CommGraphEvent {
  return {
    hostId: "host-a",
    kind: "a2a_message",
    senderAgentId: "a",
    receiverAgentId: "b",
    responseId: "r1",
    inReplyTo: null,
    expectReply: false,
    messageText: "hello",
    noticeReason: null,
    originKind: null,
    originChatId: null,
    originRefId: null,
    ...overrides,
  };
}

const AGENT_NAMES: ReadonlyMap<string, string> = new Map([
  ["a", "Orchestrator"],
  ["b", "Reviewer"],
]);

interface PanelHandles {
  readonly onClose: Mock<() => void>;
  readonly onJump: Mock<(event: CommGraphEvent) => void>;
  readonly onJumpToSender: Mock<(event: CommGraphEvent) => void>;
  readonly onJumpToCreated: Mock<(event: CommGraphEvent) => void>;
  readonly onOpenAgentId: Mock<(agentId: string) => void>;
}

/** Which per-kind jump capabilities the rendered panel advertises. */
interface PanelCapabilities {
  readonly plainOpen: boolean;
  readonly senderJump: boolean;
  readonly createdJump: boolean;
}

const NO_EXTRA_JUMPS: PanelCapabilities = {
  plainOpen: true,
  senderJump: false,
  createdJump: false,
};

function renderPanelWithHandles(
  events: ReadonlyArray<CommGraphEvent>,
  canJump: boolean,
): PanelHandles {
  return renderPanelWithCapabilities(events, canJump, NO_EXTRA_JUMPS);
}

function renderPanelWithSenderJump(
  events: ReadonlyArray<CommGraphEvent>,
  canJump: boolean,
  canJumpToSender: boolean,
): PanelHandles {
  return renderPanelWithCapabilities(events, canJump, {
    ...NO_EXTRA_JUMPS,
    senderJump: canJumpToSender,
  });
}

function renderPanelWithCapabilities(
  events: ReadonlyArray<CommGraphEvent>,
  canJump: boolean,
  capabilities: PanelCapabilities,
): PanelHandles {
  const onClose = vi.fn<() => void>();
  const onJump = vi.fn<(event: CommGraphEvent) => void>();
  const onJumpToSender = vi.fn<(event: CommGraphEvent) => void>();
  const onJumpToCreated = vi.fn<(event: CommGraphEvent) => void>();
  const onOpenAgentId = vi.fn<(agentId: string) => void>();
  const [edge] = aggregateCommGraphEdges(events, new Set(["a", "b"]));
  render(
    <TooltipProvider>
      <CommGraphThreadPanel
        edge={edge}
        epicId="epic-1"
        agentNames={AGENT_NAMES}
        canOpenAgentForEvent={() => capabilities.plainOpen}
        canJump={() => canJump}
        onJump={onJump}
        canJumpToSender={(event) =>
          capabilities.senderJump && event.kind === "a2a_message"
        }
        onJumpToSender={onJumpToSender}
        canJumpToCreated={(event) =>
          capabilities.createdJump && event.kind === "agent_created"
        }
        onJumpToCreated={onJumpToCreated}
        onOpenAgentId={onOpenAgentId}
        onClose={onClose}
      />
    </TooltipProvider>,
  );
  return {
    onClose,
    onJump,
    onJumpToSender,
    onJumpToCreated,
    onOpenAgentId,
  };
}

function renderPanel(events: ReadonlyArray<CommGraphEvent>): () => void {
  const onClose = vi.fn();
  const [edge] = aggregateCommGraphEdges(events, new Set(["a", "b"]));
  render(
    // The app mounts one of these at its root (`traycer-app.tsx`), so the panel
    // never renders without it in production - this supplies the real context
    // to a panel rendered in isolation, it does not stub anything out.
    <TooltipProvider>
      <CommGraphThreadPanel
        edge={edge}
        epicId="epic-1"
        agentNames={AGENT_NAMES}
        canOpenAgentForEvent={() => true}
        canJump={() => false}
        onJump={() => undefined}
        canJumpToSender={() => false}
        onJumpToSender={() => undefined}
        canJumpToCreated={() => false}
        onJumpToCreated={() => undefined}
        onOpenAgentId={() => undefined}
        onClose={onClose}
      />
    </TooltipProvider>,
  );
  return onClose;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // Row expansion is module-global and keyed by `hostId:id`, which every test
  // here reuses - leave it set and the next test starts pre-expanded.
  useCommGraphRowOpenStore.setState({ openRowKeysByEpicId: {} });
  // The panel width is module-global and persisted; a width committed by one
  // test must not leak into the next.
  useCommGraphPanelStore.setState({
    panelWidthPx: DEFAULT_COMM_GRAPH_PANEL_WIDTH_PX,
  });
});

function messageRows(): ReadonlyArray<HTMLElement> {
  return screen.getAllByTestId(/^comm-graph-detail-row-/u);
}

describe("CommGraphThreadPanel", () => {
  it("lists every contributing row uncollapsed, in capture order", async () => {
    renderPanel([
      event({ id: 1, timestamp: 100, messageText: "first" }),
      event({ id: 2, timestamp: 200, messageText: "second" }),
    ]);

    await screen.findByTestId("comm-graph-detail-row-host-a-1");
    const rows = messageRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("first");
    expect(rows[1].textContent).toContain("second");
  });

  it("keeps reused cloud origin sequences as distinct rows and open state", async () => {
    renderPanel([
      event({
        id: 1,
        eventId: "cloud-before-repair",
        timestamp: 100,
        messageText: "first\n\nbody",
      }),
      event({
        id: 1,
        eventId: "cloud-after-repair",
        timestamp: 200,
        messageText: "second\n\nbody",
      }),
    ]);

    const toggles = await screen.findAllByRole("button", {
      name: "Expand message",
    });
    expect(toggles).toHaveLength(2);
    const [firstToggle, secondToggle] = toggles;
    expect(messageRows()).toHaveLength(2);
    expect(firstToggle.getAttribute("aria-label")).toBe("Expand message");
    expect(secondToggle.getAttribute("aria-label")).toBe("Expand message");

    fireEvent.click(firstToggle);
    expect(firstToggle.getAttribute("aria-label")).toBe("Collapse message");
    expect(secondToggle.getAttribute("aria-label")).toBe("Expand message");
  });

  it("interleaves BOTH directions chronologically and labels every row", async () => {
    // The canvas edge is undirected now, so this list is the only place
    // direction is expressed - it has to carry that weight on every row.
    renderPanel([
      event({ id: 1, timestamp: 100, messageText: "ask" }),
      event({
        id: 2,
        timestamp: 200,
        senderAgentId: "b",
        receiverAgentId: "a",
        inReplyTo: "r1",
        messageText: "answer",
      }),
      event({ id: 3, timestamp: 300, messageText: "follow-up" }),
    ]);

    await screen.findByTestId("comm-graph-detail-row-host-a-1");
    const rows = messageRows();
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("ask"),
      expect.stringContaining("answer"),
      expect.stringContaining("follow-up"),
    ]);
    // Each row names its own direction, not the pair's - so the reply reads
    // `Reviewer → Orchestrator` even though it sits on the same edge.
    expect(rows[0].textContent).toMatch(/Orchestrator[\s\S]*Reviewer/u);
    expect(rows[1].textContent).toMatch(/Reviewer[\s\S]*Orchestrator/u);
  });

  it("labels requests, replies, and expect-reply sends", () => {
    renderPanel([
      event({ id: 1, timestamp: 100, expectReply: true }),
      event({ id: 2, timestamp: 200, inReplyTo: "r1" }),
    ]);

    expect(screen.getByText("Request")).toBeDefined();
    expect(screen.getByText("Reply")).toBeDefined();
    expect(screen.getByText("expects reply")).toBeDefined();
  });

  it("renders a created row with its own chip, pointing creator → child", () => {
    renderPanel([
      event({
        id: 1,
        timestamp: 100,
        kind: "agent_created",
        responseId: null,
        expectReply: null,
        messageText: null,
      }),
    ]);

    expect(screen.getByText("Created")).toBeDefined();
    // Lineage points the way the spawn happened: creator → the new agent.
    const row = screen.getByTestId("comm-graph-detail-row-host-a-1");
    expect(row.textContent).toMatch(/Orchestrator[\s\S]*Reviewer/u);
  });

  it("renders a known notice reason as a label", () => {
    renderPanel([
      event({
        id: 1,
        timestamp: 100,
        kind: "a2a_notice",
        noticeReason: "turn-ended",
        messageText: "receiver went idle",
      }),
    ]);

    expect(screen.getByText("Turn ended")).toBeDefined();
  });

  it("shows a notice travelling back to the agent awaiting the reply", () => {
    renderPanel([
      event({
        id: 1,
        timestamp: 100,
        kind: "a2a_notice",
        noticeReason: "turn-ended",
        messageText: "receiver went idle",
      }),
    ]);

    const row = screen.getByTestId("comm-graph-detail-row-host-a-1");
    expect(row.textContent).toMatch(/Reviewer[\s\S]*Orchestrator/u);
  });

  it("renders an UNKNOWN notice reason raw instead of dropping the row", () => {
    // `noticeReason` is an open string by contract: the broker's reason set is
    // host-owned and grows, and this log is historical.
    renderPanel([
      event({
        id: 1,
        timestamp: 100,
        kind: "a2a_notice",
        noticeReason: "some-future-reason",
        messageText: "detail",
      }),
    ]);

    expect(screen.getByText("some-future-reason")).toBeDefined();
    expect(screen.getByText("detail")).toBeDefined();
  });

  it("offers expansion when a short preview is visually clamped", async () => {
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(48);
    const clientHeight = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(32);

    renderPanel([
      event({
        id: 1,
        timestamp: 100,
        messageText: "A short source string that wraps in a narrow panel.",
      }),
    ]);

    expect(
      await screen.findByTestId("comm-graph-detail-toggle-host-a-1"),
    ).toBeDefined();
    expect(
      screen.getByTestId("comm-graph-detail-row-host-a-1").dataset.collapsible,
    ).toBe("true");

    scrollHeight.mockRestore();
    clientHeight.mockRestore();
  });

  it("is resizable: persisted width applied, keyboard mirrored, reset on double-click", () => {
    renderPanel([event({ id: 1, timestamp: 100 })]);

    const panel = document.querySelector<HTMLElement>(
      "[data-comm-graph-detail-panel]",
    );
    expect(panel?.style.width).toBe(`${DEFAULT_COMM_GRAPH_PANEL_WIDTH_PX}px`);

    // Right-docked panel: ArrowLeft GROWS it (the drag axis is mirrored
    // against the epic sidebar's left-docked handle).
    const handle = screen.getByTestId("comm-graph-detail-resize-handle");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(panel?.style.width).toBe(
      `${DEFAULT_COMM_GRAPH_PANEL_WIDTH_PX + 24}px`,
    );
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(panel?.style.width).toBe(`${DEFAULT_COMM_GRAPH_PANEL_WIDTH_PX}px`);

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    fireEvent.dblClick(handle);
    expect(panel?.style.width).toBe(`${DEFAULT_COMM_GRAPH_PANEL_WIDTH_PX}px`);
    expect(useCommGraphPanelStore.getState().panelWidthPx).toBe(
      DEFAULT_COMM_GRAPH_PANEL_WIDTH_PX,
    );
  });

  it("closes on the close control", async () => {
    const onClose = renderPanel([event({ id: 1, timestamp: 100 })]);

    await userEvent.click(
      screen.getByRole("button", { name: "Close details" }),
    );

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

/**
 * Message bodies are markdown here, and this panel is epic-scoped across hosts -
 * it has no workspace to resolve a relative path against.
 */
describe("CommGraphThreadPanel markdown bodies", () => {
  it("renders an agent's markdown rather than raw text", async () => {
    renderPanel([
      event({ id: 1, timestamp: 100, messageText: "## Plan\n\n- one\n- two" }),
    ]);

    // Multi-block, so the row starts collapsed - expand before reading it.
    fireEvent.click(
      await screen.findByTestId("comm-graph-detail-toggle-host-a-1"),
    );

    const body = await screen.findByTestId("comm-graph-detail-body-host-a-1");
    expect(body.querySelector("h2")).not.toBeNull();
    expect(body.querySelectorAll("li")).toHaveLength(2);
  });

  it("renders a file link as visibly unresolvable, not as a dead link", async () => {
    // Chat resolves these against its own worktree roots. This panel cannot -
    // the path belongs to whichever agent sent it, on whichever host - so a
    // live-looking anchor that silently swallows the click is the one thing it
    // must not render.
    renderPanel([
      event({
        id: 1,
        timestamp: 100,
        // Multiline so the row is collapsible - the framed markdown body only
        // exists once expanded now.
        messageText: "see [source](./src/a.ts) for detail\n\nsecond block",
      }),
    ]);

    fireEvent.click(
      await screen.findByTestId("comm-graph-detail-toggle-host-a-1"),
    );
    const body = await screen.findByTestId("comm-graph-detail-body-host-a-1");
    expect(body.querySelector("a")).toBeNull();
    const marked = screen.getByTestId("comm-graph-unresolvable-link");
    // The text survives - a reader can still see and copy the path.
    expect(marked.textContent).toBe("source");
  });

  it("leaves external links clickable - those it CAN open", async () => {
    renderPanel([
      event({
        id: 1,
        timestamp: 100,
        messageText: "see [docs](https://example.com/x)\n\nsecond block",
      }),
    ]);

    fireEvent.click(
      await screen.findByTestId("comm-graph-detail-toggle-host-a-1"),
    );
    const body = await screen.findByTestId("comm-graph-detail-body-host-a-1");
    expect(body.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/x",
    );
  });
});

/**
 * BOTH endpoints in the heading are reachable, and they do different things
 * because the log supports different things: origin refs are receiver-side, so
 * only the receiver has an anchor to scroll to.
 */
describe("CommGraphThreadPanel heading links", () => {
  const ROW = "comm-graph-detail-host-a-1";

  /**
   * The scroll claim needs a real in-transcript anchor, not merely a jumpable
   * row - `canJump` is also true for rows whose jump degrades to a plain tile
   * open. These are the receiver-side origin fields the capture path writes.
   */
  const ANCHORED = {
    originKind: "gui_message",
    originChatId: "b",
    originRefId: "agent-msg-1",
  } as const;

  it("jumps to the delivered message from the RECEIVER name", async () => {
    const handles = renderPanelWithHandles(
      [event({ id: 1, timestamp: 100, ...ANCHORED })],
      true,
    );

    fireEvent.click(await screen.findByTestId(`${ROW}-receiver`));

    expect(handles.onJump).toHaveBeenCalledTimes(1);
    expect(handles.onOpenAgentId).not.toHaveBeenCalled();
  });

  it("does not render a redundant jump control beside the endpoint links", async () => {
    renderPanelWithHandles([event({ id: 1, timestamp: 100 })], true);

    await screen.findByTestId(`${ROW}-receiver`);
    expect(screen.queryByRole("button", { name: "Open source" })).toBeNull();
  });

  it("jumps the SENDER name to its own Sent-message card when resolvable", async () => {
    // The endpoint readers reach for first. No captured anchor exists for the
    // sender side, so the claim comes from the sender-jump capability (a
    // projected GUI chat whose transcript can resolve the send at jump time).
    const handles = renderPanelWithSenderJump(
      [event({ id: 1, timestamp: 100, ...ANCHORED })],
      true,
      true,
    );

    const sender = await screen.findByTestId(`${ROW}-sender`);
    expect(sender.getAttribute("aria-label")).toBe(
      "Open Orchestrator and scroll to this message",
    );
    fireEvent.click(sender);
    expect(handles.onJumpToSender).toHaveBeenCalledTimes(1);
    expect(handles.onOpenAgentId).not.toHaveBeenCalled();
    // The receiver keeps its own captured-anchor jump, untouched.
    fireEvent.click(screen.getByTestId(`${ROW}-receiver`));
    expect(handles.onJump).toHaveBeenCalledTimes(1);
  });

  it("opens the SENDER's tile with no jump, because it has no anchor", async () => {
    const handles = renderPanelWithHandles(
      [event({ id: 1, timestamp: 100, ...ANCHORED })],
      true,
    );

    fireEvent.click(await screen.findByTestId(`${ROW}-sender`));

    // Deliberately NOT a jump: the sender's transcript carries no captured
    // anchor, and scrolling somewhere approximate would be a fiction.
    expect(handles.onOpenAgentId).toHaveBeenCalledWith("a");
    expect(handles.onJump).not.toHaveBeenCalled();
  });

  it("does not render host-local endpoints when plain opening is unavailable", async () => {
    const handles = renderPanelWithCapabilities(
      [event({ id: 1, timestamp: 100 })],
      false,
      { ...NO_EXTRA_JUMPS, plainOpen: false },
    );

    await screen.findByTestId("comm-graph-detail-row-host-a-1");
    expect(screen.queryByTestId(`${ROW}-sender`)).toBeNull();
    expect(screen.queryByTestId(`${ROW}-receiver`)).toBeNull();
    expect(handles.onOpenAgentId).not.toHaveBeenCalled();
  });

  it("names both endpoints accessibly, and says which one scrolls", async () => {
    renderPanelWithHandles(
      [event({ id: 1, timestamp: 100, ...ANCHORED })],
      true,
    );

    expect(
      (await screen.findByTestId(`${ROW}-sender`)).getAttribute("aria-label"),
    ).toBe("Open Orchestrator");
    expect(
      screen.getByTestId(`${ROW}-receiver`).getAttribute("aria-label"),
    ).toBe("Open Reviewer and scroll to this message");
  });

  it("puts an anchored NOTICE's scroll claim on the waiting sender's endpoint", async () => {
    // A notice anchors in the DB SENDER's transcript (the waiting agent it
    // was delivered to), which the reversed direction projection displays as
    // the arrow's receiver. The claim must follow the anchor's chat, not a
    // fixed side.
    const handles = renderPanelWithHandles(
      [
        event({
          id: 1,
          timestamp: 100,
          kind: "a2a_notice",
          noticeReason: "turn-ended",
          originKind: "gui_message",
          originChatId: "a",
          originRefId: "agent-msg-notice-1",
        }),
      ],
      true,
    );

    // Displayed receiver = DB sender "a" (Orchestrator): anchored, jumps.
    const receiver = await screen.findByTestId(`${ROW}-receiver`);
    expect(receiver.getAttribute("aria-label")).toBe(
      "Open Orchestrator and scroll to this message",
    );
    fireEvent.click(receiver);
    expect(handles.onJump).toHaveBeenCalledTimes(1);

    // Displayed sender = DB receiver "b" (Reviewer): a plain open.
    const sender = screen.getByTestId(`${ROW}-sender`);
    expect(sender.getAttribute("aria-label")).toBe("Open Reviewer");
    fireEvent.click(sender);
    expect(handles.onOpenAgentId).toHaveBeenCalledWith("b");
  });

  it("jumps a Created row's child to its start; the creator is a plain open", async () => {
    const handles = renderPanelWithCapabilities(
      [
        event({
          id: 1,
          timestamp: 100,
          kind: "agent_created",
          responseId: null,
          expectReply: null,
          messageText: null,
        }),
      ],
      true,
      { ...NO_EXTRA_JUMPS, createdJump: true },
    );

    // The created agent (arrow's receiver) lands at its transcript's start.
    const receiver = await screen.findByTestId(`${ROW}-receiver`);
    expect(receiver.getAttribute("aria-label")).toBe(
      "Open Reviewer and scroll to the start",
    );
    fireEvent.click(receiver);
    expect(handles.onJumpToCreated).toHaveBeenCalledTimes(1);

    // The creator stays reachable but claims nothing: its create call has no
    // resolvable anchor, so it is a plain tile open.
    const sender = screen.getByTestId(`${ROW}-sender`);
    expect(sender.getAttribute("aria-label")).toBe("Open Orchestrator");
    fireEvent.click(sender);
    expect(handles.onOpenAgentId).toHaveBeenCalledWith("a");
    expect(handles.onJump).not.toHaveBeenCalled();
  });

  it("opens a Notice row's idle agent plainly - it anchors on nothing", async () => {
    // The idle agent (arrow's sender after the notice reversal) never WROTE
    // this notice: the broker observed it going quiet. Nothing in its
    // transcript is the row, so the endpoint is the same generic open a
    // Created row's creator gets - it must not claim a landing.
    const handles = renderPanelWithHandles(
      [
        event({
          id: 1,
          timestamp: 100,
          kind: "a2a_notice",
          noticeReason: "awaiting-input",
          messageText: "waiting on approval",
        }),
      ],
      false,
    );

    // Displayed sender = DB receiver "b" (Reviewer), the idle agent.
    const sender = await screen.findByTestId(`${ROW}-sender`);
    expect(sender.getAttribute("aria-label")).toBe("Open Reviewer");
    fireEvent.click(sender);
    expect(handles.onOpenAgentId).toHaveBeenCalledWith("b");
    expect(handles.onJump).not.toHaveBeenCalled();
  });

  it("claims no scroll on an anchor-less row - the tile opens, honestly", async () => {
    // A jumpable row whose origin was never captured (every notice today).
    // Its jump would degrade to a plain tile open, so labeling the endpoint
    // "scroll to this message" would promise a landing that never happens -
    // the exact live symptom this pins: click, no scroll, no highlight.
    const handles = renderPanelWithHandles(
      [event({ id: 1, timestamp: 100 })],
      true,
    );

    const receiver = await screen.findByTestId(`${ROW}-receiver`);
    expect(receiver.getAttribute("aria-label")).toBe("Open Reviewer");

    fireEvent.click(receiver);
    expect(handles.onOpenAgentId).toHaveBeenCalledWith("b");
    expect(handles.onJump).not.toHaveBeenCalled();
  });

  it("opens the receiver tile when the row has no captured jump", async () => {
    const handles = renderPanelWithHandles(
      [event({ id: 1, timestamp: 100 })],
      false,
    );

    fireEvent.click(await screen.findByTestId(`${ROW}-receiver`));
    expect(handles.onOpenAgentId).toHaveBeenCalledWith("b");
    expect(handles.onJump).not.toHaveBeenCalled();
  });

  /**
   * The heading's names are buttons now, so the collapse control had to leave
   * the header: a button inside a button is invalid and unusable by assistive
   * tech. The chevron is its own labelled control.
   */
  it("keeps the collapse control out of the heading", async () => {
    renderPanelWithHandles(
      [event({ id: 1, timestamp: 100, messageText: "a\n\nb" })],
      true,
    );

    const toggle = await screen.findByTestId(
      "comm-graph-detail-toggle-host-a-1",
    );
    expect(toggle.getAttribute("aria-label")).toBe("Expand message");
    expect(toggle.querySelector("button")).toBeNull();
    expect(toggle.contains(screen.getByTestId(`${ROW}-sender`))).toBe(false);
  });
});
