import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type {
  SimulatorCatalogReadResponse,
  SimulatorCatalogRecord,
} from "@traycer/protocol/host/simulator/catalog-contracts";
import type {
  SimulatorOpenResponse,
  SimulatorSession,
  SimulatorState,
} from "@traycer/protocol/host/simulator/schemas";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostTransportFailureError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import type { SimulatorSessionsState } from "@/lib/simulator-view/simulator-sessions-coordinator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { isSimulatorCatalogQueryKey } from "@/lib/query-keys/host-query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import { resetClosedSimulatorCatalogSessionsForTests } from "@/hooks/simulator/simulator-catalog-closed-sessions";
import { resetSimulatorSessionsCoordinatorsForTests } from "@/lib/simulator-view/simulator-sessions-coordinator";
import {
  resetSimulatorPendingOpensForTests,
  useSimulatorPendingOpensStore,
} from "@/stores/epics/simulator-pending-opens-store";
import type { SimulatorTileRef } from "@/stores/epics/canvas/types";

const HOST = mockLocalHostEntry.hostId;
const EPIC = "epic-1";

/** The sessions stream and the signed-in viewer: the boundaries mocked below. */
const world = vi.hoisted(() => ({
  hosts: [] as Array<{
    hostId: string;
    name: string;
    health: { state: string };
  }>,
  userId: "",
  client: null as HostClient<HostRpcRegistry> | null,
  streamByHost: new Map<string, unknown>(),
  streamListeners: new Set<() => void>(),
  openTile: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/components/settings/host-scope/use-host-options", () => ({
  useHostOptions: () => ({ hosts: world.hosts }),
}));
vi.mock("@/hooks/host/use-reactive-local-host-id", () => ({
  useReactiveLocalHostId: () => "mock-local",
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => true,
  useHostMethodSupport: () => true,
}));
vi.mock("@/hooks/host/use-request-context-user-id", () => ({
  useRequestContextUserId: () => world.userId,
}));
vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => world.client,
}));
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: world.openTile }),
}));
vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useHostClient: () => world.client,
  useHostDirectory: () => ({
    findById: (hostId: string) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
  }),
}));
vi.mock("@/lib/host/binding-host-client", () => ({
  resolveNamedHostClient: () => world.client,
}));
vi.mock("@/lib/host/read-negotiated-method-version", () => ({
  readNegotiatedMethodVersion: () => ({ major: 1, minor: 1 }),
}));
vi.mock("@traycer-clients/shared/host-transport/remote/index", () => ({
  hasReadyRemoteSession: () => false,
}));
vi.mock("@/lib/host-error-toast", () => ({ toastFromHostError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: world.toastError } }));
vi.mock("@/stores/epics/canvas/store", () => ({
  useIsActiveTile: () => false,
}));
vi.mock("../simulator-create-picker", () => ({
  SimulatorCreatePicker: () => null,
}));
vi.mock("@/lib/simulator-view/use-simulator-sessions", async () => {
  const { useSyncExternalStore: subscribeTo } = await import("react");
  return {
    useSimulatorSessionsForHost: (args: { readonly hostId: string | null }) =>
      subscribeTo(
        (listener) => {
          world.streamListeners.add(listener);
          return () => world.streamListeners.delete(listener);
        },
        () => world.streamByHost.get(args.hostId ?? ""),
      ),
  };
});

import { SimulatorCatalogProvider } from "@/components/epic-canvas/renderers/simulator-catalog-provider";
import { useSimulatorInstanceOpen } from "@/hooks/simulator/use-simulator-instance-open";
import { SimulatorsPanelBody } from "../epic-simulators-panel";
import {
  buildSimulatorListGroups,
  type SimulatorEndedRow,
  type SimulatorLiveRow,
} from "../use-simulator-list-model";

const IPHONE = {
  simulatorId: "udid-1",
  platform: "ios",
  name: "iPhone 16",
  version: "18.0",
} as const;

function record(
  sessionId: string,
  overrides: Partial<SimulatorCatalogRecord>,
): SimulatorCatalogRecord {
  return {
    epicId: EPIC,
    hostId: HOST,
    sessionId,
    inventoryRevision: 1,
    lastActivityAt: 100,
    instanceKey: "udid-1",
    simulatorId: "udid-1",
    name: "iPhone 16",
    platform: "ios",
    version: "18.0",
    cloneOf: null,
    drivenByAgent: false,
    idleUntil: null,
    endedReason: null,
    ...overrides,
  };
}

describe("buildSimulatorListGroups", () => {
  const hosts = new Map<string, HostScopeOption>();

  it("gives one live row and one closed row for a live and an ended record on one instance", () => {
    const live = record("session-live", { lastActivityAt: 200 });
    const ended = record("session-ended", { endedReason: "archived" });

    const groups = buildSimulatorListGroups({
      records: [ended, live],
      pending: [],
      hosts,
      localHostId: null,
    });

    expect(groups).toHaveLength(1);
    const rows = groups[0].rows;
    expect(rows.map((row) => row.kind).sort()).toEqual(["ended", "live"]);
    const liveRow = rows.find(
      (row): row is SimulatorLiveRow => row.kind === "live",
    );
    const endedRow = rows.find(
      (row): row is SimulatorEndedRow => row.kind === "ended",
    );
    expect(liveRow?.records.map((item) => item.sessionId)).toEqual([
      "session-live",
    ]);
    expect(endedRow?.record.sessionId).toBe("session-ended");
    expect(endedRow?.reason).toBe("archived");
    expect(endedRow?.key).not.toBe(liveRow?.key);
  });

  it("folds the person's and the agent's sessions on one instance into one live row", () => {
    const person = record("session-person", {
      lastActivityAt: 300,
      drivenByAgent: false,
      idleUntil: null,
    });
    const agent = record("session-agent", {
      lastActivityAt: 100,
      drivenByAgent: true,
      idleUntil: 9_000,
    });

    const [group] = buildSimulatorListGroups({
      records: [agent, person],
      pending: [],
      hosts,
      localHostId: null,
    });

    expect(group.rows).toHaveLength(1);
    const [row] = group.rows;
    if (row.kind !== "live") throw new Error("expected the live row");
    expect(row.records.map((item) => item.sessionId)).toEqual([
      "session-person",
      "session-agent",
    ]);
    expect(row.drivenByAgent).toBe(true);
    expect(row.idleUntil).toBe(9_000);
  });

  it("groups the same instance key on two machines apart, local machine first", () => {
    const groups = buildSimulatorListGroups({
      records: [
        record("a", { hostId: "host-a" }),
        record("b", { hostId: "host-b" }),
      ],
      pending: [],
      hosts,
      localHostId: "host-b",
    });

    expect(groups.map((group) => group.hostId)).toEqual(["host-b", "host-a"]);
    expect(groups.map((group) => group.isLocal)).toEqual([true, false]);
    expect(groups.map((group) => group.rows.length)).toEqual([1, 1]);
  });
});

const STREAM_BASE: SimulatorState = {
  revision: 1,
  hostId: HOST,
  platforms: [{ platform: "ios", available: true, reason: null }],
  packState: { kind: "ready", reason: null, progress: null },
  hubState: { kind: "running", lastError: null },
  simulators: [],
  sessions: [],
  booting: [],
  opening: [],
};

function publishStream(patch: Partial<SimulatorState>): void {
  const previous = world.streamByHost.get(HOST);
  const revision =
    previous !== undefined && isStream(previous)
      ? (previous.state?.revision ?? 0) + 1
      : 1;
  const next: SimulatorSessionsState = {
    hostId: HOST,
    lifecycle: "live",
    state: { ...STREAM_BASE, ...patch, revision },
    errorMessage: null,
    refresh: () => undefined,
    retry: () => undefined,
  };
  world.streamByHost.set(HOST, next);
  act(() => {
    for (const listener of world.streamListeners) listener();
  });
}

function isStream(value: unknown): value is SimulatorSessionsState {
  return typeof value === "object" && value !== null && "lifecycle" in value;
}

/** The host's side: the catalog it lists and how each open answers. */
const host_ = {
  catalog: { kind: "available", snapshot: { version: 1, records: [] } } as
    | SimulatorCatalogReadResponse
    | { kind: "not-ready" },
  catalogReads: 0,
  openAnswer: (): Promise<SimulatorOpenResponse> => new Promise(() => {}),
  closes: [] as unknown[],
  opens: [] as unknown[],
};

function setCatalog(records: readonly SimulatorCatalogRecord[]): void {
  host_.catalog = {
    kind: "available",
    snapshot: { version: 1, records: [...records] },
  };
}

function openResponse(sessionId: string): SimulatorOpenResponse {
  const session: SimulatorSession = {
    epicId: EPIC,
    ownerUserId: world.userId,
    hostId: HOST,
    simulatorId: "udid-1",
    platform: "ios",
    openedAt: "2026-10-29T00:00:00.000Z",
    sessionId,
    instanceKey: "udid-1",
    agentId: null,
  };
  return {
    session,
    simulator: { ...IPHONE, booted: true, physical: false },
  };
}

let queryClient: QueryClient;

function OpenControls(props: {
  readonly place: (ref: SimulatorTileRef) => void;
}) {
  const { open } = useSimulatorInstanceOpen(EPIC);
  return (
    <>
      <button
        type="button"
        onClick={() =>
          open({
            hostId: HOST,
            target: IPHONE,
            instance: "auto",
            place: props.place,
          })
        }
      >
        Boot
      </button>
      <button
        type="button"
        onClick={() =>
          open({
            hostId: HOST,
            target: IPHONE,
            instance: "udid-1",
            place: props.place,
          })
        }
      >
        Watch
      </button>
    </>
  );
}

function renderPanel(place: (ref: SimulatorTileRef) => void) {
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SimulatorCatalogProvider epicId={EPIC}>
          {children}
        </SimulatorCatalogProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
  return render(
    wrap(
      <>
        <OpenControls place={place} />
        <SimulatorsPanelBody epicId={EPIC} tabId="tab-1" />
      </>,
    ),
  );
}

/** Makes the next catalog read happen now, as the 30 s poll or a head wake would. */
async function refreshCatalog(): Promise<void> {
  await act(async () => {
    await queryClient.invalidateQueries({
      predicate: (query) =>
        isSimulatorCatalogQueryKey(query.queryKey, world.userId, EPIC),
    });
  });
}

function rowFor(instanceKey: string): HTMLElement {
  return screen.getByTestId(`epic-simulator-row-${instanceKey}`);
}

describe("Mobile simulators panel", () => {
  beforeEach(() => {
    resetSimulatorPendingOpensForTests();
    resetClosedSimulatorCatalogSessionsForTests();
    resetSimulatorSessionsCoordinatorsForTests();
    world.hosts = [
      { hostId: HOST, name: "Studio Mac", health: { state: "online" } },
    ];
    world.streamByHost.clear();
    // Until a case publishes state the stream is still connecting.
    const connecting: SimulatorSessionsState = {
      hostId: HOST,
      lifecycle: "connecting",
      state: null,
      errorMessage: null,
      refresh: () => undefined,
      retry: () => undefined,
    };
    world.streamByHost.set(HOST, connecting);
    world.openTile.mockReset();
    world.toastError.mockReset();
    host_.catalogReads = 0;
    host_.closes = [];
    host_.opens = [];
    host_.openAnswer = () => new Promise(() => {});
    setCatalog([]);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "request",
      handlers: {
        "simulator.catalog.read": () => {
          host_.catalogReads += 1;
          return host_.catalog;
        },
        "simulator.open": (params) => {
          host_.opens.push(params);
          return host_.openAnswer();
        },
        "simulator.close": (params) => {
          host_.closes.push(params);
          return { closed: 1 };
        },
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: { invalidateHostScope: () => undefined },
      schedulingPolicy: hostRpcSchedulingPolicy,
      findHostById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
      messenger,
    });
    const context = createRequestContextFixture({ origin: "renderer" });
    spine.setRequestContext(context);
    world.userId = context.identity.userId;
    world.client = spine.createRequester(mockLocalHostEntry);
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: world.userId,
        userName: world.userId,
        email: "u@example.com",
      },
      contextMetadata: { userId: world.userId, username: world.userId },
    });
  });
  afterEach(() => {
    cleanup();
    useAuthStore.setState(useAuthStore.getInitialState(), true);
  });

  it("shows the live row with the Agent badge and the idle countdown, and a closed row beside it", async () => {
    setCatalog([
      record("session-live", {
        drivenByAgent: true,
        idleUntil: Date.now() + 6 * 60_000 + 30_000,
      }),
      record("session-ended", { endedReason: "archived" }),
    ]);
    renderPanel(vi.fn());

    const row = await screen.findByTestId("epic-simulator-row-udid-1");
    expect(within(row).getByText("Agent")).toBeTruthy();
    expect(
      screen.getByTestId("epic-simulator-row-countdown-udid-1").textContent,
    ).toBe("Idle · powers off in 7 min");
    expect(
      screen.getByTestId("epic-simulator-ended-row-session-ended").textContent,
    ).toContain("Ended when its agent was archived");
  });

  it("says Mobile simulators in tasks aren't available yet when the catalog is not ready", async () => {
    host_.catalog = { kind: "not-ready" };
    renderPanel(vi.fn());

    expect(
      (await screen.findByTestId("simulator-list-not-ready")).textContent,
    ).toBe("Mobile simulators in tasks aren't available yet.");
    expect(screen.queryByTestId("simulator-list-empty-state")).toBeNull();
  });

  it("dismisses a closed row with a close for that one record, and a stale read that still lists it shows no row", async () => {
    setCatalog([
      record("session-live", {}),
      record("session-ended", { endedReason: "idle" }),
    ]);
    renderPanel(vi.fn());
    const dismiss = await screen.findByTestId(
      "epic-simulator-row-dismiss-session-ended",
    );
    expect(
      screen.getByTestId("epic-simulator-ended-row-session-ended").textContent,
    ).toContain("Powered off after being idle");

    fireEvent.click(dismiss);

    await waitFor(() => {
      expect(host_.closes).toEqual([
        {
          epicId: EPIC,
          simulatorId: "udid-1",
          shutdown: false,
          sessionId: "session-ended",
        },
      ]);
    });
    await waitFor(() => {
      expect(
        screen.queryByTestId("epic-simulator-ended-row-session-ended"),
      ).toBeNull();
    });
    // The host still lists the record (its tombstone has not landed): a fresh
    // read must not bring the row back, and the live row is untouched.
    const readsBefore = host_.catalogReads;
    await refreshCatalog();
    await waitFor(() => {
      expect(host_.catalogReads).toBeGreaterThan(readsBefore);
    });
    expect(
      screen.queryByTestId("epic-simulator-ended-row-session-ended"),
    ).toBeNull();
    expect(rowFor("udid-1")).toBeTruthy();
  });

  it("closes every session in a row, one close per session", async () => {
    setCatalog([
      record("session-person", { lastActivityAt: 300 }),
      record("session-agent", { lastActivityAt: 100, drivenByAgent: true }),
    ]);
    renderPanel(vi.fn());

    fireEvent.click(
      await screen.findByTestId("epic-simulator-row-close-udid-1"),
    );

    await waitFor(() => {
      expect(host_.closes).toHaveLength(2);
    });
    expect(
      host_.closes.map((params) =>
        typeof params === "object" && params !== null && "sessionId" in params
          ? params.sessionId
          : null,
      ),
    ).toEqual(["session-person", "session-agent"]);
    await waitFor(() => {
      expect(screen.queryByTestId("epic-simulator-row-udid-1")).toBeNull();
    });
  });

  describe("the person's own open", () => {
    it("shows a pending row at once, gives it the answer's sessionId, places the tile, and keeps the row until the catalog lists that session", async () => {
      const place = vi.fn();
      let answer: (response: SimulatorOpenResponse) => void = () => undefined;
      host_.openAnswer = () =>
        new Promise((resolve) => {
          answer = resolve;
        });
      renderPanel(place);

      fireEvent.click(screen.getByRole("button", { name: "Boot" }));

      const pending = await screen.findByText("Booting");
      expect(pending).toBeTruthy();
      await waitFor(() => {
        expect(host_.opens).toHaveLength(1);
      });
      const [sent] = host_.opens;
      expect(sent).toMatchObject({
        epicId: EPIC,
        simulatorId: "udid-1",
        platform: "ios",
        boot: true,
        instance: "auto",
      });
      const requestId = Object.keys(
        useSimulatorPendingOpensStore.getState().byRequestId,
      )[0];
      expect(sent).toMatchObject({ requestId });
      expect(place).not.toHaveBeenCalled();

      act(() => {
        answer(openResponse("session-new"));
      });
      await waitFor(() => {
        expect(place).toHaveBeenCalledTimes(1);
      });
      expect(place.mock.calls[0][0]).toMatchObject({
        type: "simulator",
        hostId: HOST,
        simulatorId: "udid-1",
      });
      expect(
        useSimulatorPendingOpensStore.getState().byRequestId[requestId]
          ?.sessionId,
      ).toBe("session-new");
      // The catalog has not heard of the session yet: the pending row stays.
      expect(screen.getByText("Booting")).toBeTruthy();

      setCatalog([record("session-new", {})]);
      await refreshCatalog();

      await waitFor(() => {
        expect(screen.queryByText("Booting")).toBeNull();
      });
      expect(rowFor("udid-1")).toBeTruthy();
      expect(useSimulatorPendingOpensStore.getState().byRequestId).toEqual({});
    });

    it("takes the sessionId from the stream when the answer times out, places the tile and shows no failure", async () => {
      const place = vi.fn();
      host_.openAnswer = () =>
        Promise.reject(
          new HostTransportFailureError({
            code: "RPC_ERROR",
            message: "The host did not answer in time.",
            requestId: "request",
            method: "simulator.open",
            fatalDetails: null,
          }),
        );
      publishStream({});
      renderPanel(place);

      fireEvent.click(screen.getByRole("button", { name: "Boot" }));

      const requestId = await waitFor(() => {
        const [id] = Object.keys(
          useSimulatorPendingOpensStore.getState().byRequestId,
        );
        expect(id).toBeDefined();
        expect(
          useSimulatorPendingOpensStore.getState().byRequestId[id]?.answerLost,
        ).toBe(true);
        return id;
      });
      expect(place).not.toHaveBeenCalled();

      publishStream({
        sessions: [
          {
            ...openResponse("session-late").session,
            requestId,
          },
        ],
      });

      await waitFor(() => {
        expect(place).toHaveBeenCalledTimes(1);
      });
      expect(
        useSimulatorPendingOpensStore.getState().byRequestId[requestId]
          ?.sessionId,
      ).toBe("session-late");
      expect(world.toastError).not.toHaveBeenCalled();
      // Still pending: the catalog snapshot does not hold the session yet.
      expect(screen.getByText("Booting")).toBeTruthy();

      setCatalog([record("session-late", {})]);
      await refreshCatalog();
      await waitFor(() => {
        expect(screen.queryByText("Booting")).toBeNull();
      });
      expect(rowFor("udid-1")).toBeTruthy();
    });

    it("ends the row, with a failure, when the answer is lost and the host stops running the open with no session to show", async () => {
      const place = vi.fn();
      host_.openAnswer = () =>
        Promise.reject(
          new HostTransportFailureError({
            code: "RPC_ERROR",
            message: "The host did not answer in time.",
            requestId: "request",
            method: "simulator.open",
            fatalDetails: null,
          }),
        );
      publishStream({});
      renderPanel(place);

      fireEvent.click(screen.getByRole("button", { name: "Boot" }));
      const requestId = await waitFor(() => {
        const [id] = Object.keys(
          useSimulatorPendingOpensStore.getState().byRequestId,
        );
        expect(id).toBeDefined();
        return id;
      });

      publishStream({ opening: [{ requestId }] });
      await waitFor(() => {
        expect(
          useSimulatorPendingOpensStore.getState().byRequestId[requestId]
            ?.seenOpening,
        ).toBe(true);
      });
      expect(screen.getByText("Booting")).toBeTruthy();

      publishStream({ opening: [] });

      await waitFor(() => {
        expect(screen.queryByText("Booting")).toBeNull();
      });
      expect(useSimulatorPendingOpensStore.getState().byRequestId).toEqual({});
      expect(world.toastError).toHaveBeenCalledWith("Couldn't open iPhone 16.");
      expect(place).not.toHaveBeenCalled();
    });

    it("watches the row's instance from the panel: an open naming it, and the tile placed on its answer", async () => {
      // The person's own session ended elsewhere; only the agent's holds the
      // instance, so the row has to ask for a session of its own rather than
      // focus a tile that would attach to nothing.
      setCatalog([record("session-agent", { drivenByAgent: true })]);
      let answer: (response: SimulatorOpenResponse) => void = () => undefined;
      host_.openAnswer = () =>
        new Promise((resolve) => {
          answer = resolve;
        });
      renderPanel(vi.fn());

      fireEvent.click(await screen.findByTestId("epic-simulator-row-udid-1"));

      await waitFor(() => {
        expect(host_.opens).toHaveLength(1);
      });
      expect(host_.opens[0]).toMatchObject({
        epicId: EPIC,
        simulatorId: "udid-1",
        platform: "ios",
        boot: true,
        instance: "udid-1",
      });
      expect(world.openTile).not.toHaveBeenCalled();

      act(() => {
        answer(openResponse("session-mine"));
      });

      await waitFor(() => {
        expect(world.openTile).toHaveBeenCalledTimes(1);
      });
      expect(world.openTile.mock.calls[0][0]).toMatchObject({
        node: { type: "simulator", hostId: HOST, simulatorId: "udid-1" },
        gesture: "explicit",
      });
    });

    it("drops the row at once when a Watch's answer names a session the catalog already holds", async () => {
      const place = vi.fn();
      setCatalog([record("session-held", {})]);
      host_.openAnswer = () => Promise.resolve(openResponse("session-held"));
      renderPanel(place);
      await screen.findByTestId("epic-simulator-row-udid-1");

      fireEvent.click(screen.getByRole("button", { name: "Watch" }));

      await waitFor(() => {
        expect(place).toHaveBeenCalledTimes(1);
      });
      expect(host_.opens[0]).toMatchObject({ instance: "udid-1" });
      await waitFor(() => {
        expect(useSimulatorPendingOpensStore.getState().byRequestId).toEqual(
          {},
        );
      });
      expect(screen.queryByText("Booting")).toBeNull();
      expect(screen.getAllByTestId("epic-simulator-row-udid-1")).toHaveLength(
        1,
      );
    });
  });
});
