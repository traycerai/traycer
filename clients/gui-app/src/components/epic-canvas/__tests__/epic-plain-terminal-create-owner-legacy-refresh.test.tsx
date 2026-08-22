import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { CanonicalTerminalSessionInfo } from "@traycer/protocol/host/terminal/unary-schemas";
import { EpicPlainTerminalCreateOwner } from "@/components/epic-canvas/epic-plain-terminal-create-owner";
import { mintNewEpicTerminalTile } from "@/components/epic-canvas/sidebar/new-terminal-tile-ref";
import {
  acceptEpicTerminalDurableCreate,
  peekEpicTerminalDurableCreate,
  purgeEpicTerminalDurableCreatesForEpic,
  resetEpicTerminalDurableCreatesForTests,
  retryEpicTerminalDurableCreate,
} from "@/lib/terminals/epic-terminal-durable-create-coordinator";
import { hasTerminalPendingCreate } from "@/lib/terminals/pending-create-identity";
import { exactTerminalListQueryKey } from "@/lib/terminals/refresh-host-terminal-list";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";

const EPIC_ID = "epic-1";
const HOST_ID = "host-1";
const SCOPE = { kind: "epic" as const, epicId: EPIC_ID };

const toastFromHostError = vi.hoisted(() =>
  vi.fn<(error: HostRpcError, fallbackMessage: string) => void>(),
);
const listedSessions = vi.hoisted(() => ({
  value: [] as CanonicalTerminalSessionInfo[],
}));
const authorityState = vi.hoisted(() => ({
  capability: "unknown",
}));

vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: (error: HostRpcError, fallbackMessage: string) =>
    toastFromHostError(error, fallbackMessage),
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: HOST_ID,
    requestContextUserId: "user-1",
    isReady: true,
  }),
}));

const hostRequest = vi.hoisted(() =>
  vi.fn<(method: string, params: unknown) => Promise<unknown>>(),
);

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => ({
    request: hostRequest,
    requestWithSignal: hostRequest,
    getActiveHostId: () => HOST_ID,
    getRequestContextUserId: () => "user-1",
  }),
}));

vi.mock("@/hooks/terminal/use-plain-terminal-authority", () => ({
  useHostPlainTerminalAuthority: () => ({
    hostId: HOST_ID,
    scope: SCOPE,
    capability: { status: authorityState.capability },
    canMutate: false,
    collection: undefined,
  }),
}));

vi.mock("@/hooks/terminal/use-plain-terminal-mutations", () => ({
  useHostPlainTerminalMutations: () => ({
    create: { mutateAsync: vi.fn() },
  }),
}));

function runningSession(sessionId: string): CanonicalTerminalSessionInfo {
  return {
    sessionId,
    scope: SCOPE,
    sessionKind: "terminal",
    cwd: "/repo",
    shellCommand: "/bin/zsh",
    shellArgs: [],
    cols: 80,
    rows: 24,
    status: "running",
    exitCode: null,
    createdAt: 0,
    title: null,
  };
}

function lostCreateError(): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: "lost response",
    requestId: "req-lost",
    method: "terminal.create",
    fatalDetails: null,
  });
}

function listFailedError(): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: "list failed",
    requestId: "req-list",
    method: "terminal.list",
    fatalDetails: null,
  });
}

function listQueryKey(): QueryKey {
  return exactTerminalListQueryKey(HOST_ID, SCOPE);
}

describe("<EpicPlainTerminalCreateOwner /> legacy list refresh", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    cleanup();
    listedSessions.value = [];
    authorityState.capability = "unknown";
    toastFromHostError.mockReset();
    hostRequest.mockReset();
    hostRequest.mockImplementation((method) => {
      if (method === "terminal.list") {
        return Promise.resolve({ sessions: listedSessions.value });
      }
      if (method === "terminal.create") {
        return Promise.reject(lostCreateError());
      }
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    resetEpicTerminalDurableCreatesForTests();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  });

  afterEach(() => {
    cleanup();
    resetEpicTerminalDurableCreatesForTests();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  function renderOwner(): RenderResult {
    const wrapper = (props: { readonly children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    return render(<EpicPlainTerminalCreateOwner epicId={EPIC_ID} />, {
      wrapper,
    });
  }

  async function mountPendingLegacyCreate(): Promise<{
    readonly terminalId: string;
    readonly tabId: string;
    readonly instanceId: string;
    readonly rendered: RenderResult;
  }> {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab(EPIC_ID, "Epic");
    const ref = mintNewEpicTerminalTile({
      hostId: HOST_ID,
      cwd: "/repo",
      epicId: EPIC_ID,
    });
    store.openTileInTab(tabId, ref);
    const rendered = renderOwner();
    await waitFor(() =>
      expect(peekEpicTerminalDurableCreate(HOST_ID, ref.id)?.status).toBe(
        "accepted",
      ),
    );
    return {
      terminalId: ref.id,
      tabId,
      instanceId: ref.instanceId,
      rendered,
    };
  }

  function closeTerminalTab(tabId: string, instanceId: string): void {
    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    if (canvas === undefined) throw new Error("expected canvas");
    const paneId = collectPanes(canvas.root)[0].id;
    useEpicCanvasStore.getState().closeCanvasTab(tabId, paneId, instanceId);
  }

  it("does not treat a stale cached row as proof when create and isolated list fail", async () => {
    const { terminalId, rendered } = await mountPendingLegacyCreate();
    const stale = runningSession(terminalId);
    queryClient.setQueryData(listQueryKey(), {
      sessions: [stale],
      homeCwd: "/stale-home",
    });

    hostRequest.mockImplementation((method) => {
      if (method === "terminal.list") {
        return Promise.reject(listFailedError());
      }
      if (method === "terminal.create") {
        return Promise.reject(lostCreateError());
      }
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    const setQueryDataSpy = vi.spyOn(queryClient, "setQueryData");
    authorityState.capability = "legacy";
    rendered.rerender(<EpicPlainTerminalCreateOwner epicId={EPIC_ID} />);

    await waitFor(() =>
      expect(peekEpicTerminalDurableCreate(HOST_ID, terminalId)?.status).toBe(
        "failed",
      ),
    );
    expect(
      hasTerminalPendingCreate(
        useEpicCanvasStore.getState().pendingCreateTerminalIdentities,
        HOST_ID,
        terminalId,
      ),
    ).toBe(true);
    expect(toastFromHostError).toHaveBeenCalled();
    expect(
      setQueryDataSpy.mock.calls.some(
        (call) => JSON.stringify(call[0]) === JSON.stringify(listQueryKey()),
      ),
    ).toBe(false);
    expect(
      queryClient
        .getQueryData<{
          readonly sessions: ReadonlyArray<{ readonly sessionId: string }>;
        }>(listQueryKey())
        ?.sessions.map((session) => session.sessionId),
    ).toEqual([terminalId]);

    setQueryDataSpy.mockRestore();
    queryClient.setQueryData(listQueryKey(), {
      sessions: [{ ...stale, title: "local-rename-patch" }],
      homeCwd: "/stale-home",
    });
    rendered.rerender(<EpicPlainTerminalCreateOwner epicId={EPIC_ID} />);
    await Promise.resolve();
    await Promise.resolve();
    expect(peekEpicTerminalDurableCreate(HOST_ID, terminalId)?.status).toBe(
      "failed",
    );
    expect(
      hasTerminalPendingCreate(
        useEpicCanvasStore.getState().pendingCreateTerminalIdentities,
        HOST_ID,
        terminalId,
      ),
    ).toBe(true);
  });

  it("does not publish a stale-generation isolated list after purge and reaccept", async () => {
    const { terminalId, rendered } = await mountPendingLegacyCreate();
    const isolatedList = Promise.withResolvers<{
      readonly sessions: CanonicalTerminalSessionInfo[];
    }>();
    let createCount = 0;
    let isolatedListCount = 0;
    hostRequest.mockImplementation((method) => {
      if (method === "terminal.list") {
        isolatedListCount += 1;
        if (isolatedListCount === 1) return isolatedList.promise;
        return new Promise(() => undefined);
      }
      if (method === "terminal.create") {
        createCount += 1;
        return Promise.reject(lostCreateError());
      }
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    const setQueryDataSpy = vi.spyOn(queryClient, "setQueryData");
    authorityState.capability = "legacy";
    rendered.rerender(<EpicPlainTerminalCreateOwner epicId={EPIC_ID} />);
    await waitFor(() => expect(isolatedListCount).toBe(1));

    purgeEpicTerminalDurableCreatesForEpic(EPIC_ID);
    acceptEpicTerminalDurableCreate({
      hostId: HOST_ID,
      terminalId,
      epicId: EPIC_ID,
      cwd: "/repo",
      cols: 80,
      rows: 24,
    });
    await waitFor(() => expect(createCount).toBeGreaterThanOrEqual(2));
    const writes = setQueryDataSpy.mock.calls.length;

    isolatedList.resolve({ sessions: [runningSession(terminalId)] });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(setQueryDataSpy.mock.calls.length).toBe(writes);
    expect(toastFromHostError).not.toHaveBeenCalled();
    expect(peekEpicTerminalDurableCreate(HOST_ID, terminalId)?.status).toBe(
      "in-flight",
    );
    expect(
      hasTerminalPendingCreate(
        useEpicCanvasStore.getState().pendingCreateTerminalIdentities,
        HOST_ID,
        terminalId,
      ),
    ).toBe(true);
    expect(
      queryClient.getQueryData<{
        readonly sessions?: ReadonlyArray<{ readonly sessionId: string }>;
      }>(listQueryKey())?.sessions ?? [],
    ).toEqual([]);
  });

  it("publishes the create response session without a terminal.list request", async () => {
    const { terminalId, tabId, instanceId, rendered } =
      await mountPendingLegacyCreate();
    closeTerminalTab(tabId, instanceId);
    expect(
      useEpicCanvasStore.getState().canvasByTabId[tabId]?.tilesByInstanceId[
        instanceId
      ],
    ).toBeUndefined();

    const created = {
      ...runningSession(terminalId),
      title: "from-create-rpc",
    };
    const events: string[] = [];
    hostRequest.mockImplementation((method, params) => {
      events.push(method);
      if (method === "terminal.list") {
        return Promise.resolve({
          sessions: listedSessions.value.map((session) => ({
            ...session,
            title: "from-list-rpc",
          })),
        });
      }
      if (method === "terminal.create") {
        const request = params as { readonly desiredSessionId: string };
        expect(request.desiredSessionId).toBe(terminalId);
        return Promise.resolve({ session: created });
      }
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    authorityState.capability = "legacy";
    rendered.rerender(<EpicPlainTerminalCreateOwner epicId={EPIC_ID} />);

    await waitFor(() =>
      expect(peekEpicTerminalDurableCreate(HOST_ID, terminalId)).toBeNull(),
    );
    expect(
      hasTerminalPendingCreate(
        useEpicCanvasStore.getState().pendingCreateTerminalIdentities,
        HOST_ID,
        terminalId,
      ),
    ).toBe(false);
    const createIndex = events.indexOf("terminal.create");
    expect(createIndex).toBeGreaterThan(-1);
    expect(events.slice(createIndex + 1)).not.toContain("terminal.list");
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(
      queryClient
        .getQueryData<{
          readonly sessions: ReadonlyArray<{ readonly title: string | null }>;
        }>(listQueryKey())
        ?.sessions.map((session) => session.title),
    ).toEqual(["from-create-rpc"]);
    expect(toastFromHostError).not.toHaveBeenCalled();
  });

  it("publishes a matching isolated list snapshot once and settles lost response", async () => {
    const { terminalId, rendered } = await mountPendingLegacyCreate();
    const discovered = runningSession(terminalId);
    let listCallsAfterCreate = 0;
    hostRequest.mockImplementation((method) => {
      if (method === "terminal.list") {
        listCallsAfterCreate += 1;
        return Promise.resolve({
          sessions: [discovered],
          homeCwd: "/fresh-home",
        });
      }
      if (method === "terminal.create") {
        return Promise.reject(lostCreateError());
      }
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    const setQueryDataSpy = vi.spyOn(queryClient, "setQueryData");
    authorityState.capability = "legacy";
    rendered.rerender(<EpicPlainTerminalCreateOwner epicId={EPIC_ID} />);

    await waitFor(() =>
      expect(peekEpicTerminalDurableCreate(HOST_ID, terminalId)).toBeNull(),
    );
    expect(
      hasTerminalPendingCreate(
        useEpicCanvasStore.getState().pendingCreateTerminalIdentities,
        HOST_ID,
        terminalId,
      ),
    ).toBe(false);
    expect(listCallsAfterCreate).toBeGreaterThanOrEqual(1);
    const exactWrites = setQueryDataSpy.mock.calls.filter(
      (call) => JSON.stringify(call[0]) === JSON.stringify(listQueryKey()),
    );
    expect(exactWrites).toHaveLength(1);
    expect(exactWrites[0]?.[1]).toEqual({
      sessions: [discovered],
      homeCwd: "/fresh-home",
    });
    expect(toastFromHostError).not.toHaveBeenCalled();
  });

  it("fails visibly when the isolated list snapshot does not contain the session", async () => {
    const { terminalId, rendered } = await mountPendingLegacyCreate();
    hostRequest.mockImplementation((method) => {
      if (method === "terminal.list") {
        return Promise.resolve({ sessions: [], homeCwd: "/fresh-home" });
      }
      if (method === "terminal.create") {
        return Promise.reject(lostCreateError());
      }
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    authorityState.capability = "legacy";
    rendered.rerender(<EpicPlainTerminalCreateOwner epicId={EPIC_ID} />);

    await waitFor(() =>
      expect(peekEpicTerminalDurableCreate(HOST_ID, terminalId)?.status).toBe(
        "failed",
      ),
    );
    expect(
      hasTerminalPendingCreate(
        useEpicCanvasStore.getState().pendingCreateTerminalIdentities,
        HOST_ID,
        terminalId,
      ),
    ).toBe(true);
    expect(toastFromHostError).toHaveBeenCalled();
    expect(
      queryClient.getQueryData<{
        readonly sessions: ReadonlyArray<unknown>;
        readonly homeCwd: string | null;
      }>(listQueryKey()),
    ).toEqual({ sessions: [], homeCwd: "/fresh-home" });
  });

  it("Retry after isolated list failure re-issues create without a discovery preflight", async () => {
    const { terminalId, rendered } = await mountPendingLegacyCreate();
    hostRequest.mockImplementation((method) => {
      if (method === "terminal.list") {
        return Promise.reject(listFailedError());
      }
      if (method === "terminal.create") {
        return Promise.reject(lostCreateError());
      }
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    authorityState.capability = "legacy";
    rendered.rerender(<EpicPlainTerminalCreateOwner epicId={EPIC_ID} />);
    await waitFor(() =>
      expect(peekEpicTerminalDurableCreate(HOST_ID, terminalId)?.status).toBe(
        "failed",
      ),
    );

    const created = {
      ...runningSession(terminalId),
      title: "from-retry-create",
    };
    const events: string[] = [];
    hostRequest.mockImplementation((method) => {
      events.push(method);
      if (method === "terminal.create") {
        return Promise.resolve({ session: created });
      }
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    retryEpicTerminalDurableCreate(HOST_ID, terminalId);
    rendered.rerender(<EpicPlainTerminalCreateOwner epicId={EPIC_ID} />);

    await waitFor(() =>
      expect(peekEpicTerminalDurableCreate(HOST_ID, terminalId)).toBeNull(),
    );
    expect(events).toEqual(["terminal.create"]);
    expect(
      queryClient
        .getQueryData<{
          readonly sessions: ReadonlyArray<{ readonly title: string | null }>;
        }>(listQueryKey())
        ?.sessions.map((session) => session.title),
    ).toEqual(["from-retry-create"]);
  });
});
