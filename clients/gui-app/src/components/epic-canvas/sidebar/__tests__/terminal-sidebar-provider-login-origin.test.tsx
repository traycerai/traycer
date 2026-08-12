import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CanonicalTerminalSessionInfo } from "@traycer/protocol/host/terminal/unary-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SnapshotLoadingProvider } from "@/components/epic-canvas/snapshots/snapshot-loading-context";

// A sign-in terminal reopened from the sidebar (no existing canvas tab for
// it) must open with `origin: "provider-login"` / `originProviderId` set, so
// the freshly-opened tile's bootstrap adopts instead of re-creating the PTY.
// `terminal.list` carries no origin at all - the renderer's own
// `provider-login-terminals` registry is what supplies it, keyed by host +
// session id. An ordinary session (no registry entry) must come through
// unchanged.

const SESSION_ID = "term-signin";
const OTHER_SESSION_ID = "term-plain";
const TAB_ID = "tab-1";
const HOST_ID = "host-1";

const terminalSessions = vi.hoisted<{
  value: ReadonlyArray<CanonicalTerminalSessionInfo>;
}>(() => ({ value: [] }));

vi.mock("@/lib/host", () => ({
  useHostClient: () => null,
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => HOST_ID,
}));

vi.mock("@/hooks/terminal/use-terminal-list-query", () => ({
  useTerminalList: () => ({
    data: { sessions: terminalSessions.value },
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/hooks/terminal/use-terminal-kill-mutation", () => ({
  useTerminalKill: () => ({ mutate: vi.fn(), isPending: false }),
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
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import {
  recordProviderLoginTerminal,
  useProviderLoginTerminalsStore,
} from "@/stores/providers/provider-login-terminals";

function openedTerminalTile(tabId: string, sessionId: string) {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) throw new Error("expected view tab canvas");
  const pane = collectPanes(canvas.root)[0];
  const activeInstanceId = pane.activeTabId;
  if (activeInstanceId === null) throw new Error("expected an active tile");
  const tile = canvas.tilesByInstanceId[activeInstanceId];
  if (tile === undefined || tile.type !== "terminal" || tile.id !== sessionId) {
    throw new Error("expected the session's terminal tile to be active");
  }
  return tile;
}

function sessionInfo(id: string): CanonicalTerminalSessionInfo {
  return {
    sessionId: id,
    scope: { kind: "epic", epicId: "epic-1" },
    sessionKind: "terminal",
    cwd: "~",
    shellCommand: "/bin/zsh",
    shellArgs: [],
    cols: 80,
    rows: 24,
    status: "running",
    exitCode: null,
    createdAt: 0,
    title: "Copilot sign-in",
  };
}

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

function seedTab(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useEpicCanvasStore.setState({
    tabsById: {
      [TAB_ID]: { tabId: TAB_ID, epicId: "epic-1", name: "Epic 1" },
    },
  });
}

describe("terminal sidebar reopen carries provider-login origin", () => {
  beforeEach(() => {
    seedTab();
    // The registry is a module-level singleton that persists, so a recorded
    // entry outlives the test that wrote it. Today's two tests use distinct
    // session ids and cannot collide, but the next test added here would
    // silently inherit whatever `recordProviderLoginTerminal` left behind.
    // Same reset `open-subpages.test.tsx` does.
    useProviderLoginTerminalsStore.setState(
      useProviderLoginTerminalsStore.getInitialState(),
      true,
    );
  });

  afterEach(() => {
    cleanup();
  });

  it("opens a recorded sign-in session with origin: provider-login", () => {
    recordProviderLoginTerminal({
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      providerId: "copilot",
    });
    terminalSessions.value = [sessionInfo(SESSION_ID)];

    const { getByTestId } = render(
      wrapper(<TerminalsPanelBody epicId="epic-1" tabId={TAB_ID} />),
    );
    fireEvent.click(getByTestId(`epic-terminal-sidebar-item-${SESSION_ID}`));

    const opened = openedTerminalTile(TAB_ID, SESSION_ID);
    expect(opened.origin).toBe("provider-login");
    expect(opened.originProviderId).toBe("copilot");
  });

  it("opens an ordinary (unrecorded) session with no origin set", () => {
    terminalSessions.value = [sessionInfo(OTHER_SESSION_ID)];

    const { getByTestId } = render(
      wrapper(<TerminalsPanelBody epicId="epic-1" tabId={TAB_ID} />),
    );
    fireEvent.click(
      getByTestId(`epic-terminal-sidebar-item-${OTHER_SESSION_ID}`),
    );

    const opened = openedTerminalTile(TAB_ID, OTHER_SESSION_ID);
    expect(opened.origin).toBeUndefined();
  });
});
