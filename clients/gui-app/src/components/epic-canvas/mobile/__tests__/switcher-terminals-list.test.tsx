import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwitcherTerminalsList } from "@/components/epic-canvas/mobile/switcher-terminals-list";
import { terminalRowMenuEntries } from "@/components/epic-canvas/sidebar/terminal-row-menu-entries";
import { epicTerminalUiIdentityKey } from "@/lib/terminals/pending-create-identity";
import type { TerminalSidebarSessionRow } from "@/lib/terminals/reconcile-terminal-sidebar-sessions";
import type { EpicTerminalRef } from "@/stores/epics/canvas/types";

/**
 * The phone Terminals category against the SHARED panel layer: everything the
 * desktop panel says about a terminal list - it is still loading, it failed
 * and here is the way back, this row's runtime status is unknown, this create
 * failed - has to survive the trip to a phone. The panel itself is faked here;
 * what is under test is that this surface renders every one of its states and
 * routes a tap through the ref the panel handed it.
 */

interface Holder {
  rows: ReadonlyArray<TerminalSidebarSessionRow>;
  failedCreates: ReadonlyArray<{
    readonly status: string;
    readonly request: { readonly hostId: string; readonly terminalId: string };
    readonly error: { readonly message: string } | null;
  }>;
  isLoading: boolean;
  isError: boolean;
  errorMessage: string | null;
  role: "owner" | "viewer";
  activeSessionId: string | null;
  /** null models an owner host the client cannot currently reach. */
  openRefBySessionId: Record<string, EpicTerminalRef | null>;
  openedTiles: EpicTerminalRef[];
  selectedTiles: { paneId: string; instanceId: string }[];
  closeCalls: number;
  retryCalls: number;
  canRename: boolean;
  closeDisabled: boolean;
  showResourceStats: boolean;
}

const holder = vi.hoisted((): Holder => ({
  rows: [],
  failedCreates: [],
  isLoading: false,
  isError: false,
  errorMessage: null,
  role: "owner",
  activeSessionId: null,
  openRefBySessionId: {},
  openedTiles: [],
  selectedTiles: [],
  closeCalls: 0,
  retryCalls: 0,
  canRename: true,
  closeDisabled: false,
  showResourceStats: false,
}));

vi.mock("@/components/epic-canvas/sidebar/use-epic-terminals-panel", () => ({
  useEpicTerminalsPanel: () => ({
    rows: holder.rows,
    failedCreates: holder.failedCreates,
    isLoading: holder.isLoading,
    isError: holder.isError,
    errorMessage: holder.errorMessage,
    isRetrying: false,
    retry: () => {
      holder.retryCalls += 1;
    },
    hostId: "host-A",
    closeCapability: "capable",
    closeCanMutate: true,
    closePending: false,
    onDurableClose: vi.fn(),
    durableRenameIdentityKeys: new Set<string>(),
    durableRenamePending: false,
    onDurableRename: vi.fn(),
    prepareOpenRow: (row: TerminalSidebarSessionRow) =>
      holder.openRefBySessionId[row.session.sessionId] ?? null,
  }),
  useEpicTerminalRowActions: (args: {
    readonly session: { readonly sessionId: string };
  }) => ({
    label: `label-${args.session.sessionId}`,
    canRename: holder.canRename,
    renamePending: false,
    submitRename: vi.fn(),
    closeDisabled: holder.closeDisabled,
    requestClose: vi.fn(),
  }),
}));
vi.mock("@/lib/epic-selectors", () => ({
  useEpicPermissionRole: () => holder.role,
}));
vi.mock("@/components/epic-canvas/mobile/switcher-create-actions", () => ({
  SwitcherNewTerminalRow: () => (
    <button type="button" data-testid="switcher-new-terminal" />
  ),
}));
vi.mock("@/components/epic-canvas/mobile/use-mobile-epic-tiles", () => ({
  useMobileEpicTiles: () => ({
    tiles: [],
    currentInstanceId: null,
    selectTile: (paneId: string, instanceId: string) => {
      holder.selectedTiles.push({ paneId, instanceId });
    },
  }),
}));
vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation:
    () => (_epicId: string, _tabId: string, prepare: () => void) =>
      prepare(),
}));
vi.mock("@/stores/epics/canvas/store", () => ({
  findOpenTileInTab: () => null,
  useIsActiveTile: (_tabId: string, tileId: string) =>
    holder.activeSessionId === tileId,
  useEpicCanvasStore: (
    selector: (state: {
      prepareOpenTileInTabFocusTarget: (
        tabId: string,
        tile: EpicTerminalRef,
      ) => void;
      unmarkTerminalPendingCreate: (hostId: string, terminalId: string) => void;
    }) => unknown,
  ) =>
    selector({
      prepareOpenTileInTabFocusTarget: (_tabId, tile) => {
        holder.openedTiles.push(tile);
      },
      unmarkTerminalPendingCreate: vi.fn(),
    }),
}));
vi.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (
    selector: (state: { showNavigatorResourceStats: boolean }) => unknown,
  ) => selector({ showNavigatorResourceStats: holder.showResourceStats }),
}));
vi.mock("@/components/resources/resource-usage-chip", () => ({
  OwnerResourceChip: () => <span data-testid="owner-resource-chip" />,
}));

function sessionRow(args: {
  readonly sessionId: string;
  readonly durable: boolean;
  readonly runtimeStatus: "running" | "dormant" | "unknown";
}): TerminalSidebarSessionRow {
  return {
    hostId: "host-A",
    durable: args.durable,
    runtimeStatus: args.runtimeStatus,
    session: {
      sessionId: args.sessionId,
      scope: { kind: "epic", epicId: "epic-1" },
      sessionKind: "terminal",
      cwd: "/repo",
      shellCommand: "/bin/zsh",
      shellArgs: [],
      cols: 80,
      rows: 24,
      status: "running",
      exitCode: null,
      exitReason: null,
      createdAt: 0,
      title: `Term ${args.sessionId}`,
      activeProcessName: null,
    },
  };
}

const TILE: EpicTerminalRef = {
  id: "term-1",
  instanceId: "inst-1",
  type: "terminal",
  name: "Term term-1",
  hostId: "host-A",
  authority: "host",
  legacyFallback: { name: "Term term-1", titleSource: "manual", cwd: "/repo" },
};

const PROPS = {
  epicId: "epic-1",
  tabId: "tab-1",
  onClose: () => {
    holder.closeCalls += 1;
  },
};

beforeEach(() => {
  holder.rows = [];
  holder.failedCreates = [];
  holder.isLoading = false;
  holder.isError = false;
  holder.errorMessage = null;
  holder.role = "owner";
  holder.activeSessionId = null;
  holder.openRefBySessionId = {};
  holder.openedTiles = [];
  holder.selectedTiles = [];
  holder.closeCalls = 0;
  holder.retryCalls = 0;
  holder.canRename = true;
  holder.closeDisabled = false;
  holder.showResourceStats = false;
});
afterEach(cleanup);

describe("<SwitcherTerminalsList /> states", () => {
  it("holds the loading state instead of claiming there are no terminals", () => {
    holder.isLoading = true;
    render(<SwitcherTerminalsList {...PROPS} />);
    expect(screen.getByTestId("switcher-terminal-loading")).toBeTruthy();
    expect(screen.queryByText("No terminals yet.")).toBeNull();
  });

  it("surfaces a load failure with the host's message and a retry", () => {
    holder.isError = true;
    holder.errorMessage = "host unreachable";
    render(<SwitcherTerminalsList {...PROPS} />);
    expect(screen.getByTestId("switcher-terminal-error").textContent).toContain(
      "host unreachable",
    );
    fireEvent.click(screen.getByTestId("switcher-terminal-retry"));
    expect(holder.retryCalls).toBe(1);
  });

  it("shows the empty state only when the list is genuinely empty", () => {
    render(<SwitcherTerminalsList {...PROPS} />);
    expect(screen.getByTestId("switcher-terminal-empty")).toBeTruthy();
    expect(screen.getByText("No terminals yet.")).toBeTruthy();
    // The create row stays above it either way.
    expect(screen.getByTestId("switcher-new-terminal")).toBeTruthy();
  });

  it("offers retry and discard for a durable create that failed", () => {
    holder.failedCreates = [
      {
        status: "failed",
        request: { hostId: "host-A", terminalId: "term-9" },
        error: { message: "spawn refused" },
      },
    ];
    render(<SwitcherTerminalsList {...PROPS} />);
    const key = epicTerminalUiIdentityKey("failed", "host-A", "term-9");
    const row = screen.getByTestId(`switcher-terminal-failed-create-${key}`);
    expect(row.textContent).toContain("spawn refused");
    expect(
      screen.getByTestId(`switcher-terminal-failed-retry-${key}`),
    ).toBeTruthy();
    expect(
      screen.getByTestId(`switcher-terminal-failed-discard-${key}`),
    ).toBeTruthy();
  });
});

describe("<SwitcherTerminalsList /> rows", () => {
  it("lists durable rows the raw session list cannot see, with their status", () => {
    holder.rows = [
      sessionRow({
        sessionId: "term-1",
        durable: true,
        runtimeStatus: "unknown",
      }),
      sessionRow({
        sessionId: "term-2",
        durable: false,
        runtimeStatus: "running",
      }),
    ];
    render(<SwitcherTerminalsList {...PROPS} />);
    const durable = screen.getByTestId("switcher-terminal-row-term-1");
    expect(durable.textContent).toContain("Term term-1");
    // Desktop's per-row status line, which the phone used to drop entirely.
    expect(durable.textContent).toContain("Runtime status unavailable");
    const running = screen.getByTestId("switcher-terminal-row-term-2");
    expect(running.textContent).not.toContain("Runtime status unavailable");
  });

  it("carries the resource chip when the navigator stats setting is on", () => {
    holder.showResourceStats = true;
    holder.rows = [
      sessionRow({
        sessionId: "term-1",
        durable: true,
        runtimeStatus: "running",
      }),
    ];
    render(<SwitcherTerminalsList {...PROPS} />);
    expect(screen.getByTestId("owner-resource-chip")).toBeTruthy();
  });

  it("opens the panel's ref - authority and all - and closes the sheet", () => {
    holder.rows = [
      sessionRow({
        sessionId: "term-1",
        durable: true,
        runtimeStatus: "running",
      }),
    ];
    holder.openRefBySessionId = { "term-1": TILE };
    render(<SwitcherTerminalsList {...PROPS} />);
    fireEvent.click(screen.getByTestId("switcher-terminal-row-term-1"));
    expect(holder.openedTiles).toHaveLength(1);
    expect(holder.openedTiles[0]).toBe(TILE);
    expect(holder.closeCalls).toBe(1);
  });

  it("opens nothing and stays put when the row's owner host is unreachable", () => {
    holder.rows = [
      sessionRow({
        sessionId: "term-1",
        durable: true,
        runtimeStatus: "running",
      }),
    ];
    holder.openRefBySessionId = { "term-1": null };
    render(<SwitcherTerminalsList {...PROPS} />);
    fireEvent.click(screen.getByTestId("switcher-terminal-row-term-1"));
    expect(holder.openedTiles).toHaveLength(0);
    expect(holder.closeCalls).toBe(0);
  });

  it("gives an editor the row menu and a viewer none at all", () => {
    holder.rows = [
      sessionRow({
        sessionId: "term-1",
        durable: true,
        runtimeStatus: "running",
      }),
    ];
    const editor = render(<SwitcherTerminalsList {...PROPS} />);
    expect(screen.getByTestId("switcher-more-term-1")).toBeTruthy();
    editor.unmount();

    holder.role = "viewer";
    render(<SwitcherTerminalsList {...PROPS} />);
    expect(screen.queryByTestId("switcher-more-term-1")).toBeNull();
  });
});

describe("terminal row menu entries", () => {
  it("is the same Rename-then-Close menu wherever it is mounted", () => {
    const entries = terminalRowMenuEntries({
      closeDisabled: true,
      renameDisabled: false,
      onStartRename: vi.fn(),
      onRequestClose: vi.fn(),
      testIds: {
        rename: { dropdown: "r-d", context: "r-c" },
        close: { dropdown: "c-d", context: "c-c" },
      },
    });
    expect(entries.map((entry) => entry.id)).toEqual([
      "rename",
      "before-close",
      "close",
    ]);
    const close = entries[2];
    expect(close.kind === "item" && close.label).toBe("Close");
    expect(close.kind === "item" && close.disabled).toBe(true);
    expect(close.kind === "item" && close.variant).toBe("destructive");
  });
});
