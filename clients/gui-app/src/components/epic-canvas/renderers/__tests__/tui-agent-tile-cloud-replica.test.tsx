import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorktreeBinding } from "@traycer/protocol/host/worktree-schemas";
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

/** The subset of `TerminalAgentForkDialogProps` this file's tests read off a
 *  captured open call - not the real (unexported) prop type, since the mock
 *  below stands in for the whole component and only these fields matter here. */
interface CapturedForkDialogProps {
  readonly open: boolean;
  readonly target: { readonly intent: string } | null;
}

const tileMocks = vi.hoisted(() => ({
  openProps: [] as CapturedForkDialogProps[],
  forkProfileSupported: true,
  showAgentsAction: false,
  /** Flipped per test - the ONE input these cases vary. */
  origin: "registry" as "registry" | "cloud",
  /**
   * Every `agent.tui.prepareLaunch` this render attempted, typed as the RPC's
   * own request. Concretely typed rather than `unknown[]`: the repo bans
   * `as unknown` in tests as well as production, and the point of the ban
   * shows here - an untyped spy would keep accepting payloads after the
   * mocked boundary's signature drifted.
   */
  prepareCalls: [] as PrepareLaunchRequest[],
  /** Every `terminal.create` this render attempted, typed the same way. */
  createCalls: [] as TerminalCreateRequest[],
  /** The `adoptOnly` the tile handed the bootstrap on its last render. */
  adoptOnly: null as boolean | null | undefined,
  /** Times the tile asked the bootstrap to retry. */
  retryCalls: 0,
  /** What the owner host reports about a running PTY for this agent. */
  hostHasSession: false as boolean | null,
  /** Every `terminal.kill` the tile dispatched, by session id. */
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
    // A BUTTON named the way the REAL control is named, not a bare div: these
    // tests assert the affordance's presence and absence by role, so the
    // stand-in has to expose the same handle production does.
    //
    // `WorkspaceSummaryTrigger` is a `<button>` whose accessible name is its
    // CONTENT - the binding it renders, "Local" for a local one. That name is
    // a contract elsewhere (the home suite queries it with anchored regexes
    // like `/^beta/`), so it is reproduced here rather than improved here.
    HostWorkspaceSelector: (props: {
      surface: {
        onBindingCommitted:
          | ((changedWorkspacePaths: ReadonlyArray<string>) => void)
          | null;
      };
    }) => (
      <>
        <button type="button" data-testid="host-workspace-selector">
          Local
        </button>
        {/* The real control commits a folder change from inside its popover;
            this is that commit, reduced to the one call the tile sees. */}
        <button
          type="button"
          onClick={() => props.surface.onBindingCommitted?.([])}
        >
          Commit workspace binding
        </button>
      </>
    ),
    ActiveHostWorkspaceControls: () => null,
  }),
);

vi.mock("@/hooks/agent/use-agent-stop-controls", () => ({
  useAgentStopControls: () =>
    tileMocks.showAgentsAction
      ? {
          self: {
            id: "agent-1",
            title: "Claude agent",
            surface: "tui",
            activity: "turn",
            hostId: "host-test",
          },
          descendants: [
            {
              id: "agent-child",
              title: "Child agent",
              surface: "gui",
              activity: "turn",
              hostId: "host-test",
            },
          ],
        }
      : { self: null, descendants: [] },
}));

vi.mock("@/lib/epic-selectors", () => ({
  useOpenEpicId: () => "epic-test",
  useEpicTerminalAgent: (): TuiAgentProjection => ({
    id: "agent-1",
    docResident: false,
    origin: tileMocks.origin,
    // A cross-host replica projects the SAME inert launch fields production
    // gives it - empty folders, `regular` mode, and above all a null resume
    // id. Sending those through the ordinary path is exactly the defect
    // under test, so the fixture must not sanitize them.
    harnessId: "claude",
    title: "Claude agent",
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    userId: "user-test",
    hostId: "host-test",
    harnessSessionId: tileMocks.origin === "cloud" ? null : "harness-session-1",
    terminalAgentArgs: null,
    terminalShellCommand: "claude",
    terminalShellArgs: ["--continue"],
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
    // Recorded on a STABLE spy rather than a fresh `vi.fn()` per render: the
    // restart path is what the deferred-revalidation case turns on, and a
    // per-render mock forgets the call the moment the tile re-renders.
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
  useTuiForkProfileSupported: () => tileMocks.forkProfileSupported,
}));

// The bootstrap hook is MOCKED so the two facts this suite turns on are
// observable: the `adoptOnly` the tile passes, and whether a reaped exit asks
// it to create again. `importOriginal` keeps every other export real - the
// module also provides `TerminalXtermHost`, which the tile renders.
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

// Capture fork-dialog open props; the dialog body is not under test here.
vi.mock("../terminal-agent-fork-dialog", () => ({
  TerminalAgentForkDialog: (props: CapturedForkDialogProps) => {
    if (props.open) tileMocks.openProps.push(props);
    return null;
  },
}));

import { TuiAgentTile } from "../tui-agent-tile";
import { mayRestartAfterWorkspaceBindingChange } from "../tui-agent-workspace-restart";
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
 * A CROSS-HOST REPLICA tile is ADOPT-ONLY.
 *
 * The whole suite varies ONE input - `origin` - against a host that reports no
 * running PTY (`useTerminalList` answers an empty session list, which is the
 * `hostHasSession === false` the create effect gates on). That is the state an
 * idle-reaped agent lands in, and the state the ordinary path would answer by
 * preparing and creating.
 *
 * WHAT THAT WOULD COST, and why this is a High finding rather than a polish
 * one: a replica carries no `harnessSessionId` - it never leaves the machine
 * running the provider CLI - so the host's prepare-launch resolver reads the
 * null resume id as "new session" and mints a FRESH provider session under the
 * existing agent id. On a reachable owner host that silently replaces the
 * agent's conversation, and if the owner is still driving it, it is a second
 * driver on one CLI session. The ratified boundary is live-only: attach when
 * the owner reports a running PTY, and otherwise say so.
 */
describe("<TuiAgentTile /> cross-host replica", () => {
  beforeEach(() => {
    tileMocks.origin = "registry";
    // Default: the owner host reports NO running PTY - an idle-reaped agent,
    // and the state the ordinary path answers by preparing and creating.
    tileMocks.hostHasSession = false;
    tileMocks.adoptOnly = null;
    tileMocks.retryCalls = 0;
    tileMocks.killCalls.length = 0;
    tileMocks.openProps.length = 0;
    tileMocks.prepareCalls.length = 0;
    tileMocks.createCalls.length = 0;
    mockBinding = null;
    mockBindingResolved = true;
  });

  afterEach(() => {
    cleanup();
  });

  it("arms the bootstrap's ADOPT-ONLY gate, so no create can ever fire", async () => {
    // The load-bearing assertion, and the one that would have caught this.
    // `adoptOnly` is the bootstrap's existing "something else owns creating
    // this session" flag: it shuts the create effect permanently while still
    // arming the measure-grid wait, so the tile can attach if the owner host
    // does report a running PTY.
    //
    // Asserted as the OPTION rather than as "no create happened", because a
    // create needs a measured grid that never arrives under jsdom - so an
    // observed zero would be true whether the gate existed or not. The flag is
    // the falsifiable fact.
    tileMocks.origin = "cloud";
    renderTile();

    await screen.findByText(/is not running on/);
    expect(tileMocks.adoptOnly).toBe(true);
    // Nothing was prepared or created on the way to that state either. Weaker
    // than the flag above and kept as a corroborating observation, not as the
    // proof: a create needs a measured grid, so this zero holds under jsdom
    // whether or not the gate exists.
    expect(tileMocks.prepareCalls).toEqual([]);
    expect(tileMocks.createCalls).toEqual([]);
  });

  it("leaves the gate OFF for a registry-origin agent", async () => {
    // The control for the flag itself: a local agent must still reach the
    // launch path, or every ordinary reopen breaks.
    tileMocks.origin = "registry";
    renderTile();

    await waitFor(() => {
      expect(
        screen.getByRole("toolbar", { name: "Terminal agent controls" }),
      ).toBeDefined();
    });
    expect(tileMocks.adoptOnly).toBe(false);
  });

  it("says the agent is not running on its host, and offers only Close", async () => {
    tileMocks.origin = "cloud";
    renderTile();

    const banner = await screen.findByTestId("terminal-agent-tile-tile-1");
    expect(banner.textContent).toContain("is not running on");
    // The remedy names the machine, because that is the only place it exists.
    expect(banner.textContent).toContain("can only be started on that machine");
    expect(
      within(banner).getByRole("button", { name: "Close tab" }),
    ).toBeDefined();
  });

  it("does NOT show that banner for a registry-origin agent in the identical state", async () => {
    // The control. Same empty session list, same everything else - so the
    // banner is proven to be gated on `origin`, and not on "the host reported
    // no session", which is the ordinary pre-launch state of every local agent
    // and must still reach the launch path.
    tileMocks.origin = "registry";
    renderTile();

    await waitFor(() => {
      expect(
        screen.getByRole("toolbar", { name: "Terminal agent controls" }),
      ).toBeDefined();
    });
    // Keyed on the COPY, not the test id: the shell and the banner share
    // `terminal-agent-tile-<tileId>`, so presence of that node says nothing
    // about which branch rendered. The pre-launch toolbar above is the branch
    // marker; this is the negative half.
    expect(screen.queryByText(/is not running on/)).toBeNull();
  });

  it("offers NO fork affordance at all on a RUNNING cloud-origin agent", async () => {
    // `hostHasSession: true` is essential and not incidental: a replica whose
    // owner host has no PTY renders the banner, which has no toolbar at all -
    // so a cloud row asserted in THAT state would pass whether the fork gate
    // existed or not. The live-attached remote agent is the case where the
    // toolbar renders and the gate is the only thing removing the group.
    //
    // Not a DISABLED fork, either. Forking needs the source's
    // `harnessSessionId`, which structurally cannot cross to this machine - so
    // no readiness will ever arrive, and a disabled button whose tooltip says
    // "available after ... ready" promises exactly the capability that cannot
    // exist here.
    tileMocks.origin = "cloud";
    tileMocks.hostHasSession = true;
    renderTile();

    await waitFor(() => {
      expect(
        screen.getByRole("toolbar", { name: "Terminal agent controls" }),
      ).toBeDefined();
    });
    expect(screen.queryByRole("group", { name: "Fork actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Fork/ })).toBeNull();
  });

  it("keeps the fork affordance on a running registry-origin agent", async () => {
    tileMocks.origin = "registry";
    tileMocks.hostHasSession = true;
    renderTile();

    await waitFor(() => {
      expect(screen.getByRole("group", { name: "Fork actions" })).toBeDefined();
    });
  });

  it("offers NO workspace-binding affordance on a RUNNING cloud-origin agent", async () => {
    // `hostHasSession: true` for the same reason the fork case needs it: a
    // replica with no remote PTY renders the banner, which has no toolbar at
    // all, so the assertion would hold there whether or not the gate existed.
    //
    // A rebind is a MUTATION and a replica is read-only, but the concrete harm
    // is sharper than the principle: committing one calls back into the tile,
    // which kills the PTY by session id and recreates it - and that PTY is
    // running on the OWNER's machine. The host would refuse the rebind with
    // `TARGET_NOT_LOCAL`, but the kill is dispatched client-side first.
    tileMocks.origin = "cloud";
    tileMocks.hostHasSession = true;
    renderTile();

    await waitFor(() => {
      expect(
        screen.getByRole("toolbar", { name: "Terminal agent controls" }),
      ).toBeDefined();
    });
    expect(screen.queryByRole("button", { name: "Local" })).toBeNull();
  });

  /**
   * The deferred restart revalidates the origin when it FIRES, not only when
   * it was armed.
   *
   * A rebind committed while the session list is still settling records the
   * intent and waits; the kill happens later, when `hostHasSession` resolves
   * to `true`. Those two moments are a round trip apart, and the projection
   * can be replaced in between - so the row the intent was recorded for is not
   * necessarily the row the kill would land on.
   */
  it("drops a pending restart when the row became a replica before it could fire", async () => {
    tileMocks.origin = "registry";
    // `null` - the list is still settling - is what defers rather than kills.
    tileMocks.hostHasSession = null;
    const view = renderTile();

    const commit = await screen.findByRole("button", {
      name: "Commit workspace binding",
    });
    fireEvent.click(commit);
    expect(tileMocks.killCalls).toEqual([]);

    // The row is replaced by a replica before the list settles.
    tileMocks.origin = "cloud";
    tileMocks.hostHasSession = true;
    await act(async () => {
      view.rerender(withQueryClient(tileElement()));
      await Promise.resolve();
    });

    expect(tileMocks.killCalls).toEqual([]);

    // And the intent was CLEARED, not merely skipped: a row that becomes
    // local again must not inherit a restart nobody asked for a second time.
    tileMocks.origin = "registry";
    await act(async () => {
      view.rerender(withQueryClient(tileElement()));
      await Promise.resolve();
    });
    expect(tileMocks.killCalls).toEqual([]);
  });

  it("still fires a deferred restart for a row that stayed local", async () => {
    // The control for the case above: the deferral itself must keep working,
    // or a rebind committed mid-settle silently loses its restart and the PTY
    // keeps the old folders.
    tileMocks.origin = "registry";
    tileMocks.hostHasSession = null;
    const view = renderTile();

    fireEvent.click(
      await screen.findByRole("button", { name: "Commit workspace binding" }),
    );
    expect(tileMocks.killCalls).toEqual([]);

    tileMocks.hostHasSession = true;
    await act(async () => {
      view.rerender(withQueryClient(tileElement()));
      await Promise.resolve();
    });

    expect(tileMocks.killCalls).toEqual([{ sessionId: "agent-1" }]);
  });

  it("keeps the workspace affordance on a running registry-origin agent", async () => {
    // The control: a local agent's rebind-and-restart is a supported gesture.
    tileMocks.origin = "registry";
    tileMocks.hostHasSession = true;
    renderTile();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Local" })).toBeDefined();
    });
  });
});

/**
 * The other half of the affordance's absence, tested where a test can reach
 * it: the mutation itself.
 *
 * There is deliberately no component test invoking the commit callback on a
 * replica, because there is nothing to invoke it WITH - the toolbar renders no
 * workspace affordance for a cloud row at all (above), so no rendered gesture
 * can drive that path. Driving it would mean re-adding the very affordance the
 * fix removes. The rule the callback consults is exported instead, so the
 * refusal is a checkable fact rather than a line resting on the rendering
 * decision staying as it is.
 */
describe("mayRestartAfterWorkspaceBindingChange", () => {
  it("refuses a cloud replica", () => {
    expect(mayRestartAfterWorkspaceBindingChange("cloud")).toBe(false);
  });

  it("permits the two local origins", () => {
    expect(mayRestartAfterWorkspaceBindingChange("registry")).toBe(true);
    expect(mayRestartAfterWorkspaceBindingChange("doc")).toBe(true);
  });

  it("permits a tile whose projection has not landed yet", () => {
    // No agent means no binding to commit and no mounted toolbar to commit
    // from; refusing here would be a refusal of nothing.
    expect(mayRestartAfterWorkspaceBindingChange(null)).toBe(true);
  });
});
