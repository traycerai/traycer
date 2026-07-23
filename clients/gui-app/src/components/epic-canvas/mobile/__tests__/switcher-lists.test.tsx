import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwitcherAgentsList } from "@/components/epic-canvas/mobile/switcher-agents-list";
import { SwitcherArtifactsList } from "@/components/epic-canvas/mobile/switcher-artifacts-list";
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
interface ActivateCall {
  readonly id: string;
  readonly ref: { readonly type: string };
}
interface Holder {
  records: ReadonlyArray<FixtureRecord>;
  sessions: ReadonlyArray<FixtureSession>;
  activeId: string | null;
  role: "owner" | "viewer";
  activateCalls: ActivateCall[];
}

const holder = vi.hoisted(
  (): Holder => ({
    records: [],
    sessions: [],
    activeId: null,
    role: "owner",
    activateCalls: [],
  }),
);

vi.mock("@/lib/epic-selectors", () => ({
  useEpicArtifactRecords: () => holder.records,
  useEpicActiveAgentIds: () => new Set<string>(),
  useEpicChatHarnessId: () => null,
  useMaybeEpicTuiAgentHarnessId: () => null,
  useEpicPermissionRole: () => holder.role,
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
  useIsActiveEpicArtifact: (_tabId: string, id: string) => holder.activeId === id,
  findOpenArtifactInTab: () => null,
}));
vi.mock("@/components/epic-canvas/mobile/use-switcher-activate", () => ({
  useSwitcherActivate:
    () => (id: string, buildRef: () => { readonly type: string }) => {
      holder.activateCalls.push({ id, ref: buildRef() });
    },
}));
vi.mock("@/hooks/terminal/use-terminal-list-query", () => ({
  useTerminalList: () => ({ data: { sessions: holder.sessions } }),
}));
vi.mock("@/lib/host", () => ({ useHostClient: () => null }));
vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-A",
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
vi.mock("@/hooks/terminal/use-terminal-rename-mutation", () => ({
  useTerminalRename: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/terminal/use-terminal-kill-mutation", () => ({
  useTerminalKill: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => vi.fn(),
}));
// Create affordances pull the modal funnel / host pickers; stub them so the
// list headers render and we can assert editor-gating in isolation.
vi.mock("@/components/epic-canvas/mobile/switcher-create-actions", () => ({
  SwitcherNewAgentButton: () => (
    <button type="button" data-testid="new-agent-action" />
  ),
  SwitcherNewArtifactMenu: () => (
    <button type="button" data-testid="new-artifact-action" />
  ),
}));
vi.mock("@/components/epic-canvas/sidebar/new-terminal-picker", () => ({
  NewTerminalPicker: () => (
    <button type="button" data-testid="new-terminal-action" />
  ),
}));

const PROPS = { epicId: "epic-1", tabId: "tab-1", onClose: () => {} };

beforeEach(() => {
  holder.records = [];
  holder.sessions = [];
  holder.activeId = null;
  holder.role = "owner";
  holder.activateCalls = [];
});
afterEach(cleanup);

describe("<SwitcherAgentsList />", () => {
  beforeEach(() => {
    holder.records = [
      { id: "chat-1", parentId: null, name: "Alpha", type: "chat", status: null, hostId: "host-A" },
      { id: "tui-1", parentId: null, name: "Beta", type: "terminal-agent", status: null, hostId: "host-A" },
      { id: "spec-1", parentId: null, name: "Spec", type: "spec", status: null, hostId: "host-A" },
    ];
  });

  it("renders chats + terminal-agents interleaved by recency (artifacts excluded)", () => {
    render(<SwitcherAgentsList {...PROPS} />);
    expect(screen.getByTestId("switcher-agent-row-chat-1").textContent).toContain("Alpha");
    expect(screen.getByTestId("switcher-agent-row-tui-1").textContent).toContain("Beta");
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
      { sessionId: "term-1", title: "Build", activeProcessName: null, cwd: "/repo" },
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
      { id: "chat-1", parentId: null, name: "Alpha", type: "chat", status: null, hostId: "host-A" },
      { id: "tk-1", parentId: null, name: "Ticket One", type: "ticket", status: 1, hostId: "host-A" },
    ];
    render(<SwitcherArtifactsList {...PROPS} />);
    // Chats are excluded from the artifacts list.
    expect(screen.queryByTestId("switcher-artifact-row-chat-1")).toBeNull();
    const row = screen.getByTestId("switcher-artifact-row-tk-1");
    expect(row.textContent).toContain("Ticket One");
    expect(screen.getByTitle("In Progress")).toBeTruthy();
  });
});

describe("switcher create affordances (editor-gated)", () => {
  it("shows New agent for an editor and hides it for a viewer", () => {
    holder.records = [
      { id: "chat-1", parentId: null, name: "Alpha", type: "chat", status: null, hostId: "host-A" },
    ];
    const editor = render(<SwitcherAgentsList {...PROPS} />);
    expect(screen.getByTestId("new-agent-action")).toBeTruthy();
    editor.unmount();

    holder.role = "viewer";
    render(<SwitcherAgentsList {...PROPS} />);
    expect(screen.queryByTestId("new-agent-action")).toBeNull();
  });

  it("shows New terminal for an editor and hides it for a viewer", () => {
    const editor = render(<SwitcherTerminalsList {...PROPS} />);
    expect(screen.getByTestId("new-terminal-action")).toBeTruthy();
    editor.unmount();

    holder.role = "viewer";
    render(<SwitcherTerminalsList {...PROPS} />);
    expect(screen.queryByTestId("new-terminal-action")).toBeNull();
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
