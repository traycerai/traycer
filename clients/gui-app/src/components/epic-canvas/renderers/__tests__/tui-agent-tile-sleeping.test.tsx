import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorktreeBinding } from "@traycer/protocol/host/worktree-schemas";
import type {
  AgentSessionLastExit,
  AgentSessionState,
} from "@traycer/protocol/host/agent-session-state";
import type { TuiAgentProjection } from "@/stores/epics/open-epic/types";
import type { RequestOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { TooltipProvider } from "@/components/ui/tooltip";

type PrepareLaunchRequest = RequestOfMethod<
  HostRpcRegistry,
  "agent.tui.prepareLaunch"
>;
type TerminalCreateRequest = RequestOfMethod<
  HostRpcRegistry,
  "terminal.create"
>;

let mockBinding: WorktreeBinding | null = null;
let mockBindingResolved = true;

/**
 * The knobs this suite turns: the record's session facet, whether this
 * session's open seam was called for the tile's instance id
 * (`wasTileOpenRequested`), and what the owner host reports about a running
 * PTY. Mirrors `tui-agent-tile-cloud-replica.test.tsx`'s `tileMocks` shape -
 * same bootstrap stub, same captured RPC calls - varying the SLEEPING facet
 * and the open-provenance latch instead of `origin`.
 */
const tileMocks = vi.hoisted(() => ({
  sessionState: null as AgentSessionState | null,
  lastExit: null as AgentSessionLastExit | null,
  wasOpenRequested: false,
  prepareCalls: [] as PrepareLaunchRequest[],
  createCalls: [] as TerminalCreateRequest[],
  adoptOnly: null as boolean | null | undefined,
  retryCalls: 0,
  hostHasSession: false as boolean | null,
  killCalls: [] as { readonly sessionId: string }[],
}));

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

vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    HostWorkspaceSelector: () => null,
    ActiveHostWorkspaceControls: () => null,
  }),
);

vi.mock("@/hooks/agent/use-agent-stop-controls", () => ({
  useAgentStopControls: () => ({ self: null, descendants: [] }),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useOpenEpicId: () => "epic-test",
  useEpicTerminalAgent: (): TuiAgentProjection => ({
    id: "agent-1",
    docResident: false,
    origin: "registry",
    harnessId: "claude",
    title: "Claude agent",
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    userId: "user-test",
    hostId: "host-test",
    harnessSessionId: "harness-session-1",
    terminalAgentArgs: null,
    terminalShellCommand: "claude",
    terminalShellArgs: ["--continue"],
    sessionState: tileMocks.sessionState,
    lastExit: tileMocks.lastExit,
    workspaceFolders: ["/tmp/workspace"],
    workspaceMode: undefined,
    archivedAt: null,
    model: null,
    reasoningEffort: null,
    agentMode: "regular",
    profileId: null,
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
  useTerminalCreate: () => ({
    isError: false,
    isIdle: true,
    isSuccess: false,
    error: null,
    reset: () => undefined,
    mutate: (input: TerminalCreateRequest) => {
      tileMocks.createCalls.push(input);
    },
  }),
}));

vi.mock("@/hooks/agent/use-prepare-tui-launch-mutation", () => ({
  useAgentStartTerminalSession: () => ({
    isError: false,
    isPending: false,
    isIdle: true,
    error: null,
    reset: () => undefined,
    mutateAsync: (input: PrepareLaunchRequest) => {
      tileMocks.prepareCalls.push(input);
      return new Promise(() => {});
    },
  }),
}));

vi.mock("@/hooks/terminal/use-terminal-kill-for-mutation", () => ({
  useTerminalKillFor: () => ({
    mutate: (
      input: { readonly sessionId: string },
      options: { readonly onSettled: () => void } | undefined,
    ) => {
      tileMocks.killCalls.push(input);
      options?.onSettled();
    },
  }),
}));

vi.mock(
  "@/lib/registries/terminal-session-registry",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/registries/terminal-session-registry")
    >()),
    useTerminalSessionHandle: () => null,
  }),
);

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

vi.mock("@/hooks/agent/use-tui-fork-profile-support", () => ({
  useTuiForkProfileSupported: () => true,
}));

// The restored-vs-requested latch this whole suite is about. `wasOpenRequested`
// stands in for `requestedInstanceIds.has(instanceId)` - true means "this
// session's open seam was called for this tile", false means "the persisted
// layout put it back". `markTileOpenRequested` is stubbed too since
// `reviveAfterReap` calls it via the real module in production; capturing it
// lets a case assert the click actually flipped the latch.
const provenanceMocks = vi.hoisted(() => ({ marked: [] as string[] }));
vi.mock("@/lib/canvas/tile-open/tile-open-provenance", () => ({
  wasTileOpenRequested: () => tileMocks.wasOpenRequested,
  markTileOpenRequested: (instanceId: string) => {
    provenanceMocks.marked.push(instanceId);
  },
}));

vi.mock("@/hooks/agent/use-terminal-tile-bootstrap", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/agent/use-terminal-tile-bootstrap")
    >();
  return {
    ...actual,
    useTerminalTileBootstrap: (input: {
      readonly adoptOnly?: boolean | undefined;
    }) => {
      tileMocks.adoptOnly = input.adoptOnly;
      return {
        hostHasSession: tileMocks.hostHasSession,
        hostSessionExited: false,
        handle: null,
        createIsError: false,
        createIsPending: false,
        createRetryIsPending: false,
        createIsSuccess: false,
        createError: null,
        createRetryError: null,
        retry: () => {
          tileMocks.retryCalls += 1;
        },
        reportMeasuredGrid: () => undefined,
      };
    },
  };
});

vi.mock("../terminal-agent-fork-dialog", () => ({
  TerminalAgentForkDialog: () => null,
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

function tileElement(): ReactNode {
  return (
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
    />
  );
}

function renderTile(): RenderResult {
  return render(withQueryClient(tileElement()));
}

/**
 * A RESTORED tile for a sleeping own-host agent does not start it.
 *
 * `wasOpenRequested: false` is the whole premise - a canvas whose persisted
 * layout restores ten sleeping tiles must not spawn ten provider CLIs on the
 * first show, which is precisely the cost the host's idle reap freed.
 * `adoptOnly` is asserted as the OPTION the tile hands the bootstrap, not as
 * "no create happened": a create needs a measured grid that never arrives
 * under jsdom, so an observed zero would hold whether or not the gate
 * existed - same reasoning the cloud-replica suite uses for its own gate.
 */
describe("<TuiAgentTile /> sleeping, restored", () => {
  beforeEach(() => {
    tileMocks.sessionState = "sleeping";
    tileMocks.lastExit = "reaped";
    tileMocks.wasOpenRequested = false;
    tileMocks.hostHasSession = false;
    tileMocks.adoptOnly = null;
    tileMocks.retryCalls = 0;
    tileMocks.killCalls.length = 0;
    tileMocks.prepareCalls.length = 0;
    tileMocks.createCalls.length = 0;
    provenanceMocks.marked.length = 0;
    mockBinding = null;
    mockBindingResolved = true;
  });

  afterEach(() => {
    cleanup();
  });

  it("arms adoptOnly and renders the asleep notice once the host confirms no session", async () => {
    renderTile();

    const notice = await screen.findByTestId("terminal-agent-asleep-tile-1");
    expect(notice.textContent).toContain("This agent is asleep");
    expect(tileMocks.adoptOnly).toBe(true);
    // No create attempted on the way there either - the corroborating,
    // non-load-bearing observation (see the file doc above).
    expect(tileMocks.prepareCalls).toEqual([]);
    expect(tileMocks.createCalls).toEqual([]);
  });

  it("renders NO notice once the host reports a running PTY - the archive-while-alive window", async () => {
    // `adoptOnly` still shuts the create effect, but the bootstrap ATTACHES
    // when the owner host does report a session: an agent archived while its
    // PTY was alive stays reachable until that PTY actually exits.
    tileMocks.hostHasSession = true;
    renderTile();

    await waitFor(() => {
      expect(
        screen.getByRole("toolbar", { name: "Terminal agent controls" }),
      ).toBeDefined();
    });
    expect(screen.queryByTestId("terminal-agent-asleep-tile-1")).toBeNull();
    expect(tileMocks.adoptOnly).toBe(true);
  });

  it("flips adoptOnly to false on Open, so the create can fire", async () => {
    const view = renderTile();

    await screen.findByTestId("terminal-agent-asleep-tile-1");
    expect(tileMocks.adoptOnly).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    // `reviveAfterReap` sets its OWN local `startRequested` latch (not the
    // module-level provenance registry `markTileOpenRequested` writes to -
    // that one is only ever written from the open seam) and asks the
    // bootstrap to retry.
    expect(provenanceMocks.marked).toEqual([]);
    expect(tileMocks.retryCalls).toBe(1);

    await act(async () => {
      view.rerender(withQueryClient(tileElement()));
      await Promise.resolve();
    });

    expect(tileMocks.adoptOnly).toBe(false);
    expect(screen.queryByTestId("terminal-agent-asleep-tile-1")).toBeNull();
  });
});

/**
 * The other side of the latch: a tile whose instance id WAS marked through
 * `openTileWithNavigation` in this session - a click, not a restore.
 */
describe("<TuiAgentTile /> sleeping, requested", () => {
  beforeEach(() => {
    tileMocks.sessionState = "sleeping";
    tileMocks.lastExit = "reaped";
    tileMocks.wasOpenRequested = true;
    tileMocks.hostHasSession = false;
    tileMocks.adoptOnly = null;
    tileMocks.retryCalls = 0;
    tileMocks.killCalls.length = 0;
    tileMocks.prepareCalls.length = 0;
    tileMocks.createCalls.length = 0;
    provenanceMocks.marked.length = 0;
    mockBinding = null;
    mockBindingResolved = true;
  });

  afterEach(() => {
    cleanup();
  });

  it("passes adoptOnly: false and renders no asleep notice", async () => {
    renderTile();

    await waitFor(() => {
      expect(tileMocks.adoptOnly).toBe(false);
    });
    expect(screen.queryByTestId("terminal-agent-asleep-tile-1")).toBeNull();
  });
});

/**
 * The predicate's own control cases: a `running` agent and a `null`-state one
 * (unknown - a peer host, a replica, a row from a host that predates the
 * facet) must be untouched by this gate, restored or not.
 */
describe("<TuiAgentTile /> the sleeping gate leaves running/unknown agents alone", () => {
  afterEach(() => {
    cleanup();
  });

  function resetShared(): void {
    tileMocks.wasOpenRequested = false;
    tileMocks.hostHasSession = false;
    tileMocks.adoptOnly = null;
    tileMocks.retryCalls = 0;
    tileMocks.killCalls.length = 0;
    tileMocks.prepareCalls.length = 0;
    tileMocks.createCalls.length = 0;
    provenanceMocks.marked.length = 0;
    mockBinding = null;
    mockBindingResolved = true;
  }

  it("leaves adoptOnly false for a RUNNING agent, restored or not", async () => {
    resetShared();
    tileMocks.sessionState = "running";
    tileMocks.lastExit = null;
    renderTile();

    await waitFor(() => {
      expect(tileMocks.adoptOnly).toBe(false);
    });
    expect(screen.queryByTestId("terminal-agent-asleep-tile-1")).toBeNull();
  });

  it("leaves adoptOnly false for a NULL (unknown) session state, restored or not", async () => {
    resetShared();
    tileMocks.sessionState = null;
    tileMocks.lastExit = null;
    renderTile();

    await waitFor(() => {
      expect(tileMocks.adoptOnly).toBe(false);
    });
    expect(screen.queryByTestId("terminal-agent-asleep-tile-1")).toBeNull();
  });
});
