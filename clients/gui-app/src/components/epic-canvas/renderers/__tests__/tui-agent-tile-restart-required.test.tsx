import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { create } from "zustand";
import type { TerminalSessionExitReason } from "@traycer/protocol/host/terminal/unary-schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";

// D19/D21 (W5-T4): `restartRequired` on the terminal-session-store is a
// non-blocking, text-only hint - "Provider settings changed - restart this
// agent to apply." Pins the three acceptance bars from the ticket: it
// renders when the field flips true, renders nothing when false, and is
// gated off entirely on a host too old to have negotiated `terminal.
// list@2.4` (the flag defaults `false` there anyway, so this is
// belt-and-suspenders, not the only thing standing between a stale host and
// a shown hint - see `tui-agent-tile.tsx`'s
// `hostSupportsRestartRequiredHint` doc comment).
//
// Mocks mirror the sibling `tui-agent-tile-dead-ended-recovery` test's
// minimal scaffolding (no real canvas-store tab/pane fixture needed).

const closeCanvasTab = vi.fn();

const testState = vi.hoisted(() => ({
  terminalListVersion: { major: 2, minor: 4 } as {
    readonly major: number;
    readonly minor: number;
  } | null,
}));

const liveHandle = {
  epicId: "epic-test",
  sessionId: "agent-1",
  dispose: () => undefined,
  store: create(() => ({
    status: "running",
    connectionStatus: "open" as const,
    exitCode: null as number | null,
    exitReason: null as TerminalSessionExitReason | null,
    effectiveCols: 80,
    effectiveRows: 24,
    lastOutputPreview: null,
    restartRequired: false,
    writeInput: () => null,
    requestResize: () => null,
    setWriter: () => undefined,
  })),
};

vi.mock("sonner", () => ({
  toast: {
    error: (): void => undefined,
  },
}));

vi.mock("@/hooks/terminal/use-terminal-session-recovery", () => ({
  useTerminalSessionRecovery: () => ({
    recoverNonce: 0,
    recoveryExhausted: false,
    onManualReconnect: () => undefined,
    onSessionHealthy: () => undefined,
    onSessionLost: () => undefined,
  }),
}));

vi.mock("@/hooks/agent/use-terminal-tile-bootstrap", () => ({
  TerminalXtermHost: () => null,
  useTerminalTileBootstrap: () => ({
    handle: liveHandle,
    createIsError: false,
    createError: null,
    retry: () => undefined,
    hostHasSession: false,
  }),
}));

vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    HostWorkspaceSelector: () => null,
    ActiveHostWorkspaceControls: () => null,
  }),
);

vi.mock("@/lib/host", () => {
  const entry = {
    hostId: "test-host",
    label: "Test host",
    kind: "local",
    websocketUrl: "ws://127.0.0.1:1/rpc",
    version: null,
    transportDialability: "dialable",
  };
  return {
    useHostBinding: () => null,
    useHostClient: () => ({
      request: () => new Promise(() => {}),
      getActiveHostId: () => "host-test",
      getRequestContextUserId: () => "user-test",
      onChange: () => () => undefined,
    }),
    useHostDirectory: () => ({
      findById: () => entry,
      onChange: () => ({ dispose: () => undefined }),
    }),
  };
});

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => ({
    request: () => new Promise(() => {}),
    getActiveHostId: () => "host-test",
    getRequestContextUserId: () => "user-test",
    onChange: () => () => undefined,
  }),
}));

// The tile gates the hint on the negotiated `terminal.list` minor - a real
// handshake never runs in this scaffolding, so the real hook would answer
// `null` (unknown) forever and the hint could never show. Mocked to the
// module's OTHER exports preserved, only this one hook overridden.
vi.mock("@/hooks/host/use-host-supports-method", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/host/use-host-supports-method")
    >();
  return {
    ...actual,
    useHostMethodSchemaVersion: () => testState.terminalListVersion,
  };
});

vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: vi.fn(),
}));

vi.mock("@/hooks/agent/use-agent-stop-controls", () => ({
  useAgentStopControls: () => ({ self: null, descendants: [] }),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useOpenEpicId: () => "epic-test",
  useEpicTerminalAgent: () => ({
    id: "agent-1",
    harnessId: "claude" as const,
    title: "Claude agent",
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    hostId: "host-test",
    harnessSessionId: null,
    terminalAgentArgs: null,
    terminalShellCommand: null,
    terminalShellArgs: null,
    workspaceFolders: [],
    model: null,
    reasoningEffort: null,
    agentMode: "regular" as const,
  }),
}));

vi.mock("@/hooks/agent/use-prepare-tui-launch-mutation", () => ({
  useAgentStartTerminalSession: () => ({
    isError: false,
    isPending: false,
    isIdle: true,
    error: null,
    reset: () => undefined,
    mutateAsync: () => new Promise(() => {}),
  }),
}));

vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: (selector: (s: unknown) => unknown) =>
    selector({ closeCanvasTab }),
}));

vi.mock("@/hooks/worktree/use-worktree-get-binding-query", () => ({
  useWorktreeGetBinding: () => ({ data: { binding: null } }),
}));

import { TuiAgentTile } from "../tui-agent-tile";
import { TabHostProvider } from "../../tab-host-provider";

function withQueryClient(node: ReactNode): ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <TabHostProvider hostId="test-host">{node}</TabHostProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

const HINT_TEXT = "Provider settings changed";

function renderTile(): void {
  render(
    withQueryClient(
      <TuiAgentTile
        viewTabId="tab-test"
        node={{
          id: "agent-1",
          instanceId: "inst-agent-1",
          type: "terminal-agent",
          name: "claude",
          hostId: "test-host",
        }}
        tileId="pane-1"
        isActive
      />,
    ),
  );
}

describe("<TuiAgentTile /> restartRequired hint", () => {
  beforeEach(() => {
    closeCanvasTab.mockClear();
    testState.terminalListVersion = { major: 2, minor: 4 };
    liveHandle.store.setState({
      status: "running",
      connectionStatus: "open",
      exitCode: null,
      exitReason: null,
      restartRequired: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders nothing when restartRequired is false", async () => {
    renderTile();
    await waitFor(() => {
      expect(
        screen.queryByTestId("terminal-agent-restart-required-pane-1"),
      ).toBeNull();
    });
    expect(screen.queryByText(HINT_TEXT, { exact: false })).toBeNull();
  });

  it("renders the hint, text-only, when restartRequired flips true", async () => {
    renderTile();
    await waitFor(() => {
      expect(
        screen.queryByTestId("terminal-agent-restart-required-pane-1"),
      ).toBeNull();
    });

    act(() => {
      liveHandle.store.setState({ restartRequired: true });
    });

    const hint = await screen.findByTestId(
      "terminal-agent-restart-required-pane-1",
    );
    expect(hint.textContent).toContain(HINT_TEXT);
    // Non-blocking: no dialog role, and the wrapper never captures pointer
    // events over the terminal underneath.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(hint.className).toContain("pointer-events-none");
  });

  it("stays hidden on a host too old to have negotiated terminal.list@2.4, even with restartRequired true", async () => {
    testState.terminalListVersion = { major: 2, minor: 3 };
    renderTile();
    act(() => {
      liveHandle.store.setState({ restartRequired: true });
    });

    await waitFor(() => {
      expect(screen.queryByText(HINT_TEXT, { exact: false })).toBeNull();
    });
    expect(
      screen.queryByTestId("terminal-agent-restart-required-pane-1"),
    ).toBeNull();
  });
});
