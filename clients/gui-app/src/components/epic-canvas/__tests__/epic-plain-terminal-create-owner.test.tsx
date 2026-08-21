import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { EpicPlainTerminalCreateOwner } from "@/components/epic-canvas/epic-plain-terminal-create-owner";
import { mintNewEpicTerminalTile } from "@/components/epic-canvas/sidebar/new-terminal-tile-ref";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import {
  acceptEpicTerminalDurableCreate,
  peekEpicTerminalDurableCreate,
  purgeEpicTerminalDurableCreatesForEpic,
  requestEpicTerminalDurableCreate,
  resetEpicTerminalDurableCreatesForTests,
} from "@/lib/terminals/epic-terminal-durable-create-coordinator";
import {
  emptyPlainTerminalCollection,
  plainTerminalCollectionValues,
  upsertPlainTerminal,
  type PlainTerminalCollection,
} from "@/lib/terminals/plain-terminal-authority";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import { hasTerminalPendingCreate } from "@/lib/terminals/pending-create-identity";

const EPIC_ID = "epic-1";
const HOST_ID = "host-1";
const SCOPE = { kind: "epic" as const, epicId: EPIC_ID };

const authorityState = vi.hoisted(() => ({
  capability: "unknown",
  canMutate: false,
  collection: undefined as PlainTerminalCollection | undefined,
}));
const toastFromHostError = vi.hoisted(() =>
  vi.fn<(error: HostRpcError, fallbackMessage: string) => void>(),
);
const hostRequest = vi.hoisted(() =>
  vi.fn<(method: string, params: unknown) => Promise<unknown>>(),
);

vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: (error: HostRpcError, fallbackMessage: string) =>
    toastFromHostError(error, fallbackMessage),
}));

vi.mock("@/hooks/terminal/use-plain-terminal-authority", () => ({
  useHostPlainTerminalAuthority: () => ({
    hostId: HOST_ID,
    scope: SCOPE,
    capability:
      authorityState.capability === "capable"
        ? { status: "capable", schemaVersion: { major: 1, minor: 0 } }
        : { status: authorityState.capability },
    canMutate: authorityState.canMutate,
    collection: authorityState.collection,
  }),
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => ({
    request: hostRequest,
    getActiveHostId: () => HOST_ID,
  }),
}));

function runningProjection(terminalId: string): PlainTerminalProjection {
  return {
    record: {
      terminalId,
      hostId: HOST_ID,
      scope: SCOPE,
      launch: { cwd: "/repo", shellCommand: "/bin/zsh", shellArgs: [] },
      manualTitle: null,
      revision: 1,
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
    },
    runtime: {
      status: "running",
      sessionId: terminalId,
      currentCwd: "/repo",
      activeProcessName: "zsh",
      cols: 80,
      rows: 24,
    },
  };
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: Error) => void;
} {
  let resolvePromise: ((value: Value) => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (error) => rejectPromise?.(error),
  };
}

function hostCreateCalls(method: string): unknown[] {
  return hostRequest.mock.calls
    .filter((call) => call[0] === method)
    .map((call) => call[1]);
}

describe("<EpicPlainTerminalCreateOwner />", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    cleanup();
    authorityState.capability = "unknown";
    authorityState.canMutate = false;
    authorityState.collection = undefined;
    toastFromHostError.mockReset();
    hostRequest.mockReset();
    hostRequest.mockImplementation((method) =>
      Promise.reject(new Error(`unexpected ${method}`)),
    );
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

  it("closes the tab before readiness and still creates the durable terminal once", async () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab(EPIC_ID, "Epic");
    const ref = mintNewEpicTerminalTile({
      hostId: HOST_ID,
      cwd: "/repo",
      epicId: EPIC_ID,
    });
    store.openTileInTab(tabId, ref);
    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    if (canvas === undefined) throw new Error("expected canvas");
    const paneId = collectPanes(canvas.root)[0].id;
    const pendingCreate = deferred<{ terminal: PlainTerminalProjection }>();
    hostRequest.mockImplementation((method) => {
      if (method === "terminal.plain.create") return pendingCreate.promise;
      return Promise.reject(new Error(`unexpected ${method}`));
    });

    const rendered = renderOwner();
    store.closeCanvasTab(tabId, paneId, ref.instanceId);

    expect(
      useEpicCanvasStore.getState().canvasByTabId[tabId]?.tilesByInstanceId[
        ref.instanceId
      ],
    ).toBeUndefined();
    expect(
      hasTerminalPendingCreate(
        useEpicCanvasStore.getState().pendingCreateTerminalIdentities,
        HOST_ID,
        ref.id,
      ),
    ).toBe(true);
    expect(hostCreateCalls("terminal.plain.create")).toEqual([]);
    expect(hostCreateCalls("terminal.create")).toEqual([]);
    expect(peekEpicTerminalDurableCreate(HOST_ID, ref.id)?.status).toBe(
      "accepted",
    );

    authorityState.capability = "capable";
    authorityState.canMutate = true;
    rendered.rerender(<EpicPlainTerminalCreateOwner epicId={EPIC_ID} />);

    await waitFor(() =>
      expect(hostCreateCalls("terminal.plain.create")).toHaveLength(1),
    );
    expect(hostCreateCalls("terminal.plain.create")[0]).toEqual({
      terminalId: ref.id,
      scope: SCOPE,
      cwd: "/repo",
      cols: 80,
      rows: 24,
    });

    const winner = runningProjection(ref.id);
    act(() => {
      pendingCreate.resolve({ terminal: winner });
    });

    await waitFor(() =>
      expect(
        hasTerminalPendingCreate(
          useEpicCanvasStore.getState().pendingCreateTerminalIdentities,
          HOST_ID,
          ref.id,
        ),
      ).toBe(false),
    );
    expect(peekEpicTerminalDurableCreate(HOST_ID, ref.id)).toBeNull();
    expect(
      plainTerminalCollectionValues(
        queryClient.getQueryData(hostQueryKeys.plainTerminals(HOST_ID, SCOPE)),
      ).map((terminal) => terminal.record.terminalId),
    ).toEqual([ref.id]);

    rendered.rerender(<EpicPlainTerminalCreateOwner epicId={EPIC_ID} />);
    expect(hostCreateCalls("terminal.plain.create")).toHaveLength(1);
    expect(hostCreateCalls("terminal.create")).toEqual([]);
  });

  it("dispatches exactly one legacy create after unknown-to-legacy resolution", async () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab(EPIC_ID, "Epic");
    const ref = mintNewEpicTerminalTile({
      hostId: HOST_ID,
      cwd: "/repo",
      epicId: EPIC_ID,
    });
    store.openTileInTab(tabId, ref);
    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    if (canvas === undefined) throw new Error("expected canvas");
    const paneId = collectPanes(canvas.root)[0].id;
    const pendingCreate = deferred<{ session: { sessionId: string } }>();
    hostRequest.mockImplementation((method) => {
      if (method === "terminal.create") return pendingCreate.promise;
      return Promise.reject(new Error(`unexpected ${method}`));
    });

    const rendered = renderOwner();
    store.closeCanvasTab(tabId, paneId, ref.instanceId);
    expect(hostCreateCalls("terminal.plain.create")).toEqual([]);
    expect(hostCreateCalls("terminal.create")).toEqual([]);

    authorityState.capability = "legacy";
    authorityState.canMutate = false;
    rendered.rerender(<EpicPlainTerminalCreateOwner epicId={EPIC_ID} />);

    await waitFor(() =>
      expect(hostCreateCalls("terminal.create")).toHaveLength(1),
    );
    expect(hostCreateCalls("terminal.create")[0]).toEqual({
      scope: SCOPE,
      sessionKind: "terminal",
      tuiHarnessId: null,
      cwd: "/repo",
      shellCommand: null,
      shellArgs: null,
      cols: 80,
      rows: 24,
      desiredSessionId: ref.id,
      worktreeBusyPaths: [],
    });
    expect(hostCreateCalls("terminal.plain.create")).toEqual([]);

    const listKey = hostQueryKeys.method<HostRpcRegistry, "terminal.list">(
      HOST_ID,
      "terminal.list",
      { scope: SCOPE },
    );
    act(() => {
      queryClient.setQueryData(listKey, {
        sessions: [{ sessionId: ref.id, cwd: "/repo" }],
      });
      pendingCreate.resolve({ session: { sessionId: ref.id } });
    });

    await waitFor(() =>
      expect(
        hasTerminalPendingCreate(
          useEpicCanvasStore.getState().pendingCreateTerminalIdentities,
          HOST_ID,
          ref.id,
        ),
      ).toBe(false),
    );
    expect(peekEpicTerminalDurableCreate(HOST_ID, ref.id)).toBeNull();
    const listed = queryClient.getQueryData<{
      readonly sessions: ReadonlyArray<{ readonly sessionId: string }>;
    }>(listKey);
    expect(listed?.sessions.map((session) => session.sessionId)).toEqual([
      ref.id,
    ]);
    rendered.rerender(<EpicPlainTerminalCreateOwner epicId={EPIC_ID} />);
    expect(hostCreateCalls("terminal.create")).toHaveLength(1);
  });

  it("preserves accepted jobs across ordinary owner unmount", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab(EPIC_ID, "Epic");
    const ref = mintNewEpicTerminalTile({
      hostId: HOST_ID,
      cwd: "/repo",
      epicId: EPIC_ID,
    });
    store.openTileInTab(tabId, ref);
    const rendered = renderOwner();
    expect(peekEpicTerminalDurableCreate(HOST_ID, ref.id)?.status).toBe(
      "accepted",
    );

    rendered.unmount();

    expect(peekEpicTerminalDurableCreate(HOST_ID, ref.id)?.status).toBe(
      "accepted",
    );
    expect(
      hasTerminalPendingCreate(
        useEpicCanvasStore.getState().pendingCreateTerminalIdentities,
        HOST_ID,
        ref.id,
      ),
    ).toBe(true);
  });

  it("settles a failed job when the durable row appears without the sidebar", async () => {
    const terminalId = "term-lost-response";
    acceptEpicTerminalDurableCreate({
      hostId: HOST_ID,
      terminalId,
      epicId: EPIC_ID,
      cwd: "/repo",
      cols: 80,
      rows: 24,
    });
    useEpicCanvasStore
      .getState()
      .markTerminalPendingCreate(HOST_ID, terminalId);
    await expect(
      requestEpicTerminalDurableCreate({
        hostId: HOST_ID,
        terminalId,
        ready: true,
        create: () => Promise.reject(new Error("timed out")),
        onSuccess: () => undefined,
        commit: undefined,
        onCommit: undefined,
        onFailure: undefined,
      }),
    ).rejects.toThrow("timed out");

    authorityState.capability = "capable";
    authorityState.canMutate = true;
    const rendered = renderOwner();
    expect(peekEpicTerminalDurableCreate(HOST_ID, terminalId)?.status).toBe(
      "failed",
    );

    authorityState.collection = upsertPlainTerminal(
      emptyPlainTerminalCollection(),
      runningProjection(terminalId),
    );
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
  });

  it("does not settle a failed job from a cached legacy list row", async () => {
    const terminalId = "term-legacy-lost-response";
    acceptEpicTerminalDurableCreate({
      hostId: HOST_ID,
      terminalId,
      epicId: EPIC_ID,
      cwd: "/repo",
      cols: 80,
      rows: 24,
    });
    useEpicCanvasStore
      .getState()
      .markTerminalPendingCreate(HOST_ID, terminalId);
    await expect(
      requestEpicTerminalDurableCreate({
        hostId: HOST_ID,
        terminalId,
        ready: true,
        create: () => Promise.reject(new Error("timed out")),
        onSuccess: () => undefined,
        commit: undefined,
        onCommit: undefined,
        onFailure: undefined,
      }),
    ).rejects.toThrow("timed out");

    authorityState.capability = "legacy";
    const listKey = hostQueryKeys.method<HostRpcRegistry, "terminal.list">(
      HOST_ID,
      "terminal.list",
      { scope: SCOPE },
    );
    queryClient.setQueryData(listKey, {
      sessions: [{ sessionId: terminalId, cwd: "/repo" }],
    });
    renderOwner();

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

  it("ignores stale capable success after purge and same-identity reaccept", async () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab(EPIC_ID, "Epic");
    const ref = mintNewEpicTerminalTile({
      hostId: HOST_ID,
      cwd: "/repo",
      epicId: EPIC_ID,
    });
    store.openTileInTab(tabId, ref);
    const firstCreate = deferred<{ terminal: PlainTerminalProjection }>();
    let createCount = 0;
    hostRequest.mockImplementation((method) => {
      if (method !== "terminal.plain.create") {
        return Promise.reject(new Error(`unexpected ${method}`));
      }
      createCount += 1;
      if (createCount === 1) return firstCreate.promise;
      return new Promise(() => undefined);
    });
    authorityState.capability = "capable";
    authorityState.canMutate = true;
    renderOwner();
    await waitFor(() =>
      expect(hostCreateCalls("terminal.plain.create")).toHaveLength(1),
    );

    purgeEpicTerminalDurableCreatesForEpic(EPIC_ID);
    acceptEpicTerminalDurableCreate({
      hostId: HOST_ID,
      terminalId: ref.id,
      epicId: EPIC_ID,
      cwd: "/repo",
      cols: 80,
      rows: 24,
    });
    await waitFor(() =>
      expect(hostCreateCalls("terminal.plain.create")).toHaveLength(2),
    );

    act(() => {
      firstCreate.resolve({ terminal: runningProjection(ref.id) });
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(toastFromHostError).not.toHaveBeenCalled();
    expect(peekEpicTerminalDurableCreate(HOST_ID, ref.id)?.status).toBe(
      "in-flight",
    );
    expect(
      hasTerminalPendingCreate(
        useEpicCanvasStore.getState().pendingCreateTerminalIdentities,
        HOST_ID,
        ref.id,
      ),
    ).toBe(true);
    expect(
      plainTerminalCollectionValues(
        queryClient.getQueryData(hostQueryKeys.plainTerminals(HOST_ID, SCOPE)),
      ),
    ).toEqual([]);
  });

  it("ignores stale capable failure after purge and same-identity reaccept", async () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab(EPIC_ID, "Epic");
    const ref = mintNewEpicTerminalTile({
      hostId: HOST_ID,
      cwd: "/repo",
      epicId: EPIC_ID,
    });
    store.openTileInTab(tabId, ref);
    const firstCreate = deferred<{ terminal: PlainTerminalProjection }>();
    let createCount = 0;
    hostRequest.mockImplementation((method) => {
      if (method !== "terminal.plain.create") {
        return Promise.reject(new Error(`unexpected ${method}`));
      }
      createCount += 1;
      if (createCount === 1) return firstCreate.promise;
      return new Promise(() => undefined);
    });
    authorityState.capability = "capable";
    authorityState.canMutate = true;
    renderOwner();
    await waitFor(() =>
      expect(hostCreateCalls("terminal.plain.create")).toHaveLength(1),
    );

    purgeEpicTerminalDurableCreatesForEpic(EPIC_ID);
    acceptEpicTerminalDurableCreate({
      hostId: HOST_ID,
      terminalId: ref.id,
      epicId: EPIC_ID,
      cwd: "/repo",
      cols: 80,
      rows: 24,
    });
    await waitFor(() =>
      expect(hostCreateCalls("terminal.plain.create")).toHaveLength(2),
    );

    act(() => {
      firstCreate.reject(new Error("stale capable failure"));
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(toastFromHostError).not.toHaveBeenCalled();
    expect(peekEpicTerminalDurableCreate(HOST_ID, ref.id)?.status).toBe(
      "in-flight",
    );
    expect(peekEpicTerminalDurableCreate(HOST_ID, ref.id)?.error).toBeNull();
    expect(
      hasTerminalPendingCreate(
        useEpicCanvasStore.getState().pendingCreateTerminalIdentities,
        HOST_ID,
        ref.id,
      ),
    ).toBe(true);
  });

  it("ignores stale legacy failure after purge and same-identity reaccept", async () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab(EPIC_ID, "Epic");
    const ref = mintNewEpicTerminalTile({
      hostId: HOST_ID,
      cwd: "/repo",
      epicId: EPIC_ID,
    });
    store.openTileInTab(tabId, ref);
    const firstCreate = deferred<{ session: { sessionId: string } }>();
    let createCount = 0;
    hostRequest.mockImplementation((method) => {
      if (method !== "terminal.create") {
        return Promise.reject(new Error(`unexpected ${method}`));
      }
      createCount += 1;
      if (createCount === 1) return firstCreate.promise;
      return new Promise(() => undefined);
    });
    authorityState.capability = "legacy";
    renderOwner();
    await waitFor(() =>
      expect(hostCreateCalls("terminal.create")).toHaveLength(1),
    );

    purgeEpicTerminalDurableCreatesForEpic(EPIC_ID);
    acceptEpicTerminalDurableCreate({
      hostId: HOST_ID,
      terminalId: ref.id,
      epicId: EPIC_ID,
      cwd: "/repo",
      cols: 80,
      rows: 24,
    });
    await waitFor(() =>
      expect(hostCreateCalls("terminal.create")).toHaveLength(2),
    );

    act(() => {
      firstCreate.reject(new Error("stale legacy failure"));
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(toastFromHostError).not.toHaveBeenCalled();
    expect(peekEpicTerminalDurableCreate(HOST_ID, ref.id)?.status).toBe(
      "in-flight",
    );
    expect(peekEpicTerminalDurableCreate(HOST_ID, ref.id)?.error).toBeNull();
    expect(
      hasTerminalPendingCreate(
        useEpicCanvasStore.getState().pendingCreateTerminalIdentities,
        HOST_ID,
        ref.id,
      ),
    ).toBe(true);
  });
});
