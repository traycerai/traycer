import "../../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { create } from "zustand";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";

// A `reaped` exit is the host's idle-reap of an unwatched terminal-agent -
// lifecycle, not a crash. The tile must NOT close the tab and NOT raise the
// crash toast; it revives the session in place instead (bootstrap retry →
// `terminal.create` under the same id → `prepareLaunch` resumes the
// conversation). This test pins that contract; the sibling
// `terminal-agent-tile-exit-close` test pins the genuine-exit close path.

const closeCanvasTab = vi.fn();
const bootstrapRetry = vi.fn();
const toastError = vi.fn();

const reapedHandle = {
  epicId: "epic-test",
  sessionId: "agent-1",
  dispose: () => undefined,
  store: create(() => ({
    status: "exited" as const,
    exitCode: -1,
    exitReason: "reaped" as const,
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
    error: (...args: unknown[]): void => {
      toastError(...args);
    },
  },
}));

vi.mock("@/hooks/agent/use-terminal-tile-bootstrap", () => ({
  TerminalXtermHost: () => null,
  useTerminalTileBootstrap: () => ({
    handle: reapedHandle,
    createIsError: false,
    createError: null,
    retry: bootstrapRetry,
    hostHasSession: false,
  }),
}));

vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    HostWorkspaceSelector: () => null,
    // The fork dialog stays mounted under the tile and imports this control.
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
    status: "available",
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

describe("<TuiAgentTile /> reaped exit revive", () => {
  beforeEach(() => {
    closeCanvasTab.mockClear();
    bootstrapRetry.mockClear();
    toastError.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("revives in place on a reaped exit - no tab close, no crash toast", async () => {
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
      expect(bootstrapRetry).toHaveBeenCalledTimes(1);
    });
    expect(closeCanvasTab).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });
});
