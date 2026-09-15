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

// Rendered as a bare commit button rather than `() => null`, so a test can
// perform the one gesture this surface exists for: committing a folder change,
// which is what asks the tile to restart its PTY.
vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    HostWorkspaceSelector: (props: {
      readonly surface: {
        readonly onBindingCommitted: (paths: ReadonlyArray<string>) => void;
      };
    }) => (
      <button
        type="button"
        onClick={() => props.surface.onBindingCommitted(["/w/next"])}
      >
        Commit binding
      </button>
    ),
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
//
// Stateful and NOTIFYING, mirroring the real module: the tile is expected to
// observe a mark that lands after it mounted (a terminal body is pinned, so
// focusing it does not remount it), and a mock that could only answer at
// mount time would make that untestable by construction.
const provenanceMocks = vi.hoisted(() => {
  const marked: string[] = [];
  const listeners = new Map<string, Set<() => void>>();
  return {
    marked,
    listeners,
    reset: () => {
      marked.length = 0;
      listeners.clear();
    },
  };
});
vi.mock("@/lib/canvas/tile-open/tile-open-provenance", async () => {
  const { useCallback, useSyncExternalStore } = await import("react");
  const wasTileOpenRequested = (instanceId: string): boolean =>
    tileMocks.wasOpenRequested || provenanceMocks.marked.includes(instanceId);
  const subscribeTileOpenRequested = (
    instanceId: string,
    onChange: () => void,
  ): (() => void) => {
    const set =
      provenanceMocks.listeners.get(instanceId) ?? new Set<() => void>();
    set.add(onChange);
    provenanceMocks.listeners.set(instanceId, set);
    return () => set.delete(onChange);
  };
  return {
    wasTileOpenRequested,
    subscribeTileOpenRequested,
    markTileOpenRequested: (instanceId: string) => {
      if (provenanceMocks.marked.includes(instanceId)) return;
      provenanceMocks.marked.push(instanceId);
      for (const listener of [
        ...(provenanceMocks.listeners.get(instanceId) ?? []),
      ]) {
        listener();
      }
    },
    useTileOpenRequested: (instanceId: string): boolean => {
      const subscribe = useCallback(
        (onChange: () => void) =>
          subscribeTileOpenRequested(instanceId, onChange),
        [instanceId],
      );
      const read = useCallback(
        () => wasTileOpenRequested(instanceId),
        [instanceId],
      );
      return useSyncExternalStore(subscribe, read, read);
    },
  };
});

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

import { markTileOpenRequested } from "@/lib/canvas/tile-open/tile-open-provenance";
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
    provenanceMocks.reset();
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

  it("wakes when the open seam marks it AFTER it mounted - the sidebar's dedupe path", async () => {
    // The shape the sidebar produces: the open mints a fresh uuid, dedupe
    // resolves it onto THIS already-mounted instance, and the seam marks the
    // resolved id. No remount happens - a terminal body is pinned, so focus
    // leaves it mounted - so a latch read only in a `useState` initializer
    // would never see the mark and the user would have to click Open again
    // inside the tile, which is exactly the promise the copy breaks.
    renderTile();
    await screen.findByTestId("terminal-agent-asleep-tile-1");
    expect(tileMocks.adoptOnly).toBe(true);

    await act(async () => {
      markTileOpenRequested("inst-agent-1");
      await Promise.resolve();
    });

    // THE CLAIM: the mounted tile observed it, with no rerender of its own.
    expect(tileMocks.adoptOnly).toBe(false);
    expect(screen.queryByTestId("terminal-agent-asleep-tile-1")).toBeNull();
  });

  it("ignores a mark for a DIFFERENT instance", async () => {
    renderTile();
    await screen.findByTestId("terminal-agent-asleep-tile-1");

    await act(async () => {
      markTileOpenRequested("inst-some-other-tile");
      await Promise.resolve();
    });

    expect(tileMocks.adoptOnly).toBe(true);
    expect(screen.queryByTestId("terminal-agent-asleep-tile-1")).not.toBeNull();
  });
});

/**
 * A RESTORED tile is attached to a LIVE PTY, and the user commits a folder
 * change. That is a deliberate restart, and it must end with a PTY.
 *
 * The hazard the sleeping gate introduces: the restart kills the PTY, and the
 * facet can turn `sleeping` before the retry's list settles. A restored tile
 * has `startRequested: false`, so `adoptOnly` arms on that stamp and shuts the
 * create the kill was supposed to be followed by - and only `reviveAfterReap`
 * ever set the latch. The restart becomes a STOP, on a tile the user was
 * actively using.
 */
describe("<TuiAgentTile /> a restored tile restarting after a workspace rebind", () => {
  beforeEach(() => {
    tileMocks.sessionState = "running";
    tileMocks.lastExit = null;
    // The premise. Nothing in this session opened this tile.
    tileMocks.wasOpenRequested = false;
    tileMocks.hostHasSession = true;
    tileMocks.adoptOnly = null;
    tileMocks.retryCalls = 0;
    tileMocks.killCalls.length = 0;
    tileMocks.prepareCalls.length = 0;
    tileMocks.createCalls.length = 0;
    provenanceMocks.reset();
    mockBinding = null;
    mockBindingResolved = true;
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps adoptOnly false when the facet turns sleeping mid-restart, so the replacement PTY is still created", async () => {
    const view = renderTile();
    await waitFor(() => {
      expect(
        screen.getByRole("toolbar", { name: "Terminal agent controls" }),
      ).toBeDefined();
    });
    expect(tileMocks.adoptOnly).toBe(false);

    // The restart: kill, then retry. The immediate path, since the host
    // reports a live session.
    fireEvent.click(screen.getByRole("button", { name: "Commit binding" }));
    expect(tileMocks.killCalls).toEqual([{ sessionId: "agent-1" }]);

    // The kill lands and the host reaps the agent before the retry's
    // `terminal.list` settles, so the record now says `sleeping`.
    tileMocks.sessionState = "sleeping";
    tileMocks.lastExit = "reaped";
    tileMocks.hostHasSession = false;
    await act(async () => {
      view.rerender(withQueryClient(tileElement()));
      await Promise.resolve();
    });

    // THE CLAIM. A restart the user asked for is a request, so the gate must
    // not hold the create shut. Otherwise the tile settles on the asleep
    // notice and the PTY the rebind exists to produce is never created.
    expect(tileMocks.adoptOnly).toBe(false);
    expect(screen.queryByTestId("terminal-agent-asleep-tile-1")).toBeNull();
  });

  it("sets the latch on the DEFERRED path too - presence unknown at commit time", async () => {
    // `hostHasSession === null` is `terminal.list` still refetching. The
    // commit records the intent and the effect fires the kill once presence
    // settles, so the latch must be set at the entry rather than beside the
    // immediate kill.
    tileMocks.hostHasSession = null;
    const view = renderTile();
    await waitFor(() => {
      expect(
        screen.getByRole("toolbar", { name: "Terminal agent controls" }),
      ).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: "Commit binding" }));
    // Deferred: nothing killed yet, the intent is armed and a refetch asked for.
    expect(tileMocks.killCalls).toEqual([]);
    expect(tileMocks.retryCalls).toBe(1);

    tileMocks.sessionState = "sleeping";
    tileMocks.lastExit = "reaped";
    tileMocks.hostHasSession = false;
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
    provenanceMocks.reset();
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
    provenanceMocks.reset();
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
