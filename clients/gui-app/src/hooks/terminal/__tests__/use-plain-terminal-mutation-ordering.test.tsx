import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  renderHook,
  waitFor,
  type RenderHookResult,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/registry";
import type {
  ClosePlainTerminalResponse,
  ImportLegacyPlainTerminalResponse,
  PlainTerminalProjection,
  RenamePlainTerminalResponse,
} from "@traycer/protocol/host/terminal/plain-schemas";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import {
  deletePlainTerminal,
  replacePlainTerminalSnapshot,
  setPlainTerminalStreamStatus,
  settlePlainTerminalSnapshot,
  upsertPlainTerminal,
  type PlainTerminalCollection,
} from "@/lib/terminals/plain-terminal-authority";
import { commitPlainTerminalDeletion } from "@/lib/terminals/plain-terminal-presentation-invalidation";
import {
  usePlainTerminalMutations,
  type PlainTerminalMutations,
} from "@/hooks/terminal/use-plain-terminal-mutations";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingTerminalStore } from "@/stores/home/landing-terminal-store";

vi.mock("@/lib/host-error-toast", () => ({ toastFromHostError: vi.fn() }));

const HOST_ID = "host-ordering";
const SCOPE = { kind: "epic", epicId: "epic-ordering" } as const;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function terminal(args: {
  readonly revision: number;
  readonly manualTitle?: string | null;
  readonly activeProcessName?: string | null;
}): PlainTerminalProjection {
  return {
    record: {
      terminalId: "terminal-1",
      hostId: HOST_ID,
      scope: SCOPE,
      launch: { cwd: "/work", shellCommand: "/bin/zsh", shellArgs: [] },
      manualTitle: args.manualTitle ?? null,
      revision: args.revision,
      createdAt: "2026-08-16T10:00:00.000Z",
      updatedAt: "2026-08-16T10:00:00.000Z",
    },
    runtime: {
      status: "running",
      sessionId: "session-1",
      currentCwd: "/work/live",
      activeProcessName: args.activeProcessName ?? null,
      cols: 100,
      rows: 30,
    },
  };
}

function freshCollection(): PlainTerminalCollection {
  return setPlainTerminalStreamStatus(
    settlePlainTerminalSnapshot(
      replacePlainTerminalSnapshot(undefined, [terminal({ revision: 1 })]),
    ),
    "open",
  );
}

function setup(
  handlers: ConstructorParameters<
    typeof MockHostMessenger<HostRpcRegistry>
  >[0]["handlers"],
): {
  readonly queryClient: QueryClient;
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  readonly result: RenderHookResult<PlainTerminalMutations, unknown>["result"];
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "request-ordering",
    handlers,
  });
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger,
  });
  client.bind({ ...mockLocalHostEntry, hostId: HOST_ID });
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "token" }),
  );
  const collection = freshCollection();
  queryClient.setQueryData(
    hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
    collection,
  );
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, props.children);
  const rendered = renderHook(
    () =>
      usePlainTerminalMutations({
        authority: {
          hostId: HOST_ID,
          scope: SCOPE,
          canMutate: true,
          collection,
        },
        client,
      }),
    { wrapper: Wrapper },
  );
  return { queryClient, messenger, result: rendered.result };
}

function cached(queryClient: QueryClient): PlainTerminalCollection {
  const collection = queryClient.getQueryData<PlainTerminalCollection>(
    hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
  );
  if (collection === undefined) throw new Error("terminal cache is missing");
  return collection;
}

function seedPresentationRefs(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useEpicCanvasStore.setState({
    tabsById: {
      "tab-ordering": {
        tabId: "tab-ordering",
        epicId: "epic-ordering",
        name: "Ordering",
      },
    },
    canvasByTabId: {
      "tab-ordering": {
        root: {
          kind: "pane",
          id: "pane-ordering",
          tabInstanceIds: ["epic-ordering-ref"],
          activeTabId: "epic-ordering-ref",
          previewTabId: null,
          activationHistory: ["epic-ordering-ref"],
        },
        activePaneId: "pane-ordering",
        tilesByInstanceId: {
          "epic-ordering-ref": {
            id: "terminal-1",
            instanceId: "epic-ordering-ref",
            type: "terminal",
            name: "Ordering terminal",
            hostId: HOST_ID,
            authority: "host",
            legacyFallback: {
              name: "Ordering terminal",
              titleSource: "manual",
              cwd: "/work",
            },
          },
        },
        sizesByGroupId: {},
      },
    },
  });
  useLandingTerminalStore.getState().resetForTests();
  useLandingTerminalStore.getState().addTab({
    instanceId: "landing-ordering-ref",
    sessionId: "terminal-1",
    hostId: HOST_ID,
    cwd: "/work",
    name: "Ordering terminal",
    titleSource: "manual",
    hostAuthorityAcknowledged: true,
  });
}

function expectPresentationRefs(): void {
  expect(
    useEpicCanvasStore.getState().canvasByTabId["tab-ordering"]
      ?.tilesByInstanceId["epic-ordering-ref"],
  ).toBeDefined();
  expect(
    useLandingTerminalStore
      .getState()
      .tabs.some((tab) => tab.instanceId === "landing-ordering-ref"),
  ).toBe(true);
}

describe("plain terminal mutation projection ordering", () => {
  afterEach(() => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useLandingTerminalStore.getState().resetForTests();
  });

  it("does not let a delayed equal-revision rename replace newer stream runtime", async () => {
    const rename = deferred<RenamePlainTerminalResponse>();
    const test = setup({ "terminal.plain.rename": () => rename.promise });
    const pending = test.result.current.rename.mutateAsync({
      terminalId: "terminal-1",
      manualTitle: "renamed",
    });
    await waitFor(() => expect(test.messenger.calls).toHaveLength(1));

    test.queryClient.setQueryData<PlainTerminalCollection>(
      hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
      (current) =>
        upsertPlainTerminal(
          current,
          terminal({ revision: 1, activeProcessName: "vitest" }),
        ),
    );
    rename.resolve({
      terminal: terminal({
        revision: 1,
        manualTitle: "renamed",
        activeProcessName: "zsh",
      }),
    });
    await act(async () => pending);

    const projection = cached(test.queryClient).terminalsById["terminal-1"];
    expect(
      projection?.runtime.status === "running"
        ? projection.runtime.activeProcessName
        : null,
    ).toBe("vitest");
  });

  it("does not resurrect after a reconnect snapshot omits an in-flight request", async () => {
    const rename = deferred<RenamePlainTerminalResponse>();
    const test = setup({ "terminal.plain.rename": () => rename.promise });
    const pending = test.result.current.rename.mutateAsync({
      terminalId: "terminal-1",
      manualTitle: "late",
    });
    await waitFor(() => expect(test.messenger.calls).toHaveLength(1));

    test.queryClient.setQueryData<PlainTerminalCollection>(
      hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
      (current) =>
        replacePlainTerminalSnapshot(
          setPlainTerminalStreamStatus(current, "reconnecting"),
          [],
        ),
    );
    rename.resolve({
      terminal: terminal({ revision: 2, manualTitle: "late" }),
    });
    await act(async () => pending);
    expect(
      cached(test.queryClient).terminalsById["terminal-1"],
    ).toBeUndefined();
  });

  it("does not resurrect after an explicit delete overtakes a deferred result", async () => {
    const rename = deferred<RenamePlainTerminalResponse>();
    const test = setup({ "terminal.plain.rename": () => rename.promise });
    const pending = test.result.current.rename.mutateAsync({
      terminalId: "terminal-1",
      manualTitle: "late",
    });
    await waitFor(() => expect(test.messenger.calls).toHaveLength(1));

    test.queryClient.setQueryData<PlainTerminalCollection>(
      hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
      (current) => deletePlainTerminal(current, "terminal-1", 2),
    );
    rename.resolve({
      terminal: terminal({ revision: 2, manualTitle: "late" }),
    });
    await act(async () => pending);
    expect(
      cached(test.queryClient).terminalsById["terminal-1"],
    ).toBeUndefined();
  });

  it("orders concurrent rename/import responses by canonical revision", async () => {
    const rename = deferred<RenamePlainTerminalResponse>();
    const legacyImport = deferred<ImportLegacyPlainTerminalResponse>();
    const test = setup({
      "terminal.plain.rename": () => rename.promise,
      "terminal.plain.importLegacy": () => legacyImport.promise,
    });
    const renamePending = test.result.current.rename.mutateAsync({
      terminalId: "terminal-1",
      manualTitle: "older rename",
    });
    const importPending = test.result.current.importLegacy.mutateAsync({
      terminalId: "terminal-1",
      hostId: HOST_ID,
      scope: SCOPE,
      cwd: "/legacy",
      name: "legacy",
      titleSource: "manual",
      sourceStoreVersion: 1,
    });
    await waitFor(() => expect(test.messenger.calls).toHaveLength(2));

    legacyImport.resolve({
      status: "existing",
      terminal: terminal({ revision: 3, manualTitle: "canonical winner" }),
    });
    await act(async () => importPending);
    rename.resolve({
      terminal: terminal({ revision: 2, manualTitle: "older rename" }),
    });
    await act(async () => renamePending);
    expect(
      cached(test.queryClient).terminalsById["terminal-1"]?.record.manualTitle,
    ).toBe("canonical winner");
  });

  it.each(["close", "deleted import"] as const)(
    "rejects a stale %s without sweeping either presentation store",
    async (scenario) => {
      seedPresentationRefs();
      const close = deferred<ClosePlainTerminalResponse>();
      const legacyImport = deferred<ImportLegacyPlainTerminalResponse>();
      const test = setup({
        "terminal.plain.close": () => close.promise,
        "terminal.plain.importLegacy": () => legacyImport.promise,
      });
      const epicRemove = vi.spyOn(
        useEpicCanvasStore.getState(),
        "removeHostTerminalRefs",
      );
      const landingRemove = vi.spyOn(
        useLandingTerminalStore.getState(),
        "removeHostTerminal",
      );
      const pending =
        scenario === "close"
          ? test.result.current.close.mutateAsync({ terminalId: "terminal-1" })
          : test.result.current.importLegacy.mutateAsync({
              terminalId: "terminal-1",
              hostId: HOST_ID,
              scope: SCOPE,
              cwd: "/legacy",
              name: "Legacy",
              titleSource: "manual",
              sourceStoreVersion: 1,
            });
      await waitFor(() => expect(test.messenger.calls).toHaveLength(1));
      test.queryClient.setQueryData<PlainTerminalCollection>(
        hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
        (current) => upsertPlainTerminal(current, terminal({ revision: 3 })),
      );

      if (scenario === "close") {
        close.resolve({ terminalId: "terminal-1", revision: 2 });
      } else {
        legacyImport.resolve({
          status: "deleted",
          terminalId: "terminal-1",
          revision: 2,
        });
      }
      await act(async () => pending);

      expect(
        cached(test.queryClient).terminalsById["terminal-1"],
      ).toMatchObject({ record: { revision: 3 } });
      expectPresentationRefs();
      expect(epicRemove).not.toHaveBeenCalled();
      expect(landingRemove).not.toHaveBeenCalled();
    },
  );

  it("fans out once when stream and unary close observe the same revision", async () => {
    seedPresentationRefs();
    const close = deferred<ClosePlainTerminalResponse>();
    const test = setup({ "terminal.plain.close": () => close.promise });
    const epicRemove = vi.spyOn(
      useEpicCanvasStore.getState(),
      "removeHostTerminalRefs",
    );
    const landingRemove = vi.spyOn(
      useLandingTerminalStore.getState(),
      "removeHostTerminal",
    );
    const pending = test.result.current.close.mutateAsync({
      terminalId: "terminal-1",
    });
    await waitFor(() => expect(test.messenger.calls).toHaveLength(1));

    expect(
      commitPlainTerminalDeletion({
        queryClient: test.queryClient,
        queryKey: hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
        hostId: HOST_ID,
        terminalId: "terminal-1",
        evidence: { kind: "stream", revision: 2 },
        deferPresentation: false,
      }),
    ).toBe(true);
    const sequenceAfterStream = cached(test.queryClient).projectionSequence;
    close.resolve({ terminalId: "terminal-1", revision: 2 });
    await act(async () => pending);

    expect(cached(test.queryClient).projectionSequence).toBe(
      sequenceAfterStream,
    );
    expect(epicRemove).toHaveBeenCalledTimes(1);
    expect(landingRemove).toHaveBeenCalledTimes(1);
  });

  it.each(["close", "deleted import"] as const)(
    "clears late-hydrated epic live/closed and landing refs once on an equal %s",
    async (scenario) => {
      const close = deferred<ClosePlainTerminalResponse>();
      const legacyImport = deferred<ImportLegacyPlainTerminalResponse>();
      const test = setup({
        "terminal.plain.close": () => close.promise,
        "terminal.plain.importLegacy": () => legacyImport.promise,
      });
      expect(
        commitPlainTerminalDeletion({
          queryClient: test.queryClient,
          queryKey: hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
          hostId: HOST_ID,
          terminalId: "terminal-1",
          evidence: { kind: "stream", revision: 2 },
          deferPresentation: false,
        }),
      ).toBe(true);
      const sequenceAfterFirst = cached(test.queryClient).projectionSequence;

      useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
      useEpicCanvasStore.setState({
        tabsById: {
          "tab-late": {
            tabId: "tab-late",
            epicId: "epic-ordering",
            name: "Late",
          },
        },
        canvasByTabId: {
          "tab-late": {
            root: {
              kind: "pane",
              id: "pane-late",
              tabInstanceIds: ["late-epic-live"],
              activeTabId: "late-epic-live",
              previewTabId: null,
              activationHistory: ["late-epic-live"],
            },
            activePaneId: "pane-late",
            tilesByInstanceId: {
              "late-epic-live": {
                id: "terminal-1",
                instanceId: "late-epic-live",
                type: "terminal",
                name: "Late live",
                hostId: HOST_ID,
                titleSource: "manual",
                cwd: "/legacy",
              },
            },
            sizesByGroupId: {},
          },
        },
        closedTilePayloadsByTabId: {
          "tab-late": {
            "late-epic-closed": {
              node: {
                id: "terminal-1",
                instanceId: "late-epic-closed",
                type: "terminal",
                name: "Late closed",
                hostId: HOST_ID,
                titleSource: "manual",
                cwd: "/legacy",
              },
              pendingCreate: false,
            },
          },
        },
      });
      useLandingTerminalStore.getState().resetForTests();
      useLandingTerminalStore.getState().addTab({
        instanceId: "late-legacy",
        sessionId: "terminal-1",
        hostId: HOST_ID,
        cwd: "/legacy",
        name: "Late landing",
        titleSource: "manual",
        hostAuthorityAcknowledged: false,
      });

      const epicRemove = vi.spyOn(
        useEpicCanvasStore.getState(),
        "removeHostTerminalRefs",
      );
      const landingRemove = vi.spyOn(
        useLandingTerminalStore.getState(),
        "removeHostTerminal",
      );
      epicRemove.mockClear();
      landingRemove.mockClear();

      const pending =
        scenario === "close"
          ? test.result.current.close.mutateAsync({ terminalId: "terminal-1" })
          : test.result.current.importLegacy.mutateAsync({
              terminalId: "terminal-1",
              hostId: HOST_ID,
              scope: SCOPE,
              cwd: "/legacy",
              name: "Late landing",
              titleSource: "manual",
              sourceStoreVersion: 1,
            });
      await waitFor(() => expect(test.messenger.calls).toHaveLength(1));
      if (scenario === "close") {
        close.resolve({ terminalId: "terminal-1", revision: 2 });
      } else {
        legacyImport.resolve({
          status: "deleted",
          terminalId: "terminal-1",
          revision: 2,
        });
      }
      await act(async () => pending);

      expect(cached(test.queryClient).projectionSequence).toBe(
        sequenceAfterFirst,
      );
      expect(epicRemove).toHaveBeenCalledTimes(1);
      expect(landingRemove).toHaveBeenCalledTimes(1);
      expect(
        useEpicCanvasStore.getState().canvasByTabId["tab-late"]
          ?.tilesByInstanceId["late-epic-live"],
      ).toBeUndefined();
      expect(
        useEpicCanvasStore.getState().closedTilePayloadsByTabId["tab-late"]?.[
          "late-epic-closed"
        ],
      ).toBeUndefined();
      expect(useLandingTerminalStore.getState().tabs).toEqual([]);
    },
  );
});
