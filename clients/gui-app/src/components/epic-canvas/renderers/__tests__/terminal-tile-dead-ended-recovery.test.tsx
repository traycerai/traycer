import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { create } from "zustand";
import type { TerminalSessionExitReason } from "@traycer/protocol/host/terminal/unary-schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { MEASURE_GRID_TIMEOUT_MS } from "@/hooks/agent/use-terminal-tile-bootstrap";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import type { EpicTerminalRef } from "@/stores/epics/canvas/types";

// `terminal-tile.tsx` drives automatic recovery off a handle that can no
// longer address its PTY: `if (status === "lost" || status === "reaped")
// onSessionLost()`. Both statuses now follow the SAME bounded-recovery
// overlay path (`resolveTerminalOverlayState` - see its own test file) - a
// mounted "reaped" handle is no longer a definitive dead end that renders a
// standalone "sessionLost" Close affordance, so this file no longer pins
// that (formerly this file's whole purpose, hence the rename from
// `terminal-tile-session-lost-overlay-close`). It now only pins the
// recovery-callback contract shared with `tui-agent-tile-dead-ended-recovery`.

const testState = vi.hoisted(() => ({
  canMutate: true,
  closeMutateAsync: vi.fn(() => Promise.resolve()),
  navigateResults: [] as Array<NestedFocusTarget | null>,
  navigateNested: vi.fn(),
  reachability: {
    status: "reachable" as const,
    hostLabel: "Host A",
    basis: "directory" as const,
    unavailability: null as string | null,
  },
  onSessionLost: vi.fn(),
}));

// A handle whose lifecycle status starts healthy and is flipped in-test, to
// pin the `onSessionLost` recovery effect's status contract.
const recoveryHandle = {
  scope: { kind: "epic" as const, epicId: "epic-1" },
  sessionId: "terminal-1",
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
    writeInput: () => undefined,
    requestResize: () => undefined,
    setWriter: () => undefined,
  })),
};

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => testState.navigateNested,
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => testState.reachability,
  resolvedHostLabel: (r: { status: string; hostLabel: string | null }) =>
    r.status === "checking" ? null : r.hostLabel,
}));

vi.mock("@/hooks/host/use-bounded-host-load", () => ({
  useBoundedHostLoad: () => ({ kind: "ready" as const }),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useOpenEpicId: () => "epic-1",
}));

vi.mock("@/hooks/terminal/use-terminal-session-recovery", () => ({
  useTerminalSessionRecovery: () => ({
    recoverNonce: 0,
    recoveryExhausted: true,
    onManualReconnect: () => undefined,
    onSessionHealthy: () => undefined,
    onSessionLost: testState.onSessionLost,
  }),
}));

vi.mock("@/hooks/agent/use-terminal-tile-bootstrap", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/agent/use-terminal-tile-bootstrap")
    >();
  return {
    ...actual,
    TerminalXtermHost: () => null,
    useTerminalTileBootstrap: () => ({
      handle: null,
      createIsError: false,
      createError: null,
      retry: () => undefined,
      hostHasSession: false,
      hostSessionExited: false,
    }),
  };
});

vi.mock(
  "@/lib/registries/terminal-session-registry",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/lib/registries/terminal-session-registry")
      >();
    return {
      ...actual,
      useTerminalSessionHandle: (args: { readonly enabled: boolean }) =>
        args.enabled ? recoveryHandle : null,
    };
  },
);

vi.mock("@/hooks/terminal/use-epic-terminal-authority", () => ({
  useEpicTerminalAuthority: () => ({
    capability: "capable",
    projection: {
      record: {
        terminalId: "terminal-1",
        hostId: "host-1",
        scope: { kind: "epic", epicId: "epic-1" },
        launch: {
          cwd: "/work/repo",
          shellCommand: "/bin/zsh",
          shellArgs: [],
        },
        manualTitle: "shell",
        revision: 1,
        createdAt: "2026-08-17T10:00:00.000Z",
        updatedAt: "2026-08-17T10:00:00.000Z",
      },
      runtime: {
        status: "running",
        sessionId: "terminal-1",
        currentCwd: "/work/repo",
        activeProcessName: null,
        cols: 80,
        rows: 24,
      },
    },
    viewModel: {
      terminalId: "terminal-1",
      manualTitle: "shell",
      activeProcessName: null,
      launchCwd: "/work/repo",
      liveCwd: "/work/repo",
      runtimeStatus: "running",
      isDormant: false,
      displayTitle: "shell",
    },
    canMutate: testState.canMutate,
    migrationPending: false,
    migrationError: null,
    retryMigration: () => undefined,
    create: { mutateAsync: vi.fn(), isPending: false },
    ensureRunning: { mutateAsync: vi.fn(), isPending: false },
    rename: { mutate: vi.fn(), isPending: false },
    close: { mutateAsync: testState.closeMutateAsync, isPending: false },
  }),
}));

vi.mock("@/hooks/terminal/use-epic-terminal-durable-create", () => ({
  useEpicTerminalDurableCreate: () => null,
}));

vi.mock("@/lib/perf/terminal-load-perf", () => ({
  beginTerminalLoad: vi.fn(),
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({
    getActiveHostId: () => HOST_ID,
    getRequestContextUserId: () => null,
    onChange: () => () => undefined,
    request: vi.fn(),
  }),
}));

vi.mock("@/lib/analytics", () => ({
  AnalyticsEvent: {
    TerminalOpened: "TerminalOpened",
    TabClosed: "TabClosed",
  },
  Analytics: {
    getInstance: () => ({ track: vi.fn() }),
  },
  analyticsTargetForCanvasTileType: () => null,
}));

vi.mock("../terminal-quote/terminal-quote-overlay", () => ({
  TerminalQuoteOverlay: () => null,
}));

import { TerminalTile } from "../terminal-tile";

const EPIC_ID = "epic-1";
const HOST_ID = "host-1";

function withTabHost(node: ReactNode): ReactNode {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <TabHostProvider hostId={HOST_ID}>{node}</TabHostProvider>
    </QueryClientProvider>
  );
}

function resetNavigationSpy(): void {
  testState.navigateResults = [];
  testState.navigateNested.mockReset();
  testState.navigateNested.mockImplementation(
    (
      _epicId: string,
      _tabId: string,
      prepare: () => NestedFocusTarget | null,
    ) => {
      const target = prepare();
      testState.navigateResults.push(target);
      return target;
    },
  );
}

function hostTerminalNode(id: string, instanceId: string): EpicTerminalRef {
  return {
    id,
    instanceId,
    type: "terminal",
    name: "shell",
    hostId: HOST_ID,
    authority: "host",
    legacyFallback: {
      name: "shell",
      titleSource: "manual",
      cwd: "/work/repo",
    },
  };
}

function openHostTerminalFixture(): {
  readonly viewTabId: string;
  readonly paneId: string;
  readonly node: EpicTerminalRef;
} {
  const store = useEpicCanvasStore.getState();
  const viewTabId = store.openEpicTab(EPIC_ID, "Epic");
  const node = hostTerminalNode("terminal-1", "inst-terminal-1");
  store.openTileInTab(viewTabId, node);
  const canvas = useEpicCanvasStore.getState().canvasByTabId[viewTabId];
  if (canvas === undefined) throw new Error("expected view tab canvas");
  const pane = collectPanes(canvas.root)[0];
  return { viewTabId, paneId: pane.id, node };
}

describe("<TerminalTile /> automatic recovery on a dead-ended handle", () => {
  beforeEach(() => {
    cleanup();
    vi.useFakeTimers();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    recoveryHandle.store.setState({
      status: "running",
      connectionStatus: "open",
      exitCode: null,
      exitReason: null,
    });
    testState.canMutate = true;
    testState.closeMutateAsync.mockReset();
    testState.onSessionLost.mockReset();
    testState.reachability = {
      status: "reachable",
      hostLabel: "Host A",
      basis: "directory",
      unavailability: null,
    };
    resetNavigationSpy();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it.each([
    { name: "reaped", status: "reaped" as const },
    { name: "lost", status: "lost" as const },
  ])(
    "drives the recovery callback once the handle status becomes $name",
    ({ status }) => {
      const fixture = openHostTerminalFixture();

      render(
        withTabHost(
          <TerminalTile
            viewTabId={fixture.viewTabId}
            node={fixture.node}
            tileId={fixture.paneId}
            isActive
          />,
        ),
      );

      act(() => {
        vi.advanceTimersByTime(MEASURE_GRID_TIMEOUT_MS);
      });

      expect(testState.onSessionLost).not.toHaveBeenCalled();

      act(() => {
        recoveryHandle.store.setState({ status });
      });

      expect(testState.onSessionLost).toHaveBeenCalledTimes(1);
    },
  );
});
