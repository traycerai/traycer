import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CanonicalTerminalSessionInfo } from "@traycer/protocol/host/terminal/unary-schemas";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SnapshotLoadingProvider } from "@/components/epic-canvas/snapshots/snapshot-loading-context";
import {
  deletePlainTerminal,
  replacePlainTerminalState,
  settlePlainTerminalSnapshot,
  type PlainTerminalCollection,
} from "@/lib/terminals/plain-terminal-authority";
import {
  findOpenArtifactInTab,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import {
  recordSetupTerminal,
  useSetupTerminalsStore,
} from "@/stores/worktree/setup-terminals";
import { useProviderLoginTerminalsStore } from "@/stores/providers/provider-login-terminals";
import {
  acceptEpicTerminalDurableCreate,
  requestEpicTerminalDurableCreate,
  resetEpicTerminalDurableCreatesForTests,
} from "@/lib/terminals/epic-terminal-durable-create-coordinator";
import { epicTerminalUiIdentityKey } from "@/lib/terminals/pending-create-identity";

const EPIC_ID = "epic-1";
const HOST_A = "host-a";
const HOST_B = "host-b";
const TAB_ID = "tab-1";

const durableCollection = vi.hoisted(() => ({
  value: null as PlainTerminalCollection | null,
}));
const listedSessions = vi.hoisted(() => ({
  value: [] as CanonicalTerminalSessionInfo[],
}));
const authority = vi.hoisted(() => ({
  capability: "capable",
  canMutate: true,
}));
const closeMutateAsync = vi.hoisted(() =>
  vi.fn((_request: { readonly hostId: string; readonly terminalId: string }) =>
    Promise.resolve(),
  ),
);
const killMutate = vi.hoisted(() => vi.fn());
const hostRequest = vi.hoisted(() =>
  vi.fn<
    (method: string, vars: { readonly terminalId: string }) => Promise<unknown>
  >(),
);

function listedSession(
  sessionId: string,
  lifecycleOwner: "registry" | "manager" | undefined,
): CanonicalTerminalSessionInfo & {
  readonly lifecycleOwner?: "registry" | "manager";
} {
  return {
    sessionId,
    scope: { kind: "epic", epicId: EPIC_ID },
    sessionKind: "terminal",
    cwd: "/tmp/work",
    shellCommand: "/bin/zsh",
    shellArgs: [],
    cols: 80,
    rows: 24,
    status: "running",
    exitCode: null,
    createdAt: 1,
    title: sessionId,
    ...(lifecycleOwner === undefined ? {} : { lifecycleOwner }),
  };
}

function durableTerminal(
  hostId: string,
  terminalId: string,
): PlainTerminalProjection {
  return {
    record: {
      terminalId,
      hostId,
      scope: { kind: "epic", epicId: EPIC_ID },
      launch: {
        cwd: "/tmp/work",
        shellCommand: "/bin/zsh",
        shellArgs: [],
      },
      manualTitle: `${hostId}:${terminalId}`,
      revision: 1,
      createdAt: "2026-08-17T10:00:00.000Z",
      updatedAt: "2026-08-17T10:00:00.000Z",
    },
    runtime: {
      status: "running",
      sessionId: terminalId,
      currentCwd: "/tmp/work",
      activeProcessName: null,
      cols: 80,
      rows: 24,
    },
  };
}

function completeFleet(
  terminals: readonly PlainTerminalProjection[],
): PlainTerminalCollection {
  return settlePlainTerminalSnapshot(
    replacePlainTerminalState(undefined, {
      coverage: "complete-fleet",
      scope: { kind: "epic", epicId: EPIC_ID },
      terminals: [...terminals],
    }),
  );
}

function partialFleet(
  servingHostId: string,
  terminals: readonly PlainTerminalProjection[],
): PlainTerminalCollection {
  return settlePlainTerminalSnapshot(
    replacePlainTerminalState(undefined, {
      coverage: "partial-serving-host",
      servingHostId,
      scope: { kind: "epic", epicId: EPIC_ID },
      terminals: [...terminals],
    }),
  );
}

vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => HOST_A,
}));

vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => ({ request: vi.fn() }),
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => ({
    request: hostRequest,
  }),
}));

vi.mock("@/lib/terminals/resolve-plain-terminal-owner-client", () => ({
  useResolvePlainTerminalOwnerHostClient: () => () => ({
    request: hostRequest,
  }),
  resolvePlainTerminalOwnerHostClient: () => ({
    request: hostRequest,
  }),
}));

vi.mock("@/hooks/terminal/use-terminal-list-query", () => ({
  useTerminalList: () => ({
    data: { sessions: listedSessions.value },
    isPending: false,
    isError: false,
    error: null,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/terminal/use-terminal-kill-for-mutation", () => ({
  useTerminalKillFor: () => ({ mutate: killMutate, isPending: false }),
}));

vi.mock("@/hooks/terminal/use-terminal-rename-for-mutation", () => ({
  useTerminalRenameFor: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/terminal/use-plain-terminal-authority", () => ({
  useHostPlainTerminalAuthority: () => ({
    hostId: HOST_A,
    scope: { kind: "epic", epicId: EPIC_ID },
    capability: { status: authority.capability },
    canMutate: authority.canMutate,
    collection: durableCollection.value,
    coverage: durableCollection.value?.coverage ?? null,
  }),
}));

vi.mock(
  "@/hooks/terminal/use-plain-terminal-mutations",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/terminal/use-plain-terminal-mutations")
      >();
    return {
      ...actual,
      useHostPlainTerminalMutations: (
        authority: Parameters<typeof actual.useHostPlainTerminalMutations>[0],
      ) => {
        const real = actual.useHostPlainTerminalMutations(authority);
        return {
          ...real,
          close: {
            ...real.close,
            mutateAsync: async (request: {
              readonly hostId: string;
              readonly terminalId: string;
            }) => {
              const pending = closeMutateAsync(request);
              const result = await real.close.mutateAsync(request);
              await pending;
              return result;
            },
          },
        };
      },
    };
  },
);

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation:
    () => (_epicId: string, _tabId: string, prepare: () => unknown) =>
      prepare(),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: (props: { readonly children: ReactNode }) => props.children,
  DropdownMenuTrigger: (props: { readonly children: ReactNode }) =>
    props.children,
  DropdownMenuContent: (props: { readonly children: ReactNode }) => (
    <div>{props.children}</div>
  ),
  DropdownMenuItem: (props: {
    readonly children: ReactNode;
    readonly onSelect: () => void;
    readonly "data-testid": string;
    readonly disabled: boolean | undefined;
  }) => (
    <button
      type="button"
      data-testid={props["data-testid"]}
      disabled={props.disabled}
      onClick={props.onSelect}
    >
      {props.children}
    </button>
  ),
  DropdownMenuSeparator: () => null,
}));

import { TerminalsPanelBody } from "../epic-terminal-sidebar";

function wrapper(node: ReactNode): ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SnapshotLoadingProvider
          value={{ snapshotLoaded: true, snapshotFetchError: null }}
        >
          {node}
        </SnapshotLoadingProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function resetOriginStores(): void {
  useSetupTerminalsStore.setState({
    trackedBySessionKey: {},
    recentKeys: [],
  });
  useProviderLoginTerminalsStore.setState({
    providerBySessionKey: {},
    recentKeys: [],
  });
}

describe("terminal sidebar source reconciliation", () => {
  beforeEach(() => {
    closeMutateAsync.mockReset();
    closeMutateAsync.mockResolvedValue(undefined);
    killMutate.mockReset();
    hostRequest.mockReset();
    hostRequest.mockImplementation((method, vars) => {
      if (method === "terminal.plain.close") {
        return Promise.resolve({
          terminalId: vars.terminalId,
          revision: 2,
        });
      }
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    authority.capability = "capable";
    authority.canMutate = true;
    listedSessions.value = [];
    durableCollection.value = null;
    resetOriginStores();
    resetEpicTerminalDurableCreatesForTests();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    resetOriginStores();
    resetEpicTerminalDurableCreatesForTests();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("renders one list from two v2 hosts without duplicating a listed shadow", () => {
    listedSessions.value = [listedSession("shared", "registry")];
    durableCollection.value = completeFleet([
      durableTerminal(HOST_A, "shared"),
      durableTerminal(HOST_B, "shared"),
    ]);
    const { getAllByTestId, queryByTestId } = render(
      wrapper(<TerminalsPanelBody epicId={EPIC_ID} tabId={TAB_ID} />),
    );
    const rows = getAllByTestId("epic-terminal-sidebar-item-shared");
    expect(rows).toHaveLength(2);
    expect(
      rows.map((row) => row.getAttribute("data-terminal-host-id")),
    ).toEqual([HOST_A, HOST_B]);
    expect(queryByTestId("epic-terminal-sidebar-incomplete-fleet")).toBeNull();
  });

  it("keeps manager-owned listed rows and suppresses an ordinary stale shadow", () => {
    listedSessions.value = [
      listedSession("setup-term", "manager"),
      listedSession("login-term", "manager"),
      listedSession("deleted-shadow", "registry"),
    ];
    durableCollection.value = deletePlainTerminal(
      completeFleet([durableTerminal(HOST_A, "deleted-shadow")]),
      { hostId: HOST_A, terminalId: "deleted-shadow" },
      2,
    );
    const { getByTestId, queryByText } = render(
      wrapper(<TerminalsPanelBody epicId={EPIC_ID} tabId={TAB_ID} />),
    );
    expect(getByTestId("epic-terminal-sidebar-item-setup-term")).not.toBeNull();
    expect(getByTestId("epic-terminal-sidebar-item-login-term")).not.toBeNull();
    expect(queryByText("deleted-shadow")).toBeNull();
  });

  it("does not promote a missing origin or renderer cache on a capable host", () => {
    recordSetupTerminal({ hostId: HOST_A, sessionId: "cached-setup" });
    listedSessions.value = [
      listedSession("cached-setup", undefined),
      listedSession("untagged-shadow", undefined),
    ];
    durableCollection.value = completeFleet([]);
    const { queryByTestId } = render(
      wrapper(<TerminalsPanelBody epicId={EPIC_ID} tabId={TAB_ID} />),
    );
    expect(queryByTestId("epic-terminal-sidebar-item-cached-setup")).toBeNull();
    expect(
      queryByTestId("epic-terminal-sidebar-item-untagged-shadow"),
    ).toBeNull();
  });

  it("shows the full listed view for a genuinely older connected host", () => {
    authority.capability = "legacy";
    authority.canMutate = false;
    listedSessions.value = [
      listedSession("legacy-a", undefined),
      listedSession("legacy-b", undefined),
    ];
    durableCollection.value = completeFleet([
      durableTerminal(HOST_B, "remote"),
    ]);
    const { getByTestId, queryByTestId } = render(
      wrapper(<TerminalsPanelBody epicId={EPIC_ID} tabId={TAB_ID} />),
    );
    expect(getByTestId("epic-terminal-sidebar-item-legacy-a")).not.toBeNull();
    expect(getByTestId("epic-terminal-sidebar-item-legacy-b")).not.toBeNull();
    expect(queryByTestId("epic-terminal-sidebar-item-remote")).toBeNull();
  });

  it("replaces a complete fleet with serving-host rows during partial coverage, then recovers", async () => {
    vi.useFakeTimers();
    listedSessions.value = [];
    durableCollection.value = completeFleet([
      durableTerminal(HOST_A, "local"),
      durableTerminal(HOST_B, "remote"),
    ]);
    const view = render(
      wrapper(<TerminalsPanelBody epicId={EPIC_ID} tabId={TAB_ID} />),
    );
    expect(view.getByTestId("epic-terminal-sidebar-item-local")).not.toBeNull();
    expect(
      view.getByTestId("epic-terminal-sidebar-item-remote"),
    ).not.toBeNull();

    durableCollection.value = partialFleet(HOST_A, [
      durableTerminal(HOST_A, "local"),
    ]);
    view.rerender(
      wrapper(<TerminalsPanelBody epicId={EPIC_ID} tabId={TAB_ID} />),
    );
    expect(
      view.queryByTestId("epic-terminal-sidebar-incomplete-fleet"),
    ).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    expect(
      view.getByTestId("epic-terminal-sidebar-incomplete-fleet"),
    ).not.toBeNull();
    expect(view.getByTestId("epic-terminal-sidebar-item-local")).not.toBeNull();
    expect(view.queryByTestId("epic-terminal-sidebar-item-remote")).toBeNull();
    expect(view.getByText(/Showing this host only/)).not.toBeNull();

    durableCollection.value = completeFleet([
      durableTerminal(HOST_A, "local"),
      durableTerminal(HOST_B, "remote-restored"),
    ]);
    view.rerender(
      wrapper(<TerminalsPanelBody epicId={EPIC_ID} tabId={TAB_ID} />),
    );
    expect(
      view.queryByTestId("epic-terminal-sidebar-incomplete-fleet"),
    ).toBeNull();
    expect(
      view.getByTestId("epic-terminal-sidebar-item-remote-restored"),
    ).not.toBeNull();
    vi.useRealTimers();
  });

  it("does not flash the incomplete-fleet notice when catalog hydration recovers within the grace", async () => {
    vi.useFakeTimers();
    durableCollection.value = partialFleet(HOST_A, []);
    const view = render(
      wrapper(<TerminalsPanelBody epicId={EPIC_ID} tabId={TAB_ID} />),
    );
    expect(
      view.queryByTestId("epic-terminal-sidebar-incomplete-fleet"),
    ).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    durableCollection.value = completeFleet([
      durableTerminal(HOST_B, "remote-before-notice"),
    ]);
    view.rerender(
      wrapper(<TerminalsPanelBody epicId={EPIC_ID} tabId={TAB_ID} />),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(
      view.queryByTestId("epic-terminal-sidebar-incomplete-fleet"),
    ).toBeNull();
    expect(
      view.getByTestId("epic-terminal-sidebar-item-remote-before-notice"),
    ).not.toBeNull();
    vi.useRealTimers();
  });

  it("keeps the sidebar row after an immediate and a delayed tab close", () => {
    durableCollection.value = completeFleet([
      durableTerminal(HOST_A, "kept-row"),
    ]);
    useEpicCanvasStore.setState({
      tabsById: {
        [TAB_ID]: { tabId: TAB_ID, epicId: EPIC_ID, name: "Epic" },
      },
    });
    const ref = {
      id: "kept-row",
      instanceId: "inst-kept",
      type: "terminal" as const,
      name: "kept-row",
      hostId: HOST_A,
      authority: "host" as const,
      legacyFallback: {
        name: "kept-row",
        titleSource: "manual" as const,
        cwd: "/tmp/work",
      },
    };
    useEpicCanvasStore.getState().openTileInTab(TAB_ID, ref);
    const { getByTestId } = render(
      wrapper(<TerminalsPanelBody epicId={EPIC_ID} tabId={TAB_ID} />),
    );
    expect(getByTestId("epic-terminal-sidebar-item-kept-row")).not.toBeNull();

    const canvas = useEpicCanvasStore.getState().canvasByTabId[TAB_ID];
    if (canvas === undefined) throw new Error("expected canvas");
    const paneId = collectPanes(canvas.root)[0].id;
    useEpicCanvasStore
      .getState()
      .closeCanvasTab(TAB_ID, paneId, ref.instanceId);

    expect(getByTestId("epic-terminal-sidebar-item-kept-row")).not.toBeNull();
    expect(closeMutateAsync).not.toHaveBeenCalled();

    useEpicCanvasStore.getState().openTileInTab(TAB_ID, {
      ...ref,
      instanceId: "inst-kept-later",
    });
    const laterCanvas = useEpicCanvasStore.getState().canvasByTabId[TAB_ID];
    if (laterCanvas === undefined) throw new Error("expected canvas");
    const laterPaneId = collectPanes(laterCanvas.root)[0].id;
    useEpicCanvasStore
      .getState()
      .closeCanvasTab(TAB_ID, laterPaneId, "inst-kept-later");
    expect(getByTestId("epic-terminal-sidebar-item-kept-row")).not.toBeNull();
    expect(closeMutateAsync).not.toHaveBeenCalled();
  });

  it("converges open presentations only after explicit sidebar delete succeeds", async () => {
    durableCollection.value = completeFleet([
      durableTerminal(HOST_A, "delete-me"),
    ]);
    useEpicCanvasStore.setState({
      tabsById: {
        [TAB_ID]: { tabId: TAB_ID, epicId: EPIC_ID, name: "Epic" },
      },
    });
    const ref = {
      id: "delete-me",
      instanceId: "inst-delete",
      type: "terminal" as const,
      name: "delete-me",
      hostId: HOST_A,
      authority: "host" as const,
      legacyFallback: {
        name: "delete-me",
        titleSource: "manual" as const,
        cwd: "/tmp/work",
      },
    };
    useEpicCanvasStore.getState().openTileInTab(TAB_ID, ref);
    useEpicCanvasStore.getState().openTileInTab(TAB_ID, {
      ...ref,
      instanceId: "inst-delete-2",
      name: "delete-me-2",
    });
    expect(findOpenArtifactInTab(TAB_ID, "delete-me")).not.toBeNull();
    const { getByTestId } = render(
      wrapper(<TerminalsPanelBody epicId={EPIC_ID} tabId={TAB_ID} />),
    );

    fireEvent.click(getByTestId("epic-terminal-sidebar-kill-menu-delete-me"));
    await waitFor(() => expect(closeMutateAsync).toHaveBeenCalledTimes(1));
    expect(closeMutateAsync.mock.calls[0]?.[0]).toEqual({
      hostId: HOST_A,
      terminalId: "delete-me",
    });
    expect(hostRequest).toHaveBeenCalledWith("terminal.plain.close", {
      terminalId: "delete-me",
    });
    await waitFor(() =>
      expect(findOpenArtifactInTab(TAB_ID, "delete-me")).toBeNull(),
    );
  });

  it("does not render or open a cached list while capability is unknown, then follows capable and legacy", () => {
    listedSessions.value = [
      listedSession("cached", "manager"),
      listedSession("shadow", "registry"),
    ];
    durableCollection.value = completeFleet([
      durableTerminal(HOST_A, "durable"),
    ]);
    authority.capability = "unknown";
    const view = render(
      wrapper(<TerminalsPanelBody epicId={EPIC_ID} tabId={TAB_ID} />),
    );
    expect(view.queryByTestId("epic-terminal-sidebar-item-cached")).toBeNull();
    expect(view.queryByTestId("epic-terminal-sidebar-item-shadow")).toBeNull();
    expect(view.queryByTestId("epic-terminal-sidebar-item-durable")).toBeNull();
    expect(view.getByText("Loading terminals…")).not.toBeNull();

    authority.capability = "capable";
    view.rerender(
      wrapper(<TerminalsPanelBody epicId={EPIC_ID} tabId={TAB_ID} />),
    );
    expect(
      view.getByTestId("epic-terminal-sidebar-item-cached"),
    ).not.toBeNull();
    expect(view.queryByTestId("epic-terminal-sidebar-item-shadow")).toBeNull();
    expect(
      view.getByTestId("epic-terminal-sidebar-item-durable"),
    ).not.toBeNull();

    authority.capability = "unknown";
    view.rerender(
      wrapper(<TerminalsPanelBody epicId={EPIC_ID} tabId={TAB_ID} />),
    );
    expect(view.queryByTestId("epic-terminal-sidebar-item-cached")).toBeNull();
    expect(view.getByText("Loading terminals…")).not.toBeNull();

    authority.capability = "legacy";
    view.rerender(
      wrapper(<TerminalsPanelBody epicId={EPIC_ID} tabId={TAB_ID} />),
    );
    expect(
      view.getByTestId("epic-terminal-sidebar-item-cached"),
    ).not.toBeNull();
    expect(
      view.getByTestId("epic-terminal-sidebar-item-shadow"),
    ).not.toBeNull();
    expect(view.queryByTestId("epic-terminal-sidebar-item-durable")).toBeNull();
  });

  it("keeps a failed-create placeholder while capability is unknown", async () => {
    authority.capability = "unknown";
    listedSessions.value = [listedSession("cached", "manager")];
    acceptEpicTerminalDurableCreate({
      hostId: HOST_A,
      terminalId: "failed-term",
      epicId: EPIC_ID,
      cwd: "/tmp/work",
      cols: 80,
      rows: 24,
    });
    await expect(
      requestEpicTerminalDurableCreate({
        hostId: HOST_A,
        terminalId: "failed-term",
        ready: true,
        create: () => Promise.reject(new Error("host offline")),
        onSuccess: () => undefined,
        commit: undefined,
        onCommit: undefined,
        onFailure: undefined,
      }),
    ).rejects.toThrow("host offline");
    const identityKey = epicTerminalUiIdentityKey(
      "failed",
      HOST_A,
      "failed-term",
    );
    const { getByTestId, queryByTestId } = render(
      wrapper(<TerminalsPanelBody epicId={EPIC_ID} tabId={TAB_ID} />),
    );
    expect(
      getByTestId(`epic-terminal-sidebar-failed-create-${identityKey}`),
    ).not.toBeNull();
    expect(queryByTestId("epic-terminal-sidebar-item-cached")).toBeNull();
    expect(queryByTestId("epic-terminal-sidebar-empty")).toBeNull();
  });

  it("kills capable-host manager rows through terminal.kill and retries after failure", () => {
    listedSessions.value = [
      listedSession("setup-term", "manager"),
      listedSession("login-term", "manager"),
    ];
    durableCollection.value = completeFleet([]);
    useEpicCanvasStore.setState({
      tabsById: {
        [TAB_ID]: { tabId: TAB_ID, epicId: EPIC_ID, name: "Epic" },
      },
    });
    useEpicCanvasStore.getState().openTileInTab(TAB_ID, {
      id: "setup-term",
      instanceId: "inst-setup",
      type: "terminal",
      name: "setup-term",
      titleSource: "default",
      hostId: HOST_A,
      cwd: "/tmp/work",
    });
    const { getByTestId } = render(
      wrapper(<TerminalsPanelBody epicId={EPIC_ID} tabId={TAB_ID} />),
    );

    fireEvent.click(getByTestId("epic-terminal-sidebar-kill-menu-setup-term"));
    expect(killMutate).toHaveBeenCalledTimes(1);
    expect(killMutate).toHaveBeenCalledWith({ sessionId: "setup-term" });
    expect(closeMutateAsync).not.toHaveBeenCalled();
    expect(findOpenArtifactInTab(TAB_ID, "setup-term")).toBeNull();
    expect(getByTestId("epic-terminal-sidebar-item-setup-term")).not.toBeNull();

    fireEvent.click(getByTestId("epic-terminal-sidebar-kill-menu-setup-term"));
    expect(killMutate).toHaveBeenCalledTimes(2);
    expect(closeMutateAsync).not.toHaveBeenCalled();

    fireEvent.click(getByTestId("epic-terminal-sidebar-kill-menu-login-term"));
    expect(killMutate).toHaveBeenCalledWith({ sessionId: "login-term" });
    expect(closeMutateAsync).not.toHaveBeenCalled();
  });

  it("opens manager rows as manager-owned even with empty or mismatched origin stores", () => {
    recordSetupTerminal({ hostId: HOST_A, sessionId: "other-term" });
    listedSessions.value = [
      listedSession("setup-term", "manager"),
      listedSession("login-term", "manager"),
    ];
    durableCollection.value = completeFleet([]);
    useEpicCanvasStore.setState({
      tabsById: {
        [TAB_ID]: { tabId: TAB_ID, epicId: EPIC_ID, name: "Epic" },
      },
    });
    const { getByTestId } = render(
      wrapper(<TerminalsPanelBody epicId={EPIC_ID} tabId={TAB_ID} />),
    );
    fireEvent.click(getByTestId("epic-terminal-sidebar-item-setup-term"));
    fireEvent.click(getByTestId("epic-terminal-sidebar-item-login-term"));
    const tiles = Object.values(
      useEpicCanvasStore.getState().canvasByTabId[TAB_ID]?.tilesByInstanceId ??
        {},
    );
    const setup = tiles.find(
      (ref) => ref?.type === "terminal" && ref.id === "setup-term",
    );
    const login = tiles.find(
      (ref) => ref?.type === "terminal" && ref.id === "login-term",
    );
    expect(setup).toMatchObject({
      type: "terminal",
      hostId: HOST_A,
      lifecycleOwner: "manager",
    });
    expect(
      setup && "origin" in setup ? setup.origin : undefined,
    ).toBeUndefined();
    expect(login).toMatchObject({
      type: "terminal",
      hostId: HOST_A,
      lifecycleOwner: "manager",
    });
    expect(hostRequest).not.toHaveBeenCalled();
  });
});
