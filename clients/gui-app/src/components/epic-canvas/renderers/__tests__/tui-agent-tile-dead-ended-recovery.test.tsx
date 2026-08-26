import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { create } from "zustand";
import type { TerminalSessionExitReason } from "@traycer/protocol/host/terminal/unary-schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";

// `terminal-tile.tsx` and `tui-agent-tile.tsx` both drive automatic recovery
// off the SAME condition: `if (status === "lost" || status === "reaped")
// onSessionLost()`. This test pins that contract for the TUI agent tile - a
// handle that dead-ends at lifecycle status "reaped" (the host confirmed via
// TERMINAL_NOT_FOUND that this handle's PTY is gone - NOT the
// `exitReason: "reaped"` idle-reap-and-revive path the sibling
// `terminal-agent-tile-reaped-revive` test pins) must drive the same
// recovery callback as "lost". Mocks mirror that sibling test's minimal
// scaffolding (no real canvas-store tab/pane fixture needed).

const closeCanvasTab = vi.fn();

const testState = vi.hoisted(() => ({
  onSessionLost: vi.fn(),
}));

const recoveryHandle = {
  epicId: "epic-test",
  sessionId: "agent-1",
  dispose: () => undefined,
  store: create(() => ({
    // Not `as const`: the tests below mutate `status` post-mount, which a
    // single-literal-narrowed type would reject at the `setState` call site.
    status: "running",
    connectionStatus: "open" as const,
    exitCode: null as number | null,
    exitReason: null as TerminalSessionExitReason | null,
    effectiveCols: 80,
    effectiveRows: 24,
    lastOutputPreview: null,
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
    onSessionLost: testState.onSessionLost,
  }),
}));

vi.mock("@/hooks/agent/use-terminal-tile-bootstrap", () => ({
  TerminalXtermHost: () => null,
  useTerminalTileBootstrap: () => ({
    handle: recoveryHandle,
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

describe("<TuiAgentTile /> dead-ended handle recovery", () => {
  beforeEach(() => {
    closeCanvasTab.mockClear();
    testState.onSessionLost.mockClear();
    recoveryHandle.store.setState({
      status: "running",
      connectionStatus: "open",
      exitCode: null,
      exitReason: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it.each([
    { name: "reaped", status: "reaped" as const },
    { name: "lost", status: "lost" as const },
  ])(
    "drives the recovery callback once the handle status becomes $name",
    async ({ status }) => {
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

      await waitFor(() => {
        expect(testState.onSessionLost).not.toHaveBeenCalled();
      });

      act(() => {
        recoveryHandle.store.setState({ status });
      });

      expect(testState.onSessionLost).toHaveBeenCalledTimes(1);
      expect(closeCanvasTab).not.toHaveBeenCalled();
    },
  );
});
