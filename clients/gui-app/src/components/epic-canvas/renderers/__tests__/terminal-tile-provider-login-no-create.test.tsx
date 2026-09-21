import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect, useRef } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import type { EpicTerminalRef } from "@/stores/epics/canvas/types";

// Same fixture-and-mock shape as `terminal-tile-close-navigation.test.tsx`
// (nested-focus boundary, host reachability, open-epic id, recovery, perf,
// analytics) EXCEPT `use-terminal-tile-bootstrap` is left REAL here - the
// whole point of this file is proving the bootstrap's create/adopt-only wiring
// (`TerminalTile`'s host-owned `adoptOnly` derivation), which a canned-object
// mock of that hook cannot observe. Only ITS RPC-boundary dependencies are
// stubbed, mirroring `use-terminal-tile-bootstrap-no-respawn.test.tsx`.

let mockList: {
  data: { sessions: ReadonlyArray<Record<string, unknown>> } | undefined;
  isFetching: boolean;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
};
let mockCreate: {
  isError: boolean;
  isIdle: boolean;
  isSuccess: boolean;
  error: Error | null;
  reset: () => void;
  mutate: Mock;
};

const recoveryMock = vi.hoisted(() => ({ recoverNonce: 0 }));
let mockHandleEnabled: boolean | null;
const nestedFocusMock = vi.hoisted(() => ({
  navigate: vi.fn(
    (_epicId: string, _viewTabId: string, prepare: () => unknown) => prepare(),
  ),
}));

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => nestedFocusMock.navigate,
}));
vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({
    status: "reachable",
    hostLabel: "Host A",
    basis: "directory",
    unavailability: null,
  }),
  resolvedHostLabel: (r: { status: string; hostLabel: string | null }) =>
    r.status === "checking" ? null : r.hostLabel,
}));
vi.mock("@/lib/epic-selectors", () => ({
  useOpenEpicId: () => "epic-1",
}));
vi.mock("@/hooks/terminal/use-terminal-session-recovery", () => ({
  useTerminalSessionRecovery: () => ({
    recoverNonce: recoveryMock.recoverNonce,
    recoveryExhausted: false,
    onManualReconnect: () => undefined,
    onSessionHealthy: () => undefined,
    onSessionLost: () => undefined,
  }),
}));
vi.mock("@/lib/perf/terminal-load-perf", () => ({
  beginTerminalLoad: vi.fn(),
  markTerminalLoad: vi.fn(),
}));
vi.mock("@/lib/analytics", () => ({
  AnalyticsEvent: { TerminalOpened: "TerminalOpened", TabClosed: "TabClosed" },
  Analytics: { getInstance: () => ({ track: vi.fn() }) },
  analyticsTargetForCanvasTileType: () => null,
}));

const authorityMock = vi.hoisted(() => ({
  capability: "legacy",
}));

vi.mock("@/hooks/terminal/use-epic-terminal-authority", () => ({
  useEpicTerminalAuthority: () => ({
    capability: authorityMock.capability,
    projection: undefined,
    viewModel: null,
    canMutate: authorityMock.capability === "capable",
    migrationPending: false,
    migrationError: null,
    retryMigration: () => undefined,
    create: {},
    ensureRunning: {},
    rename: {},
    close: {},
  }),
}));

// Stands in for the real measure-before-subscribe probe (which mounts the
// heavy xterm engine): reports a fixed grid immediately so the bootstrap's
// gated create is free to fire in the "no host record" scenario below.
vi.mock(
  "@/components/epic-canvas/renderers/terminal-grid-measure-probe",
  () => ({
    TerminalGridMeasureProbe: (props: {
      readonly onMeasured: (cols: number, rows: number) => void;
    }) => {
      const reportOnce = useRef(props.onMeasured);
      useEffect(() => {
        reportOnce.current(120, 40);
      }, []);
      return null;
    },
  }),
);

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => ({
    hostId: HOST_ID,
    label: "Host 1",
    kind: "local",
    websocketUrl: "ws://127.0.0.1:1/rpc",
    version: null,
    transportDialability: "dialable",
  }),
}));
vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => ({
    request: () => new Promise(() => {}),
    getActiveHostId: () => HOST_ID,
    getRequestContextUserId: () => "user-1",
    onChange: () => () => undefined,
  }),
}));
vi.mock("@/hooks/terminal/use-terminal-list-query", () => ({
  useTerminalList: () => mockList,
}));
vi.mock("@/hooks/terminal/use-terminal-create-mutation", () => ({
  useTerminalCreate: () => mockCreate,
}));
vi.mock(
  "@/lib/registries/terminal-session-registry",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/registries/terminal-session-registry")
    >()),
    useTerminalSessionHandle: (args: { readonly enabled: boolean }) => {
      mockHandleEnabled = args.enabled;
      return null;
    },
  }),
);
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

import { TerminalTile } from "@/components/epic-canvas/renderers/terminal-tile";

const EPIC_ID = "epic-1";
const HOST_ID = "host-1";

function signInNode(id: string, instanceId: string): EpicTerminalRef {
  return {
    id,
    instanceId,
    type: "terminal",
    name: "Copilot sign-in",
    titleSource: "manual",
    hostId: HOST_ID,
    cwd: "~",
    origin: "provider-login",
    originProviderId: "copilot",
  };
}

function setupNode(id: string, instanceId: string): EpicTerminalRef {
  return {
    id,
    instanceId,
    type: "terminal",
    name: "Setup terminal",
    titleSource: "manual",
    hostId: HOST_ID,
    cwd: "~",
    origin: "setup",
  };
}

function shellNode(id: string, instanceId: string): EpicTerminalRef {
  return {
    id,
    instanceId,
    type: "terminal",
    name: "shell",
    titleSource: "manual",
    hostId: HOST_ID,
    cwd: "/work/repo",
  };
}

function renderTileElement(
  node: EpicTerminalRef,
  viewTabId: string,
  paneId: string,
) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <TabHostProvider hostId={HOST_ID}>
        <TerminalTile
          viewTabId={viewTabId}
          node={node}
          tileId={paneId}
          isActive
        />
      </TabHostProvider>
    </QueryClientProvider>
  );
}

function renderTile(node: EpicTerminalRef) {
  const store = useEpicCanvasStore.getState();
  const viewTabId = store.openEpicTab(EPIC_ID, "Epic");
  store.openTileInTab(viewTabId, node);
  const canvas = useEpicCanvasStore.getState().canvasByTabId[viewTabId];
  if (canvas === undefined) {
    throw new Error("expected view tab canvas");
  }
  const pane = collectPanes(canvas.root).at(0);
  if (pane === undefined) throw new Error("expected tile pane");
  return {
    ...render(renderTileElement(node, viewTabId, pane.id)),
    viewTabId,
    paneId: pane.id,
  };
}

describe("<TerminalTile /> host-owned terminal origins never dispatch terminal.create", () => {
  beforeEach(() => {
    cleanup();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    authorityMock.capability = "legacy";
    recoveryMock.recoverNonce = 0;
    mockHandleEnabled = null;
    mockCreate = {
      isError: false,
      isIdle: true,
      isSuccess: false,
      error: null,
      reset: () => undefined,
      mutate: vi.fn(),
    };
    mockList = {
      data: { sessions: [] },
      isFetching: false,
      isPending: false,
      isError: false,
      error: null,
      refetch: () => Promise.resolve({}),
    };
  });

  afterEach(() => {
    cleanup();
  });

  // Row 7's discriminating case: the host has NO record of the session, so an
  // ordinary shell tile's bootstrap WOULD dispatch `terminal.create` the
  // instant its grid is measured. A `provider-login` tile must not, however
  // long it waits - the host created this PTY, and a client-side create would
  // spawn a bare, provider-less shell in its place. Probed: swapping this
  // fixture's `origin` to `"shell"` makes `mockCreate.mutate` fire and the
  // "Sign-in terminal ended." text never render - confirmed and reverted.
  it("shows the retry affordance and never creates when the host has no record of the session", async () => {
    renderTile(signInNode("term-signin", "inst-term-signin"));

    await waitFor(() => {
      expect(screen.getByText("Sign-in terminal ended.")).toBeDefined();
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(mockCreate.mutate).not.toHaveBeenCalled();
  });

  it("never creates while the host lists the session as still running (it attaches instead)", async () => {
    mockList.data = {
      sessions: [
        {
          sessionId: "term-signin",
          sessionKind: "terminal",
          status: "running",
        },
      ],
    };
    renderTile(signInNode("term-signin", "inst-term-signin"));

    await Promise.resolve();
    await Promise.resolve();
    expect(mockCreate.mutate).not.toHaveBeenCalled();
    // Not the "ended" retry panel - the session is still alive.
    expect(screen.queryByText("Sign-in terminal ended.")).toBeNull();
  });

  it("keeps the ended panel and never creates against a capable host", async () => {
    authorityMock.capability = "capable";
    renderTile(signInNode("term-signin-capable", "inst-term-signin-capable"));

    await waitFor(() => {
      expect(screen.getByText("Sign-in terminal ended.")).toBeDefined();
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(mockCreate.mutate).not.toHaveBeenCalled();
  });

  it.each(["legacy", "capable"] as const)(
    "shows setup unavailable and never creates against a %s host",
    async (capability) => {
      vi.useFakeTimers();
      authorityMock.capability = capability;
      try {
        const node = setupNode("term-setup", "inst-term-setup");
        const rendered = renderTile(node);
        await act(async () => {
          vi.advanceTimersByTime(2_001);
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(
          screen.getByText("Setup terminal is unavailable."),
        ).toBeDefined();
        expect(
          screen.getByText("Retry setup from the agent’s setup controls."),
        ).toBeDefined();
        expect(screen.getByRole("button", { name: "Close" })).toBeDefined();
        expect(mockCreate.mutate).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(
          useEpicCanvasStore.getState().canvasByTabId[rendered.viewTabId]
            ?.tilesByInstanceId[node.instanceId],
        ).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("keeps a live setup session attachable without creating a replacement", async () => {
    mockList.data = {
      sessions: [
        {
          sessionId: "term-setup-live",
          sessionKind: "terminal",
          status: "running",
        },
      ],
    };
    renderTile(setupNode("term-setup-live", "inst-term-setup-live"));

    await waitFor(() => {
      expect(mockHandleEnabled).toBe(true);
    });
    expect(screen.queryByText("Setup terminal is unavailable.")).toBeNull();
    expect(mockCreate.mutate).not.toHaveBeenCalled();
  });

  it("waits through an initial load and refetch before declaring setup unavailable", async () => {
    const node = setupNode("term-setup-pending", "inst-term-setup-pending");
    mockList = {
      ...mockList,
      data: undefined,
      isFetching: true,
      isPending: true,
    };
    const rendered = renderTile(node);

    await Promise.resolve();
    expect(screen.queryByText("Setup terminal is unavailable.")).toBeNull();
    expect(mockCreate.mutate).not.toHaveBeenCalled();

    mockList = {
      ...mockList,
      data: { sessions: [] },
      isFetching: true,
      isPending: false,
    };
    rendered.rerender(
      renderTileElement(node, rendered.viewTabId, rendered.paneId),
    );
    await Promise.resolve();
    expect(screen.queryByText("Setup terminal is unavailable.")).toBeNull();
    expect(mockCreate.mutate).not.toHaveBeenCalled();

    mockList = {
      ...mockList,
      isFetching: false,
    };
    rendered.rerender(
      renderTileElement(node, rendered.viewTabId, rendered.paneId),
    );
    await waitFor(() => {
      expect(screen.getByText("Setup terminal is unavailable.")).toBeDefined();
    });
    expect(mockCreate.mutate).not.toHaveBeenCalled();
  });

  it("does not recreate a missing setup session after recovery remount", async () => {
    const node = setupNode("term-setup-recovery", "inst-term-setup-recovery");
    const rendered = renderTile(node);

    await waitFor(() => {
      expect(screen.getByText("Setup terminal is unavailable.")).toBeDefined();
    });
    expect(mockCreate.mutate).not.toHaveBeenCalled();

    recoveryMock.recoverNonce = 1;
    rendered.rerender(
      renderTileElement(node, rendered.viewTabId, rendered.paneId),
    );
    await waitFor(() => {
      expect(screen.getByText("Setup terminal is unavailable.")).toBeDefined();
    });
    expect(mockCreate.mutate).not.toHaveBeenCalled();
  });

  it("still creates an ordinary shell when its settled session is absent", async () => {
    renderTile(shellNode("term-shell", "inst-term-shell"));

    await waitFor(() => {
      expect(mockCreate.mutate).toHaveBeenCalledTimes(1);
    });
  });
});
