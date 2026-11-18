/**
 * Regression: a restored sleeping tile looped on `terminal.list` and never
 * showed the asleep notice. The skeleton and notice branches each mount a
 * `TerminalAgentWorktreeNotice`, which invalidates the list on mount, so a
 * branch keyed on a signal that goes `null` during a refetch flips, remounts
 * and refetches forever. `tui-agent-tile-sleeping.test.tsx` stubs
 * `hostHasSession` as a constant and cannot see it; this file drives the
 * bootstrap stub from a REAL `terminal.list` query instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TuiAgentProjection } from "@/stores/epics/open-epic/types";
import { TooltipProvider } from "@/components/ui/tooltip";

const counters = vi.hoisted(() => ({ listCalls: 0, skeletonMounts: 0 }));

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

// A sleeping agent on this host whose idle reap freed its PTY.
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
    hostId: "test-host",
    harnessSessionId: "harness-session-1",
    terminalAgentArgs: null,
    terminalShellCommand: "claude",
    terminalShellArgs: ["--continue"],
    sessionState: "sleeping",
    lastExit: "reaped",
    workspaceFolders: ["/tmp/workspace"],
    workspaceMode: undefined,
    archivedAt: null,
    model: null,
    reasoningEffort: null,
    agentMode: "regular",
    profileId: null,
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
  useTerminalKillFor: () => ({ mutate: () => undefined }),
}));

vi.mock("@/stores/epics/canvas/store", () => ({
  useEpicCanvasStore: (selector: (s: unknown) => unknown) =>
    selector({ closeCanvasTab: () => undefined }),
}));

vi.mock("@/hooks/worktree/use-worktree-get-binding-query", () => ({
  useWorktreeGetBinding: () => ({
    data: { binding: null },
    isSuccess: true,
  }),
}));

vi.mock("@/hooks/worktree/use-worktree-set-local-mutation", () => ({
  useWorktreeSetLocal: () => ({ mutate: () => undefined, isPending: false }),
}));

vi.mock("@/hooks/agent/use-tui-fork-profile-support", () => ({
  useTuiForkProfileSupported: () => true,
}));

// The bootstrap stub reads a REAL TanStack `terminal.list` query, filed under
// the tab host's `terminal.list` method scope exactly where the production
// hook files it, and derives both signals the way production does. The fake
// list never contains the agent's session, so the settled verdict is `false`.
vi.mock("@/hooks/agent/use-terminal-tile-bootstrap", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/agent/use-terminal-tile-bootstrap")
    >();
  const { useQuery } = await import("@tanstack/react-query");
  return {
    ...actual,
    useTerminalTileBootstrap: () => {
      const list = useQuery({
        queryKey: ["host", "test-host", "terminal.list", { scope: "tile" }],
        queryFn: async () => {
          counters.listCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { sessions: [] };
        },
      });
      return {
        hostHasSession:
          list.data === undefined || list.isFetching ? null : false,
        hostSessionSettled: list.data === undefined ? null : false,
        hostSessionExited: false,
        handle: null,
        createIsError: false,
        createIsPending: false,
        createRetryIsPending: false,
        createIsSuccess: false,
        createError: null,
        createRetryError: null,
        retry: () => undefined,
        reportMeasuredGrid: () => undefined,
      };
    },
  };
});

// Counts how many times the loading body mounts, the loop's other signature.
vi.mock("../terminal-loading-skeleton", async () => {
  const { useEffect } = await import("react");
  return {
    TerminalLoadingSkeleton: () => {
      useEffect(() => {
        counters.skeletonMounts += 1;
      }, []);
      return <span>Starting terminal</span>;
    },
  };
});

vi.mock("../terminal-grid-measure-probe", () => ({
  TerminalGridMeasureProbe: () => null,
}));

vi.mock("../terminal-agent-fork-dialog", () => ({
  TerminalAgentForkDialog: () => null,
}));

import { TuiAgentTile } from "../tui-agent-tile";
import { TabHostProvider } from "../../tab-host-provider";

const ASLEEP_NOTICE_ID = "terminal-agent-asleep-tile-1";

function renderRestoredSleepingTile(queryClient: QueryClient): void {
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <TabHostProvider hostId="test-host">
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
        </TabHostProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

async function settleFor(milliseconds: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  });
}

describe("<TuiAgentTile /> restored sleeping tile against a real terminal.list query", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    counters.listCalls = 0;
    counters.skeletonMounts = 0;
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
  });

  it("a restored sleeping tile settles on the asleep notice without re-fetching terminal.list in a loop", async () => {
    renderRestoredSleepingTile(queryClient);

    await settleFor(500);

    expect(screen.queryByTestId(ASLEEP_NOTICE_ID)).not.toBeNull();
    expect(counters.listCalls).toBeLessThanOrEqual(3);
    expect(counters.skeletonMounts).toBeLessThanOrEqual(2);
  });

  it("a background terminal.list refetch does not unmount the asleep notice", async () => {
    renderRestoredSleepingTile(queryClient);

    const notice = await screen.findByTestId(ASLEEP_NOTICE_ID);
    // Let the notice's own mount-time invalidation finish before counting.
    await settleFor(100);
    const callsBefore = counters.listCalls;

    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: ["host", "test-host", "terminal.list"],
      });
    });
    await settleFor(200);

    expect(counters.listCalls).toBe(callsBefore + 1);
    expect(screen.getByTestId(ASLEEP_NOTICE_ID)).toBe(notice);
  });
});
