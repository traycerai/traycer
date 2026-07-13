import "../../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

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

// The tile header's agent-controls subsystem has its own tests; stub it so
// these setup-banner tests don't pull in the epic-tree selectors + agent.list
// query it depends on.
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
    harnessSessionId: "harness-session-1",
    terminalAgentArgs: null,
    terminalShellCommand: "claude",
    terminalShellArgs: ["--continue"],
    workspaceFolders: ["/tmp/workspace"],
    model: null,
    reasoningEffort: null,
    agentMode: "regular",
  }),
}));

vi.mock("@/hooks/terminal/use-terminal-list-query", () => ({
  useTerminalList: () => ({
    data: { sessions: [] },
    isFetching: false,
    refetch: () => Promise.resolve({ data: { sessions: [] } }),
  }),
}));

vi.mock("@/hooks/terminal/use-terminal-create-mutation", () => ({
  useTerminalCreate: () => mockCreate,
}));

vi.mock("@/hooks/agent/use-prepare-tui-launch-mutation", () => ({
  useAgentStartTerminalSession: () => mockPrepare,
}));

vi.mock("@/lib/registries/terminal-session-registry", () => ({
  useTerminalSessionHandle: () => null,
}));

vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: (selector: (s: unknown) => unknown) =>
    selector({
      closeCanvasTab: () => undefined,
    }),
}));

vi.mock("@/hooks/worktree/use-worktree-get-binding-query", () => ({
  useWorktreeGetBinding: () => ({ data: { binding: null } }),
}));

let mockPrepare: {
  isError: boolean;
  isPending: boolean;
  isIdle: boolean;
  error: Error | null;
  reset: () => void;
  mutateAsync: (input: unknown) => Promise<unknown>;
};
let mockCreate: {
  isError: boolean;
  isIdle: boolean;
  isSuccess: boolean;
  error: Error | null;
  reset: () => void;
  mutate: (input: unknown) => void;
};

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

describe("<TuiAgentTile /> setup error rendering", () => {
  beforeEach(() => {
    mockCreate = {
      isError: false,
      isIdle: true,
      isSuccess: false,
      error: null,
      reset: () => undefined,
      mutate: () => undefined,
    };
    mockPrepare = {
      isError: false,
      isPending: false,
      isIdle: true,
      error: null,
      reset: () => undefined,
      mutateAsync: () => new Promise(() => {}),
    };
  });

  afterEach(() => {
    cleanup();
    useDesktopDialogStore.setState({
      activeDialog: null,
      reportIssueAvailable: false,
      reportIssueContext: null,
    });
  });

  it("renders no persistent failure banner when prepareLaunch fails with WORKTREE_SETUP_FAILED", () => {
    mockPrepare = {
      isError: true,
      isPending: false,
      isIdle: false,
      error: new Error("[WORKTREE_SETUP_FAILED] setup exited with code 1"),
      reset: () => undefined,
      mutateAsync: () => Promise.reject(new Error("setup")),
    };
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
          tileId="tile-1"
          isActive
        />,
      ),
    );

    // No persistent "Failed to start terminal" banner - feedback is via
    // toast + setup terminal tab only.
    expect(screen.queryByText(/Failed to start terminal/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Retry/i })).toBeNull();
    expect(screen.getByText(/Waiting for worktree setup/)).toBeTruthy();
    // The worktree-setup waiting state must never surface a report
    // affordance, even once the support capability is available - recovery
    // for this state is the setup terminal tab, not a report action.
    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();
  });

  it("classifies typed WORKTREE_SETUP_FAILED code without the code in the message", () => {
    // The host's RPC handler now maps setup failures to a typed `code`
    // on `HostRpcError`; the message itself does not include the code
    // string. Without the typed-code branch in `isWorktreeSetupError`,
    // this would fall through to the generic "Failed to start terminal"
    // banner.
    const error = Object.assign(new Error("Setup exited with code 1"), {
      code: "WORKTREE_SETUP_FAILED" as const,
    });
    mockPrepare = {
      isError: true,
      isPending: false,
      isIdle: false,
      error,
      reset: () => undefined,
      mutateAsync: () => Promise.reject(error),
    };
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
          tileId="tile-1"
          isActive
        />,
      ),
    );

    expect(screen.queryByText(/Failed to start terminal/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Retry/i })).toBeNull();
    expect(screen.getByText(/Waiting for worktree setup/)).toBeTruthy();
  });

  it("classifies typed WORKTREE_SETUP_CANCELLED code without the code in the message", () => {
    const error = Object.assign(new Error("User cancelled setup"), {
      code: "WORKTREE_SETUP_CANCELLED" as const,
    });
    mockPrepare = {
      isError: true,
      isPending: false,
      isIdle: false,
      error,
      reset: () => undefined,
      mutateAsync: () => Promise.reject(error),
    };
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
          tileId="tile-1"
          isActive
        />,
      ),
    );

    expect(screen.queryByText(/Failed to start terminal/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Retry/i })).toBeNull();
    expect(screen.getByText(/Waiting for worktree setup/)).toBeTruthy();
  });

  it("still renders the generic failure banner for non-setup errors", () => {
    mockPrepare = {
      isError: true,
      isPending: false,
      isIdle: false,
      error: new Error("Unrelated host failure"),
      reset: () => undefined,
      mutateAsync: () => Promise.reject(new Error("boom")),
    };
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
          tileId="tile-1"
          isActive
        />,
      ),
    );

    expect(screen.getByText(/Failed to start terminal/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Retry/i })).toBeTruthy();
  });

  it("gates the generic failure banner's report action on capability and reports only fixed context", () => {
    mockPrepare = {
      isError: true,
      isPending: false,
      isIdle: false,
      error: new Error("secret-token-should-never-render /Users/hostile/path"),
      reset: () => undefined,
      mutateAsync: () => Promise.reject(new Error("boom")),
    };
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
          tileId="tile-1"
          isActive
        />,
      ),
    );

    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();

    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));

    expect(useDesktopDialogStore.getState()).toMatchObject({
      activeDialog: "report-issue",
      reportIssueContext: {
        title: "Failed to start terminal agent",
        message: "The terminal agent session could not be started.",
        code: null,
        source: "Terminal agent",
      },
    });
    const context = useDesktopDialogStore.getState().reportIssueContext;
    expect(JSON.stringify(context)).not.toContain("secret-token");
    expect(JSON.stringify(context)).not.toContain("/Users/hostile/path");
  });

  it("renders a distinct missing-worktree body (not the generic banner) for WORKTREE_MISSING", () => {
    // The host refuses to launch into a missing cwd (no silent demote-to-Local)
    // and rejects with the typed WORKTREE_MISSING envelope. The tile surfaces an
    // actionable recreate/retry body instead of the generic failure banner.
    const error = Object.assign(
      new Error(
        "Cannot launch this terminal agent: bound folder(s) missing on disk: /repo-wt.",
      ),
      { code: "WORKTREE_MISSING" as const },
    );
    mockPrepare = {
      isError: true,
      isPending: false,
      isIdle: false,
      error,
      reset: () => undefined,
      mutateAsync: () => Promise.reject(error),
    };
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
          tileId="tile-1"
          isActive
        />,
      ),
    );

    // Distinct from the generic banner and from the setup-waiting copy.
    expect(screen.queryByText(/Failed to start terminal/)).toBeNull();
    expect(screen.queryByText(/Waiting for worktree setup/)).toBeNull();
    expect(screen.getByText(/bound folder\(s\) missing on disk/)).toBeTruthy();
    expect(
      screen.getByText(/Restore the missing folder or worktree/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Retry/i })).toBeTruthy();
  });

  it("gates the missing-worktree body's report action on capability and reports only fixed context", () => {
    const error = Object.assign(
      new Error(
        "Cannot launch this terminal agent: bound folder(s) missing on disk: /repo-wt-secret.",
      ),
      { code: "WORKTREE_MISSING" as const },
    );
    mockPrepare = {
      isError: true,
      isPending: false,
      isIdle: false,
      error,
      reset: () => undefined,
      mutateAsync: () => Promise.reject(error),
    };
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
          tileId="tile-1"
          isActive
        />,
      ),
    );

    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();

    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));

    expect(useDesktopDialogStore.getState()).toMatchObject({
      activeDialog: "report-issue",
      reportIssueContext: {
        title: "Terminal agent folder is missing",
        message: "A bound folder for a terminal agent was missing on disk.",
        code: null,
        source: "Terminal agent",
      },
    });
    const context = useDesktopDialogStore.getState().reportIssueContext;
    expect(JSON.stringify(context)).not.toContain("/repo-wt-secret");
  });
});
