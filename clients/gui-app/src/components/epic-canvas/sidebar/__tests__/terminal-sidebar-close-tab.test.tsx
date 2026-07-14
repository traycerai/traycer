import "../../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CanonicalTerminalSessionInfo } from "@traycer/protocol/host/terminal/unary-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SnapshotLoadingProvider } from "@/components/epic-canvas/snapshots/snapshot-loading-context";

const SESSION_ID = "term-1";
const TAB_ID = "tab-1";

const killMutate = vi.fn();
const terminalSessions = vi.hoisted<{
  value: ReadonlyArray<CanonicalTerminalSessionInfo>;
}>(() => ({ value: [] }));

vi.mock("@/lib/host", () => ({
  useHostClient: () => null,
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-1",
}));

const RUNNING_SESSION: CanonicalTerminalSessionInfo = {
  sessionId: SESSION_ID,
  scope: { kind: "epic", epicId: "epic-1" },
  sessionKind: "terminal",
  cwd: "/tmp/work",
  shellCommand: "/bin/zsh",
  shellArgs: [],
  cols: 80,
  rows: 24,
  status: "running",
  exitCode: null,
  createdAt: 0,
  title: null,
};

vi.mock("@/hooks/terminal/use-terminal-list-query", () => ({
  useTerminalList: () => ({
    data: { sessions: terminalSessions.value },
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/hooks/terminal/use-terminal-kill-mutation", () => ({
  useTerminalKill: () => ({ mutate: killMutate, isPending: false }),
}));

vi.mock("@/hooks/terminal/use-terminal-rename-mutation", () => ({
  useTerminalRename: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: (props: { readonly children: ReactNode }) => props.children,
  DropdownMenuTrigger: (props: { readonly children: ReactNode }) =>
    props.children,
  DropdownMenuContent: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
  DropdownMenuItem: (props: {
    readonly children: ReactNode;
    readonly onSelect: () => void;
    readonly "data-testid": string;
    readonly disabled: boolean | undefined;
  }) => (
    <button
      type="button"
      data-testid={props["data-testid"]}
      disabled={props.disabled}
      onClick={props.onSelect}
    >
      {props.children}
    </button>
  ),
  DropdownMenuSeparator: () => null,
}));

import { TerminalsPanelBody } from "../epic-terminal-sidebar";
import {
  findOpenArtifactInTab,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";

function wrapper(node: ReactNode): ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SnapshotLoadingProvider
          value={{ snapshotLoaded: true, snapshotFetchError: null }}
        >
          {node}
        </SnapshotLoadingProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function seedOpenTerminalTab(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useEpicCanvasStore.setState({
    tabsById: {
      [TAB_ID]: { tabId: TAB_ID, epicId: "epic-1", name: "Epic 1" },
    },
  });
  useEpicCanvasStore.getState().openTileInTab(TAB_ID, {
    id: SESSION_ID,
    instanceId: "inst-term-1",
    type: "terminal",
    name: "New Terminal",
    titleSource: "default",
    hostId: "host-1",
    cwd: "/tmp/work",
  });
}

describe("terminal sidebar Close", () => {
  beforeEach(() => {
    killMutate.mockClear();
    terminalSessions.value = [RUNNING_SESSION];
    seedOpenTerminalTab();
  });

  afterEach(() => {
    cleanup();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("closes the open canvas tab and kills the session", () => {
    // Precondition: a canvas tab is open for this session.
    expect(findOpenArtifactInTab(TAB_ID, SESSION_ID)).not.toBeNull();

    const { getByTestId, queryByTestId, queryByText } = render(
      wrapper(<TerminalsPanelBody epicId="epic-1" tabId={TAB_ID} />),
    );
    expect(
      getByTestId(`epic-terminal-sidebar-item-${SESSION_ID}`).textContent,
    ).toBe("New Terminal");
    expect(
      getByTestId(`epic-terminal-sidebar-item-${SESSION_ID}`).className,
    ).toContain("h-7");
    expect(
      getByTestId(`epic-terminal-sidebar-item-${SESSION_ID}`).className,
    ).not.toContain("h-9");
    expect(queryByText("/tmp/work")).toBeNull();
    expect(
      getByTestId(`epic-terminal-sidebar-more-${SESSION_ID}`),
    ).not.toBeNull();
    expect(
      getByTestId(`epic-terminal-sidebar-rename-${SESSION_ID}`),
    ).not.toBeNull();
    expect(
      queryByTestId(`epic-terminal-sidebar-kill-${SESSION_ID}`),
    ).toBeNull();

    fireEvent.click(
      getByTestId(`epic-terminal-sidebar-kill-menu-${SESSION_ID}`),
    );

    // The open tab is closed...
    expect(findOpenArtifactInTab(TAB_ID, SESSION_ID)).toBeNull();
    // ...and the PTY is terminated.
    expect(killMutate).toHaveBeenCalledWith({ sessionId: SESSION_ID });
  });

  it("offers the ellipsis actions from the row context menu", async () => {
    const { getByTestId, findByRole } = render(
      wrapper(<TerminalsPanelBody epicId="epic-1" tabId={TAB_ID} />),
    );

    fireEvent.contextMenu(
      getByTestId(`epic-terminal-sidebar-item-${SESSION_ID}`),
    );

    expect(await findByRole("menuitem", { name: "Rename" })).not.toBeNull();
    fireEvent.click(await findByRole("menuitem", { name: "Close" }));

    expect(findOpenArtifactInTab(TAB_ID, SESSION_ID)).toBeNull();
    expect(killMutate).toHaveBeenCalledWith({ sessionId: SESSION_ID });
  });

  it("does not suppress the native context menu while renaming", async () => {
    const { getByTestId, findByTestId, queryByRole } = render(
      wrapper(<TerminalsPanelBody epicId="epic-1" tabId={TAB_ID} />),
    );

    fireEvent.click(getByTestId(`epic-terminal-sidebar-rename-${SESSION_ID}`));

    const renameInput = await findByTestId(
      `epic-terminal-sidebar-rename-input-${SESSION_ID}`,
    );
    const contextMenuEvent = createEvent.contextMenu(renameInput);
    fireEvent(renameInput, contextMenuEvent);

    expect(contextMenuEvent.defaultPrevented).toBe(false);
    expect(queryByRole("menuitem", { name: "Rename" })).toBeNull();
    expect(queryByRole("menuitem", { name: "Close" })).toBeNull();
  });

  it("uses the active process name for an unnamed terminal", () => {
    terminalSessions.value = [{ ...RUNNING_SESSION, activeProcessName: "vim" }];

    const { getByTestId } = render(
      wrapper(<TerminalsPanelBody epicId="epic-1" tabId={TAB_ID} />),
    );

    expect(
      getByTestId(`epic-terminal-sidebar-item-${SESSION_ID}`).textContent,
    ).toBe("vim");
  });

  it("shows the empty terminal panel state when there are no terminals", () => {
    terminalSessions.value = [];

    const { getByTestId, getByText, queryByTestId } = render(
      wrapper(<TerminalsPanelBody epicId="epic-1" tabId={TAB_ID} />),
    );

    expect(getByTestId("epic-terminal-sidebar-empty")).not.toBeNull();
    expect(getByText("No terminals yet.")).not.toBeNull();
    expect(queryByTestId("epic-terminal-sidebar-list")).toBeNull();
  });
});
