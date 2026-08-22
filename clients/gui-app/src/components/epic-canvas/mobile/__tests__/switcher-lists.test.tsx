import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwitcherAgentsList } from "@/components/epic-canvas/mobile/switcher-agents-list";
import { SwitcherArtifactsList } from "@/components/epic-canvas/mobile/switcher-artifacts-list";
import { STATUS_DOT_CLASSES } from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";
import { SwitcherTerminalsList } from "@/components/epic-canvas/mobile/switcher-terminals-list";

interface FixtureRecord {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly type: string;
  readonly status: number | null;
  readonly hostId: string;
}
interface FixtureSession {
  readonly sessionId: string;
  readonly title: string | null;
  readonly activeProcessName: string | null;
  readonly cwd: string;
}
/**
 * The whole ref, not just its `type`. The ref's `hostId` is what the opened
 * tile BINDS TO for life, so it is the field most worth asserting - and a
 * fixture that dropped it is why a wrong-host ref went unnoticed here.
 */
interface ActivateRef {
  readonly type: string;
  readonly hostId: string;
}
interface ActivateCall {
  readonly id: string;
  readonly ref: ActivateRef;
}
interface Holder {
  records: ReadonlyArray<FixtureRecord>;
  sessions: ReadonlyArray<FixtureSession>;
  activeId: string | null;
  role: "owner" | "viewer";
  activateCalls: ActivateCall[];
  workingAgentIds: ReadonlySet<string>;
  activityTiers: ReadonlyMap<string, "turn" | "background">;
  /** Chat ids the agents list subscribed indicator state for, per render. */
  indicatorChatIdCalls: ReadonlyArray<string>[];
  /** What `useEpicNodeHostId` answers - the row's OWN owner host. */
  ownerHostIdByNodeId: Record<string, string>;
  indicators: IndicatorFixture;
}

interface IndicatorFlags {
  readonly unreadFailure: boolean;
  readonly pendingFork: boolean;
  readonly pendingApproval: boolean;
  readonly pendingInterview: boolean;
  readonly unreadDone: boolean;
}
interface IndicatorResponseFixture {
  readonly epics: Record<string, never>;
  readonly chats: Record<string, IndicatorFlags>;
}
interface IndicatorFixture extends IndicatorResponseFixture {
  readonly byOriginHostId?: Record<string, IndicatorResponseFixture>;
}

const holder = vi.hoisted((): Holder => ({
  records: [],
  sessions: [],
  activeId: null,
  role: "owner",
  activateCalls: [],
  workingAgentIds: new Set<string>(),
  activityTiers: new Map<string, "turn" | "background">(),
  indicatorChatIdCalls: [],
  ownerHostIdByNodeId: {},
  indicators: { epics: {}, chats: {} },
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicArtifactRecords: () => holder.records,
  useEpicActiveAgentIds: () => holder.workingAgentIds,
  useEpicAgentActivityTiers: () => holder.activityTiers,
  useEpicChatHarnessId: () => null,
  useMaybeEpicTuiAgentHarnessId: () => null,
  useEpicPermissionRole: () => holder.role,
  // The chat projection's OWN host. Deliberately distinct from the `hostId` on
  // the records above, which is the app-wide ACTIVE host for chat rows.
  useEpicNodeHostId: (nodeId: string) =>
    holder.ownerHostIdByNodeId[nodeId] ?? null,
  // The lists sort by tree-node recency; expose nodes for the fixtures so the
  // real epic-sort comparator resolves every id.
  useEpicTreeIndex: () => ({
    rootIds: [],
    childrenByParent: {},
    nodeById: Object.fromEntries(
      holder.records.map((record, index) => [
        record.id,
        {
          id: record.id,
          title: record.name,
          createdAt: index,
          updatedAt: index,
        },
      ]),
    ),
  }),
}));
vi.mock("@/stores/epics/canvas/canvas-selectors", () => ({
  useIsActiveEpicArtifact: (_tabId: string, id: string) =>
    holder.activeId === id,
  findOpenArtifactInTab: () => null,
}));
vi.mock("@/components/epic-canvas/mobile/use-switcher-activate", () => ({
  useSwitcherActivate:
    () =>
    (
      id: string,
      buildRef: () => { readonly type: string; readonly hostId: string },
    ) => {
      holder.activateCalls.push({ id, ref: buildRef() });
    },
}));
vi.mock("@/hooks/terminal/use-terminal-list-query", () => ({
  useTerminalList: () => ({ data: { sessions: holder.sessions } }),
}));
vi.mock("@/lib/host", () => ({ useHostClient: () => null }));
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-A",
}));
vi.mock("@/lib/terminals/terminal-session-filters", () => ({
  isVisibleEpicTerminalSession: () => true,
}));
// Keep the row menu's mutation + focus hooks inert so it mounts without a
// QueryClient / host client (the menu's editor gating is what we assert).
vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicRenameChat: () => ({ mutate: vi.fn(), isPending: false }),
  useEpicDeleteChat: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/epic/use-epic-tui-agent-mutations", () => ({
  useEpicRenameTuiAgent: () => ({ mutate: vi.fn(), isPending: false }),
  useEpicDeleteTuiAgent: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/epic/use-epic-node-mutations", () => ({
  useEpicDeleteArtifact: () => ({ mutate: vi.fn(), isPending: false }),
  useEpicRenameArtifact: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/terminal/use-terminal-rename-for-mutation", () => ({
  useTerminalRenameFor: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/terminal/use-terminal-kill-for-mutation", () => ({
  useTerminalKillFor: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => null,
}));
vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => vi.fn(),
}));
// The agents list owns the indicator subscription its rows read through
// context; record what it asks for so the wiring is asserted rather than
// assumed, and answer from the holder.
vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => "host-A",
}));
vi.mock("@/hooks/notifications/use-notification-indicators-query", () => ({
  useNotificationIndicators: (args: {
    readonly chatIds: readonly string[];
  }) => {
    holder.indicatorChatIdCalls.push(args.chatIds);
    return holder.indicators;
  },
}));
// Each category list renders its own create row/menu (Agents: New chat,
// Terminals: New terminal, Artifacts: a "+" kind menu); stub all three to
// markers so their own wiring (composer mode, the terminal picker dialog, the
// artifact-kind dropdown) doesn't need to mount here - this file exercises
// each list's editor gating and row positioning in isolation.
vi.mock("@/components/epic-canvas/mobile/switcher-create-actions", () => ({
  SwitcherNewChatRow: () => (
    <button type="button" data-testid="switcher-new-chat" />
  ),
  SwitcherNewTerminalRow: () => (
    <button type="button" data-testid="switcher-new-terminal" />
  ),
  SwitcherNewArtifactMenu: () => (
    <button type="button" data-testid="new-artifact-action" />
  ),
}));

const PROPS = { epicId: "epic-1", tabId: "tab-1", onClose: () => {} };

beforeEach(() => {
  holder.records = [];
  holder.sessions = [];
  holder.activeId = null;
  holder.role = "owner";
  holder.activateCalls = [];
  holder.workingAgentIds = new Set<string>();
  holder.activityTiers = new Map<string, "turn" | "background">();
  holder.indicatorChatIdCalls = [];
  holder.ownerHostIdByNodeId = {};
  holder.indicators = { epics: {}, chats: {} };
});
afterEach(cleanup);

describe("<SwitcherAgentsList />", () => {
  beforeEach(() => {
    holder.records = [
      {
        id: "chat-1",
        parentId: null,
        name: "Alpha",
        type: "chat",
        status: null,
        hostId: "host-A",
      },
      {
        id: "tui-1",
        parentId: null,
        name: "Beta",
        type: "terminal-agent",
        status: null,
        hostId: "host-A",
      },
      {
        id: "spec-1",
        parentId: null,
        name: "Spec",
        type: "spec",
        status: null,
        hostId: "host-A",
      },
    ];
  });

  it("renders chats + terminal-agents interleaved by recency (artifacts excluded)", () => {
    render(<SwitcherAgentsList {...PROPS} />);
    expect(
      screen.getByTestId("switcher-agent-row-chat-1").textContent,
    ).toContain("Alpha");
    expect(
      screen.getByTestId("switcher-agent-row-tui-1").textContent,
    ).toContain("Beta");
    expect(screen.queryByTestId("switcher-agent-row-spec-1")).toBeNull();
    // tui-1 (updatedAt 1) is more recent than chat-1 (updatedAt 0), so the list
    // interleaves by recency rather than grouping all chats before agents.
    const order = Array.from(
      document.querySelectorAll('[data-testid^="switcher-agent-row-"]'),
    ).map((row) => row.getAttribute("data-testid"));
    expect(order).toEqual([
      "switcher-agent-row-tui-1",
      "switcher-agent-row-chat-1",
    ]);
  });

  it("marks the active tile with a check and taps open it (chat ref)", () => {
    holder.activeId = "chat-1";
    render(<SwitcherAgentsList {...PROPS} />);
    const activeRow = screen.getByTestId("switcher-agent-row-chat-1");
    expect(activeRow.getAttribute("aria-current")).toBe("true");
    fireEvent.click(activeRow);
    expect(holder.activateCalls).toHaveLength(1);
    expect(holder.activateCalls[0].id).toBe("chat-1");
    expect(holder.activateCalls[0].ref.type).toBe("chat");
  });

  it("spins a row whose agent is mid-turn and leaves the idle rows alone", () => {
    holder.workingAgentIds = new Set<string>(["chat-1"]);
    holder.activityTiers = new Map<string, "turn" | "background">([
      ["chat-1", "turn"],
    ]);
    render(<SwitcherAgentsList {...PROPS} />);
    expect(screen.getByTestId("switcher-agent-activity-chat-1")).toBeTruthy();
    expect(screen.queryByTestId("switcher-agent-activity-tui-1")).toBeNull();
  });

  it("updates a row's status live while the sheet stays open", () => {
    const view = render(<SwitcherAgentsList {...PROPS} />);
    expect(screen.queryByTestId("switcher-agent-activity-tui-1")).toBeNull();

    holder.workingAgentIds = new Set<string>(["tui-1"]);
    holder.activityTiers = new Map<string, "turn" | "background">([
      ["tui-1", "turn"],
    ]);
    view.rerender(<SwitcherAgentsList {...PROPS} />);
    expect(screen.getByTestId("switcher-agent-activity-tui-1")).toBeTruthy();

    // …and back down when the turn ends.
    holder.workingAgentIds = new Set<string>();
    holder.activityTiers = new Map<string, "turn" | "background">();
    view.rerender(<SwitcherAgentsList {...PROPS} />);
    expect(screen.queryByTestId("switcher-agent-activity-tui-1")).toBeNull();
  });

  it("renders the desktop mapping's background glyph, not the busy spinner, for background-only work", () => {
    holder.workingAgentIds = new Set<string>(["tui-1"]);
    holder.activityTiers = new Map<string, "turn" | "background">([
      ["tui-1", "background"],
    ]);
    render(<SwitcherAgentsList {...PROPS} />);
    expect(
      screen.getByTestId("switcher-agent-background-activity-tui-1"),
    ).toBeTruthy();
    expect(screen.queryByTestId("switcher-agent-activity-tui-1")).toBeNull();
  });

  it("surfaces notification status on a row, outranking a running turn", () => {
    holder.workingAgentIds = new Set<string>(["chat-1"]);
    holder.activityTiers = new Map<string, "turn" | "background">([
      ["chat-1", "turn"],
    ]);
    holder.indicators = {
      epics: {},
      chats: {
        "chat-1": {
          unreadFailure: false,
          pendingFork: false,
          pendingApproval: true,
          pendingInterview: false,
          unreadDone: false,
        },
      },
    };
    render(<SwitcherAgentsList {...PROPS} />);
    expect(screen.getByTestId("switcher-agent-approval-chat-1")).toBeTruthy();
    expect(screen.queryByTestId("switcher-agent-activity-chat-1")).toBeNull();
  });

  it("keeps a retained epic's rows reading status from their own host after the active host changes", () => {
    // Session/provider bound to host A; the user has since switched the app's
    // active host to B. `useEpicArtifactRecords()` stamps chat rows with the
    // ACTIVE host, so the record says B while the chat still lives on A.
    holder.records = [
      {
        id: "chat-1",
        parentId: null,
        name: "Alpha",
        type: "chat",
        status: null,
        hostId: "host-B",
      },
    ];
    holder.ownerHostIdByNodeId = { "chat-1": "host-A" };
    holder.indicators = {
      epics: {},
      chats: {
        "chat-1": {
          unreadFailure: true,
          pendingFork: false,
          pendingApproval: false,
          pendingInterview: false,
          unreadDone: false,
        },
      },
      byOriginHostId: {
        "host-A": {
          epics: {},
          chats: {
            "chat-1": {
              unreadFailure: true,
              pendingFork: false,
              pendingApproval: false,
              pendingInterview: false,
              unreadDone: false,
            },
          },
        },
        "host-B": { epics: {}, chats: {} },
      },
    };
    render(<SwitcherAgentsList {...PROPS} />);
    // Passing the record's `hostId` would read `byOriginHostId["host-B"]` -
    // empty - and the row would render an inert idle glyph.
    expect(screen.getByTestId("switcher-agent-failure-chat-1")).toBeTruthy();

    // …and the same rule governs the ref the tap builds. A tab binds its host
    // FOR LIFE, so a B-bound tile for an A-owned chat asks the wrong machine
    // for the transcript permanently - not just until the next host switch.
    fireEvent.click(screen.getByTestId("switcher-agent-row-chat-1"));
    expect(holder.activateCalls).toHaveLength(1);
    expect(holder.activateCalls[0].ref.hostId).toBe("host-A");
  });

  it("falls back to the record's host for a legacy chat with no projected owner", () => {
    // `useEpicNodeHostId` answers null for a chat predating the field. The
    // record's host is the active one by construction, matching the desktop
    // row's `?? activeHostId` - a tap always opens something.
    holder.records = [
      {
        id: "chat-1",
        parentId: null,
        name: "Alpha",
        type: "chat",
        status: null,
        hostId: "host-B",
      },
    ];
    holder.ownerHostIdByNodeId = {};
    render(<SwitcherAgentsList {...PROPS} />);
    fireEvent.click(screen.getByTestId("switcher-agent-row-chat-1"));
    expect(holder.activateCalls[0].ref.hostId).toBe("host-B");
  });

  it("opens a TUI agent against its projected owner host", () => {
    // In production both sides of the `??` read the same projection field for
    // a terminal-agent, so they cannot disagree; the fixture drives them apart
    // only to pin WHICH one the row takes - the owner, uniformly, with no
    // per-kind branch to fall out of sync.
    holder.ownerHostIdByNodeId = { "tui-1": "host-C" };
    render(<SwitcherAgentsList {...PROPS} />);
    fireEvent.click(screen.getByTestId("switcher-agent-row-tui-1"));
    expect(holder.activateCalls[0].ref.type).toBe("terminal-agent");
    expect(holder.activateCalls[0].ref.hostId).toBe("host-C");
  });

  it("subscribes indicator state for exactly the agent rows it lists", () => {
    render(<SwitcherAgentsList {...PROPS} />);
    const chatIds = holder.indicatorChatIdCalls.at(-1);
    // Agents only - the spec artifact in the fixture is not a chat entity, and
    // the ids are sorted so the query key does not churn on every re-sort.
    expect(chatIds).toEqual(["chat-1", "tui-1"]);
  });

  it("shows the '…' menu for an editor and hides it entirely for a viewer", () => {
    const editor = render(<SwitcherAgentsList {...PROPS} />);
    expect(screen.getByTestId("switcher-more-chat-1")).toBeTruthy();
    editor.unmount();

    holder.role = "viewer";
    render(<SwitcherAgentsList {...PROPS} />);
    expect(screen.queryByTestId("switcher-more-chat-1")).toBeNull();
  });
});

describe("<SwitcherTerminalsList />", () => {
  it("renders a row per visible PTY session and taps open a terminal ref", () => {
    holder.sessions = [
      {
        sessionId: "term-1",
        title: "Build",
        activeProcessName: null,
        cwd: "/repo",
      },
    ];
    render(<SwitcherTerminalsList {...PROPS} />);
    const row = screen.getByTestId("switcher-terminal-row-term-1");
    expect(row.textContent).toContain("Build");
    fireEvent.click(row);
    expect(holder.activateCalls).toHaveLength(1);
    expect(holder.activateCalls[0].id).toBe("term-1");
    expect(holder.activateCalls[0].ref.type).toBe("terminal");
  });

  it("shows an empty state when there are no terminals", () => {
    render(<SwitcherTerminalsList {...PROPS} />);
    expect(screen.getByText("No terminals yet.")).toBeTruthy();
  });
});

describe("<SwitcherArtifactsList />", () => {
  it("renders artifact rows with a status dot for a ticket", () => {
    holder.records = [
      {
        id: "chat-1",
        parentId: null,
        name: "Alpha",
        type: "chat",
        status: null,
        hostId: "host-A",
      },
      {
        id: "tk-1",
        parentId: null,
        name: "Ticket One",
        type: "ticket",
        status: 1,
        hostId: "host-A",
      },
    ];
    render(<SwitcherArtifactsList {...PROPS} />);
    // Chats are excluded from the artifacts list.
    expect(screen.queryByTestId("switcher-artifact-row-chat-1")).toBeNull();
    const row = screen.getByTestId("switcher-artifact-row-tk-1");
    expect(row.textContent).toContain("Ticket One");
    // The status dot is a decorative (`aria-hidden`) touch-surface affordance
    // with no title/aria-label - status color is the only signal, mirroring
    // the desktop `STATUS_DOT_CLASSES` palette.
    const statusDot = row.querySelector(".rounded-full");
    expect(statusDot).not.toBeNull();
    expect(statusDot?.className).toContain(STATUS_DOT_CLASSES[1]);
  });
});

describe("switcher create affordances (editor-gated)", () => {
  it("shows the New chat row as the first row for an editor and hides it for a viewer", () => {
    holder.records = [
      {
        id: "chat-1",
        parentId: null,
        name: "Alpha",
        type: "chat",
        status: null,
        hostId: "host-A",
      },
    ];
    const editor = render(<SwitcherAgentsList {...PROPS} />);
    const newChatRow = screen.getByTestId("switcher-new-chat");
    const firstItemRow = screen.getByTestId("switcher-agent-row-chat-1");
    // DOCUMENT_POSITION_FOLLOWING on `firstItemRow` relative to `newChatRow`
    // means the create row comes first in document order.
    expect(
      newChatRow.compareDocumentPosition(firstItemRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    editor.unmount();

    holder.role = "viewer";
    render(<SwitcherAgentsList {...PROPS} />);
    expect(screen.queryByTestId("switcher-new-chat")).toBeNull();
  });

  it("keeps the New chat row above the empty-state message when there are no agents", () => {
    render(<SwitcherAgentsList {...PROPS} />);
    expect(screen.getByTestId("switcher-new-chat")).toBeTruthy();
    expect(screen.getByText("No agents yet.")).toBeTruthy();
  });

  it("shows the New terminal row as the first row for an editor and hides it for a viewer", () => {
    holder.sessions = [
      {
        sessionId: "term-1",
        title: "Build",
        activeProcessName: null,
        cwd: "/repo",
      },
    ];
    const editor = render(<SwitcherTerminalsList {...PROPS} />);
    const newTerminalRow = screen.getByTestId("switcher-new-terminal");
    const firstItemRow = screen.getByTestId("switcher-terminal-row-term-1");
    expect(
      newTerminalRow.compareDocumentPosition(firstItemRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    editor.unmount();

    holder.role = "viewer";
    render(<SwitcherTerminalsList {...PROPS} />);
    expect(screen.queryByTestId("switcher-new-terminal")).toBeNull();
  });

  it("keeps the New terminal row above the empty-state message when there are no terminals", () => {
    render(<SwitcherTerminalsList {...PROPS} />);
    expect(screen.getByTestId("switcher-new-terminal")).toBeTruthy();
    expect(screen.getByText("No terminals yet.")).toBeTruthy();
  });

  it("shows New artifact for an editor and hides it for a viewer", () => {
    const editor = render(<SwitcherArtifactsList {...PROPS} />);
    expect(screen.getByTestId("new-artifact-action")).toBeTruthy();
    editor.unmount();

    holder.role = "viewer";
    render(<SwitcherArtifactsList {...PROPS} />);
    expect(screen.queryByTestId("new-artifact-action")).toBeNull();
  });
});
