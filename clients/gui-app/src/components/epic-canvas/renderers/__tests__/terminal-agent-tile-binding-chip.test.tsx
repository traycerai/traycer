import "../../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorktreeBinding } from "@traycer/protocol/host/worktree-schemas";
import type { TerminalSessionInfo } from "@traycer/protocol/host/terminal/unary-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";

let mockBinding: WorktreeBinding | null = null;
let mockBindingResolved = true;
let mockTerminalSessions: ReadonlyArray<TerminalSessionInfo> = [];

const dialogMocks = vi.hoisted(() => ({
  openProps: [] as unknown[],
  workspaceSelectorProps: [] as unknown[],
  terminalKillMutate: vi.fn(),
}));

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

vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    HostWorkspaceSelector: (props: {
      surface: {
        binding: WorktreeBinding | null;
        onBindingCommitted:
          ((changedWorkspacePaths: ReadonlyArray<string>) => void) | null;
      };
    }) => {
      dialogMocks.workspaceSelectorProps.push(props);
      const binding = props.surface.binding;
      if (binding === null)
        return (
          <div data-testid="host-workspace-selector">
            Worktree: not selected
          </div>
        );
      const entries = binding.entries;
      if (entries.every((e) => e.mode === "local"))
        return <div data-testid="host-workspace-selector">Local</div>;
      const primary = entries.find((e) => e.isPrimary) ?? entries[0];
      return (
        <div data-testid="host-workspace-selector">
          Worktree: {primary.branch ?? "not selected"}
        </div>
      );
    },
    ActiveHostWorkspaceControls: () => null,
  }),
);

// The tile header's agent-controls subsystem has its own tests; stub it so
// these binding-chip tests don't pull in the epic-tree selectors + agent.list
// query it depends on.
vi.mock("@/hooks/agent/use-agent-stop-controls", () => ({
  useAgentStopControls: () => ({ self: null, descendants: [] }),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useOpenEpicId: () => "epic-test",
  useEpicTerminalAgent: () => ({
    id: "agent-1",
    harnessType: "claude" as const,
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
    data: { sessions: mockTerminalSessions },
    isFetching: false,
    refetch: () =>
      Promise.resolve({ data: { sessions: mockTerminalSessions } }),
  }),
}));

vi.mock("@/hooks/terminal/use-terminal-create-mutation", () => ({
  useTerminalCreate: () => ({
    isError: false,
    isIdle: true,
    isSuccess: false,
    error: null,
    reset: () => undefined,
    mutate: () => undefined,
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

vi.mock("@/hooks/terminal/use-terminal-kill-for-mutation", () => ({
  useTerminalKillFor: () => ({
    mutate: dialogMocks.terminalKillMutate,
  }),
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
  useWorktreeGetBinding: () => ({
    data: mockBindingResolved ? { binding: mockBinding } : undefined,
    isSuccess: mockBindingResolved,
  }),
}));

vi.mock("@/hooks/worktree/use-worktree-set-local-mutation", () => ({
  useWorktreeSetLocal: () => ({
    mutate: () => undefined,
    isPending: false,
  }),
}));

vi.mock("../terminal-agent-fork-dialog", () => ({
  TerminalAgentForkDialog: (props: unknown) => {
    const dialogProps = props as { readonly open: boolean };
    if (dialogProps.open) dialogMocks.openProps.push(props);
    return null;
  },
}));

import { TuiAgentTile } from "../tui-agent-tile";
import { TabHostProvider } from "../../tab-host-provider";
import {
  pendingForkTerminalAgentStagingKey,
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
} from "@/stores/worktree/worktree-intent-staging-store";

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

describe("<TuiAgentTile /> worktree chip binding wiring", () => {
  beforeEach(() => {
    mockBinding = null;
    mockBindingResolved = true;
    mockTerminalSessions = [];
    dialogMocks.openProps.length = 0;
    dialogMocks.workspaceSelectorProps.length = 0;
    dialogMocks.terminalKillMutate.mockReset();
    useWorktreeIntentStagingStore.getState().resetForTests();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders Worktree: <branch> when the host returns a worktree-mode binding", () => {
    mockBinding = {
      entries: [
        {
          workspacePath: "/workspace/app",
          mode: "worktree",
          repoIdentifier: { owner: "acme", repo: "app" },
          worktreePath: "/worktrees/agent-1",
          branch: "feature/my-task",
          isPrimary: true,
          isImported: false,
          setupState: "succeeded",
          setupTerminalSessionId: null,
          setupExitCode: 0,
          setupFailedAt: null,
          createdAt: 0,
          ownedSubmodules: [],
        },
      ],
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
    expect(screen.getByText(/Worktree: feature\/my-task/)).toBeTruthy();
  });

  it("renders Local when the host returns a local-mode binding", () => {
    mockBinding = { entries: [] };
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
    expect(screen.getAllByText(/Local/).length).toBeGreaterThan(0);
  });

  it("keeps Fork enabled for existing terminal agents with no binding row yet", () => {
    mockBinding = null;
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

    const button = screen.getByRole("button", { name: "Fork" });
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("expected Fork to render as a button");
    }
    expect(button.disabled).toBe(false);
  });

  it("keeps Fork disabled until the source binding query resolves", () => {
    mockBinding = null;
    mockBindingResolved = false;
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

    const button = screen.getByRole("button", { name: "Fork" });
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("expected Fork to render as a button");
    }
    expect(button.disabled).toBe(true);
  });

  it("opens fork with the source owner binding overlaid by staged source intent", () => {
    mockBinding = {
      entries: [
        {
          workspacePath: "/workspace/app",
          mode: "local",
          repoIdentifier: { owner: "acme", repo: "app" },
          worktreePath: null,
          branch: "main",
          isPrimary: true,
          isImported: false,
          setupState: "not_required",
          setupTerminalSessionId: null,
          setupExitCode: null,
          setupFailedAt: null,
          createdAt: 0,
          ownedSubmodules: [],
        },
      ],
    };
    const sourceStagingKey = {
      surface: "owner" as const,
      epicId: "epic-test",
      ownerKind: "terminal-agent" as const,
      ownerId: "agent-1",
    };
    const pendingForkKey = pendingForkTerminalAgentStagingKey("epic-test");
    useWorktreeIntentStagingStore.getState().setIntent(sourceStagingKey, {
      entries: [
        {
          kind: "worktree",
          workspacePath: "/workspace/app",
          repoIdentifier: { owner: "acme", repo: "app" },
          isPrimary: true,
          branch: {
            type: "new",
            name: "feature/from-source",
            source: "main",
            carryUncommittedChanges: false,
          },
          scripts: null,
        },
      ],
    });
    useWorktreeIntentStagingStore.getState().setIntent(pendingForkKey, {
      entries: [
        {
          kind: "local",
          workspacePath: "/stale",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    });
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

    fireEvent.click(screen.getByRole("button", { name: "Fork" }));

    expect(dialogMocks.openProps).toHaveLength(1);
    const props = dialogMocks.openProps[0] as {
      readonly target: {
        readonly workspaceSeed: {
          readonly intent: {
            readonly entries: ReadonlyArray<{
              readonly kind: string;
              readonly workspacePath: string;
              readonly branch?: { readonly name: string };
            }>;
          } | null;
        };
      };
    };
    expect(props.target.workspaceSeed.intent?.entries).toMatchObject([
      {
        kind: "worktree",
        workspacePath: "/workspace/app",
        branch: { name: "feature/from-source" },
      },
    ]);
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(pendingForkKey)
      ],
    ).toBeUndefined();
  });

  it("restarts the running terminal-agent PTY after a workspace binding commit", () => {
    mockTerminalSessions = [
      {
        sessionId: "agent-1",
        epicId: "epic-test",
        sessionKind: "terminal-agent",
        cwd: "/workspace/app",
        shellCommand: "claude",
        shellArgs: [],
        cols: 80,
        rows: 24,
        status: "running",
        exitCode: null,
        createdAt: 0,
        title: null,
      },
    ];
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

    const props = dialogMocks.workspaceSelectorProps[0] as {
      readonly surface: {
        readonly onBindingCommitted:
          ((changedWorkspacePaths: ReadonlyArray<string>) => void) | null;
      };
    };
    if (props.surface.onBindingCommitted === null) {
      throw new Error("expected terminal-agent binding callback");
    }
    props.surface.onBindingCommitted(["/workspace/app"]);

    const killCall = dialogMocks.terminalKillMutate.mock.calls.at(-1) as
      | readonly [
          { readonly sessionId: string },
          { readonly onSettled: unknown },
        ]
      | undefined;
    if (killCall === undefined) {
      throw new Error("expected terminal.kill to be called");
    }
    expect(killCall[0]).toEqual({ sessionId: "agent-1" });
    expect(killCall[1].onSettled).toEqual(expect.any(Function));
  });

  it("the chip renders the bound branch even after a re-bind would replace it", () => {
    // Re-bind path: the chip starts with a worktree binding (so the
    // selector treats Create/Import as Re-bind) and the branch string
    // matches what `worktree.getBinding` returned. This guards against
    // the previous regression where the toolbar passed `binding={null}`
    // and the chip always rendered "Worktree: not selected" pre-launch.
    mockBinding = {
      entries: [
        {
          workspacePath: "/workspace/app",
          mode: "worktree",
          repoIdentifier: { owner: "acme", repo: "app" },
          worktreePath: "/worktrees/old",
          branch: "feature/old",
          isPrimary: true,
          isImported: false,
          setupState: "succeeded",
          setupTerminalSessionId: null,
          setupExitCode: 0,
          setupFailedAt: null,
          createdAt: 0,
          ownedSubmodules: [],
        },
      ],
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
    expect(screen.getByText(/Worktree: feature\/old/)).toBeTruthy();
  });
});
