import "../../../../../__tests__/test-browser-apis";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";

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
  mutate: Mock;
};

let mockAgent: {
  id: string;
  harnessId: "claude" | "codex" | "opencode";
  title: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
  hostId: string;
  harnessSessionId: string | null;
  terminalAgentArgs: string | null;
  terminalShellCommand: string | null;
  terminalShellArgs: ReadonlyArray<string> | null;
  workspaceFolders: ReadonlyArray<string>;
  model: string | null;
  reasoningEffort: string | null;
  agentMode: "regular" | "epic";
};

vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    ActiveHostWorkspaceControls: () => null,
    HostWorkspaceSelector: () => null,
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
// these cwd tests don't pull in the epic-tree selectors + agent.list query it
// depends on.
vi.mock("@/hooks/agent/use-agent-stop-controls", () => ({
  useAgentStopControls: () => ({ self: null, descendants: [] }),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useOpenEpicId: () => "epic-test",
  useEpicTerminalAgent: () => mockAgent,
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

vi.mock(
  "@/lib/registries/terminal-session-registry",
  async (importOriginal) => ({
    // Keep the real registry surface (the bootstrap's warm-handle adoption
    // reads it; against an empty registry it no-ops) and stub only the handle.
    ...(await importOriginal<
      typeof import("@/lib/registries/terminal-session-registry")
    >()),
    useTerminalSessionHandle: () => null,
  }),
);

// The real probe mounts the xterm engine, which cannot measure in jsdom (no
// layout); stub it to report a grid immediately so the measure-gated create
// dispatches, as it would in the app.
vi.mock(
  "@/components/epic-canvas/renderers/terminal-grid-measure-probe",
  async () => {
    const { useEffect } = await import("react");
    return {
      TerminalGridMeasureProbe: (props: {
        readonly onMeasured: (cols: number, rows: number) => void;
      }) => {
        const { onMeasured } = props;
        useEffect(() => {
          onMeasured(120, 40);
        }, [onMeasured]);
        return null;
      },
    };
  },
);

vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: (selector: (s: unknown) => unknown) =>
    selector({
      closeCanvasTab: () => undefined,
    }),
}));

vi.mock("@/hooks/worktree/use-worktree-get-binding-query", () => ({
  useWorktreeGetBinding: () => ({ data: { binding: null } }),
}));

import { TuiAgentTile } from "../tui-agent-tile";
import { TabHostProvider } from "../../tab-host-provider";
import {
  clearPreparedTerminalAgentLaunch,
  stashPreparedTerminalAgentLaunch,
} from "@/stores/terminals/prepared-terminal-agent-launch-store";

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

describe("<TuiAgentTile /> bound-cwd handling", () => {
  beforeEach(() => {
    mockCreate = {
      isError: false,
      isIdle: true,
      isSuccess: false,
      error: null,
      reset: () => undefined,
      mutate: vi.fn(),
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
    clearPreparedTerminalAgentLaunch("agent-fork");
    cleanup();
  });

  it("uses a one-shot fork-prepared launch instead of preparing a fresh session", async () => {
    mockAgent = {
      id: "agent-fork",
      harnessId: "codex",
      title: "Forked Codex agent",
      parentId: null,
      createdAt: 0,
      updatedAt: 0,
      hostId: "host-test",
      harnessSessionId: null,
      terminalAgentArgs: null,
      terminalShellCommand: "codex",
      terminalShellArgs: ["--remote", "ws://old", "fork", "source-session"],
      workspaceFolders: ["/tmp/fork-worktree"],
      model: null,
      reasoningEffort: null,
      agentMode: "regular",
    };
    const prepareSpy = vi.fn(() =>
      Promise.resolve({
        harnessId: "codex" as const,
        harnessSessionId: null,
        terminalShellCommand: "codex",
        terminalShellArgs: ["--remote", "ws://fresh"],
        hostId: "host-test",
        workingDirectory: "/tmp/fresh",
        workspaceFolders: ["/tmp/fresh"],
        worktreeBusyPaths: [],
      }),
    );
    mockPrepare = {
      isError: false,
      isPending: false,
      isIdle: true,
      error: null,
      reset: () => undefined,
      mutateAsync: prepareSpy,
    };
    stashPreparedTerminalAgentLaunch("agent-fork", {
      cwd: "/tmp/fork-worktree",
      shellCommand: "codex",
      shellArgs: ["--remote", "ws://fork-server", "fork", "source-session"],
      worktreeBusyPaths: ["/tmp/fork-worktree"],
    });

    render(
      withQueryClient(
        <TuiAgentTile
          viewTabId="tab-test"
          node={{
            id: "agent-fork",
            instanceId: "inst-agent-fork",
            type: "terminal-agent",
            name: "codex",
            hostId: "test-host",
          }}
          tileId="tile-fork"
          isActive
        />,
      ),
    );

    await waitFor(() => {
      expect(mockCreate.mutate).toHaveBeenCalled();
    });
    expect(prepareSpy).not.toHaveBeenCalled();
    const [request] = mockCreate.mutate.mock.calls[0] as [
      {
        readonly cwd: string;
        readonly shellCommand: string;
        readonly shellArgs: ReadonlyArray<string>;
        readonly worktreeBusyPaths: ReadonlyArray<string>;
      },
    ];
    expect(request.cwd).toBe("/tmp/fork-worktree");
    expect(request.shellCommand).toBe("codex");
    expect(request.shellArgs).toEqual([
      "--remote",
      "ws://fork-server",
      "fork",
      "source-session",
    ]);
    expect(request.worktreeBusyPaths).toEqual(["/tmp/fork-worktree"]);
  });

  it("forwards the resolver-returned workingDirectory as the PTY cwd for host-prepared launches", async () => {
    mockAgent = {
      id: "agent-1",
      harnessId: "codex",
      title: "Codex agent",
      parentId: null,
      createdAt: 0,
      updatedAt: 0,
      hostId: "host-test",
      harnessSessionId: null,
      terminalAgentArgs: null,
      terminalShellCommand: null,
      terminalShellArgs: null,
      // The persisted record may carry stale workspace folders the
      // first time a binding lands; the live PTY cwd must come from the
      // resolver's binding-aware response, not from this array.
      workspaceFolders: ["/tmp/legacy-root"],
      model: null,
      reasoningEffort: null,
      agentMode: "regular",
    };
    mockPrepare = {
      isError: false,
      isPending: false,
      isIdle: true,
      error: null,
      reset: () => undefined,
      mutateAsync: () =>
        Promise.resolve({
          harnessId: "codex" as const,
          harnessSessionId: "harness-codex-1",
          terminalShellCommand: "codex",
          terminalShellArgs: ["--resume", "harness-codex-1"],
          hostId: "host-test",
          workingDirectory: "/tmp/worktrees/feature-x",
          workspaceFolders: [
            "/tmp/worktrees/feature-x",
            "/tmp/worktrees/sibling-y",
          ],
          worktreeBusyPaths: [
            "/tmp/worktrees/feature-x",
            "/tmp/worktrees/sibling-y",
          ],
        }),
    };

    render(
      withQueryClient(
        <TuiAgentTile
          viewTabId="tab-test"
          node={{
            id: "agent-1",
            instanceId: "inst-agent-1",
            type: "terminal-agent",
            name: "codex",
            hostId: "test-host",
          }}
          tileId="tile-1"
          isActive
        />,
      ),
    );

    await waitFor(() => {
      expect(mockCreate.mutate).toHaveBeenCalled();
    });
    const [request] = mockCreate.mutate.mock.calls[0] as [
      {
        readonly cwd: string | null;
        readonly desiredSessionId: string;
        readonly worktreeBusyPaths: ReadonlyArray<string>;
      },
    ];
    expect(request.cwd).toBe("/tmp/worktrees/feature-x");
    expect(request.desiredSessionId).toBe("agent-1");
    // Multi-repo busy-path acceptance: the resolver-returned set must be
    // forwarded verbatim to `terminal.create` so the host-side active-run
    // busy registry covers every bound worktree path, not just cwd.
    expect(request.worktreeBusyPaths).toEqual([
      "/tmp/worktrees/feature-x",
      "/tmp/worktrees/sibling-y",
    ]);
  });

  it("routes a Claude initial launch through agent.startTerminalSession and uses the resolver's bound cwd", async () => {
    // Acceptance criterion: a Claude terminal-agent with a worktree binding
    // launches in the primary bound worktree cwd, not in the persisted
    // root workspace. Every harness - including Claude - now goes through
    // the host-prepared launch path so the resolver re-reads the binding
    // before each launch.
    mockAgent = {
      id: "agent-claude",
      harnessId: "claude",
      title: "Claude agent",
      parentId: null,
      createdAt: 0,
      updatedAt: 0,
      hostId: "host-test",
      harnessSessionId: null,
      terminalAgentArgs: "--permission-mode acceptEdits",
      terminalShellCommand: null,
      terminalShellArgs: null,
      workspaceFolders: ["/tmp/legacy-root"],
      model: null,
      reasoningEffort: null,
      agentMode: "regular",
    };
    const prepareSpy = vi.fn(() =>
      Promise.resolve({
        harnessId: "claude" as const,
        harnessSessionId: "claude-session-fresh",
        terminalShellCommand: "claude",
        terminalShellArgs: ["--resume", "claude-session-fresh"],
        hostId: "host-test",
        workingDirectory: "/tmp/worktrees/feature-claude",
        workspaceFolders: ["/tmp/worktrees/feature-claude"],
        worktreeBusyPaths: ["/tmp/worktrees/feature-claude"],
      }),
    );
    mockPrepare = {
      isError: false,
      isPending: false,
      isIdle: true,
      error: null,
      reset: () => undefined,
      mutateAsync: prepareSpy,
    };

    render(
      withQueryClient(
        <TuiAgentTile
          viewTabId="tab-test"
          node={{
            id: "agent-claude",
            instanceId: "inst-agent-claude",
            type: "terminal-agent",
            name: "claude",
            hostId: "test-host",
          }}
          tileId="tile-claude"
          isActive
        />,
      ),
    );

    await waitFor(() => {
      expect(mockCreate.mutate).toHaveBeenCalled();
    });
    expect(prepareSpy).toHaveBeenCalledWith({
      harnessId: "claude",
      epicId: "epic-test",
      model: null,
      reasoningEffort: null,
      agentMode: "regular",
      tuiAgentId: "agent-claude",
      harnessSessionId: null,
      forkSourceHarnessSessionId: null,
      terminalAgentArgs: "--permission-mode acceptEdits",
      profileId: null,
    });
    const [request] = mockCreate.mutate.mock.calls[0] as [
      {
        readonly cwd: string | null;
        readonly shellCommand: string;
        readonly shellArgs: ReadonlyArray<string>;
      },
    ];
    expect(request.cwd).toBe("/tmp/worktrees/feature-claude");
    expect(request.shellCommand).toBe("claude");
    expect(request.shellArgs).toEqual(["--resume", "claude-session-fresh"]);
  });

  it("uses the resolver-returned cwd on Claude reopen, ignoring stale persisted workspaceFolders", async () => {
    // Reopen path: the persisted record carries the original cwd in
    // `workspaceFolders[0]`. After a re-bind those values are stale until
    // the next snapshot lands, so the renderer must take cwd from the
    // resolver response (which re-reads the live binding row).
    mockAgent = {
      id: "agent-claude",
      harnessId: "claude",
      title: "Claude agent",
      parentId: null,
      createdAt: 0,
      updatedAt: 0,
      hostId: "host-test",
      harnessSessionId: "claude-session-reopen",
      terminalAgentArgs: "",
      terminalShellCommand: "claude",
      terminalShellArgs: ["--resume", "claude-session-reopen"],
      workspaceFolders: ["/tmp/old-root"],
      model: null,
      reasoningEffort: null,
      agentMode: "regular",
    };
    const prepareSpy = vi.fn(() =>
      Promise.resolve({
        harnessId: "claude" as const,
        harnessSessionId: "claude-session-reopen",
        terminalShellCommand: "claude",
        terminalShellArgs: [
          "--resume",
          "claude-session-reopen",
          "--add-dir",
          "/tmp/worktrees/sibling",
        ],
        hostId: "host-test",
        workingDirectory: "/tmp/worktrees/feature-rebound",
        workspaceFolders: [
          "/tmp/worktrees/feature-rebound",
          "/tmp/worktrees/sibling",
        ],
        worktreeBusyPaths: [
          "/tmp/worktrees/feature-rebound",
          "/tmp/worktrees/sibling",
        ],
      }),
    );
    mockPrepare = {
      isError: false,
      isPending: false,
      isIdle: true,
      error: null,
      reset: () => undefined,
      mutateAsync: prepareSpy,
    };

    render(
      withQueryClient(
        <TuiAgentTile
          viewTabId="tab-test"
          node={{
            id: "agent-claude",
            instanceId: "inst-agent-claude",
            type: "terminal-agent",
            name: "claude",
            hostId: "test-host",
          }}
          tileId="tile-claude"
          isActive
        />,
      ),
    );

    await waitFor(() => {
      expect(mockCreate.mutate).toHaveBeenCalled();
    });
    expect(prepareSpy).toHaveBeenCalledWith({
      harnessId: "claude",
      epicId: "epic-test",
      model: null,
      reasoningEffort: null,
      agentMode: "regular",
      tuiAgentId: "agent-claude",
      harnessSessionId: "claude-session-reopen",
      forkSourceHarnessSessionId: null,
      terminalAgentArgs: "",
      profileId: null,
    });
    const [request] = mockCreate.mutate.mock.calls[0] as [
      {
        readonly cwd: string | null;
        readonly shellArgs: ReadonlyArray<string>;
      },
    ];
    expect(request.cwd).toBe("/tmp/worktrees/feature-rebound");
    // The renderer takes the resolver's freshly-derived shellArgs verbatim
    // so a re-bind picks up the new `--add-dir` flags too.
    expect(request.shellArgs).toEqual([
      "--resume",
      "claude-session-reopen",
      "--add-dir",
      "/tmp/worktrees/sibling",
    ]);
  });

  it("uses the resolver-returned Local cwd, ignoring stale persisted workspaceFolders", async () => {
    // The renderer always forwards the resolver's authoritative
    // `workingDirectory` (a Local-mode bind here) and never the persisted
    // record's stale `workspaceFolders`. (A bound worktree gone from disk is no
    // longer silently demoted to Local — the resolver rejects with
    // WORKTREE_MISSING; that reject path is covered by the setup-banner test.)
    mockAgent = {
      id: "agent-claude",
      harnessId: "claude",
      title: "Claude agent",
      parentId: null,
      createdAt: 0,
      updatedAt: 0,
      hostId: "host-test",
      harnessSessionId: "claude-session-local",
      terminalAgentArgs: null,
      terminalShellCommand: "claude",
      terminalShellArgs: ["--resume", "claude-session-local"],
      workspaceFolders: ["/tmp/stale-persisted-folder"],
      model: null,
      reasoningEffort: null,
      agentMode: "regular",
    };
    mockPrepare = {
      isError: false,
      isPending: false,
      isIdle: true,
      error: null,
      reset: () => undefined,
      mutateAsync: () =>
        Promise.resolve({
          harnessId: "claude" as const,
          harnessSessionId: "claude-session-local",
          terminalShellCommand: "claude",
          terminalShellArgs: ["--resume", "claude-session-local"],
          hostId: "host-test",
          workingDirectory: "/tmp/repo",
          workspaceFolders: ["/tmp/repo"],
          worktreeBusyPaths: [],
        }),
    };

    render(
      withQueryClient(
        <TuiAgentTile
          viewTabId="tab-test"
          node={{
            id: "agent-claude",
            instanceId: "inst-agent-claude",
            type: "terminal-agent",
            name: "claude",
            hostId: "test-host",
          }}
          tileId="tile-claude"
          isActive
        />,
      ),
    );

    await waitFor(() => {
      expect(mockCreate.mutate).toHaveBeenCalled();
    });
    const [request] = mockCreate.mutate.mock.calls[0] as [
      { readonly cwd: string | null },
    ];
    expect(request.cwd).toBe("/tmp/repo");
  });
});
