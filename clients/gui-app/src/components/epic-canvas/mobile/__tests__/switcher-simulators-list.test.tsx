import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
} from "@traycer/protocol/host/simulator/schemas";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { useAuthStore } from "@/stores/auth/auth-store";
import { resetClosedSimulatorCatalogSessionsForTests } from "@/hooks/simulator/simulator-catalog-closed-sessions";
import { resetSimulatorSessionsCoordinatorsForTests } from "@/lib/simulator-view/simulator-sessions-coordinator";
import { resetSimulatorPendingOpensForTests } from "@/stores/epics/simulator-pending-opens-store";

const HOST = mockLocalHostEntry.hostId;
const EPIC = "epic-1";
const TAB = "tab-1";

/** The sessions stream, the host directory/options and the signed-in viewer: the boundaries mocked below. */
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
  onClose: vi.fn(),
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
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/stores/epics/canvas/store", () => ({
  useIsActiveTile: () => false,
}));
vi.mock("@/components/epic-canvas/sidebar/simulator-create-picker", () => ({
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
import type { SimulatorSessionsState } from "@/lib/simulator-view/simulator-sessions-coordinator";
import { SwitcherSimulatorsList } from "../switcher-simulators-list";

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

const host_ = {
  catalog: { kind: "available", snapshot: { version: 1, records: [] } } as
    | SimulatorCatalogReadResponse
    | { kind: "not-ready" },
  openAnswer: (): Promise<SimulatorOpenResponse> => new Promise(() => {}),
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

/**
 * Drives a Boot through the real open hook so a genuine pending row appears
 * in the list below it - the switcher list itself has no boot affordance of
 * its own to click.
 */
function Boot() {
  const { open } = useSimulatorInstanceOpen(EPIC);
  return (
    <button
      type="button"
      onClick={() =>
        open({
          hostId: HOST,
          target: IPHONE,
          instance: "auto",
          place: () => undefined,
        })
      }
    >
      Boot
    </button>
  );
}

function renderList() {
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
      <SwitcherSimulatorsList
        epicId={EPIC}
        tabId={TAB}
        onClose={world.onClose}
      />,
    ),
  );
}

describe("<SwitcherSimulatorsList />", () => {
  beforeEach(() => {
    resetSimulatorPendingOpensForTests();
    resetClosedSimulatorCatalogSessionsForTests();
    resetSimulatorSessionsCoordinatorsForTests();
    world.hosts = [
      { hostId: HOST, name: "Studio Mac", health: { state: "online" } },
    ];
    world.streamByHost.clear();
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
    world.onClose.mockReset();
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
        "simulator.catalog.read": () => host_.catalog,
        "simulator.open": (params) => {
          host_.opens.push(params);
          return host_.openAnswer();
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

  it("does not open or place when a live row's group is offline", async () => {
    world.hosts = [
      { hostId: HOST, name: "Studio Mac", health: { state: "offline" } },
    ];
    setCatalog([record("session-live", {})]);
    renderList();

    const row = await screen.findByTestId("switcher-simulator-row-udid-1");
    fireEvent.click(row);

    expect(host_.opens).toHaveLength(0);
    expect(world.openTile).not.toHaveBeenCalled();
    expect(world.onClose).not.toHaveBeenCalled();
  });

  it("shows an ended row's notice and Dismiss action, with no open on a body tap", async () => {
    setCatalog([record("session-ended", { endedReason: "archived" })]);
    renderList();

    const row = await screen.findByTestId(
      "switcher-simulator-ended-session-ended",
    );
    expect(row.textContent).toContain("Ended when its agent was archived");
    expect(
      screen.getByTestId("switcher-simulator-dismiss-session-ended"),
    ).toBeTruthy();

    fireEvent.click(row);

    // `onClose` is what a watch fires synchronously, so it is the witness a
    // dispatched open cannot hide behind its own async send.
    expect(world.onClose).not.toHaveBeenCalled();
    expect(host_.opens).toHaveLength(0);
    expect(world.openTile).not.toHaveBeenCalled();
  });

  it("shows a pending row's secondary label and does not open on a tap", async () => {
    let answer: (response: SimulatorOpenResponse) => void = () => undefined;
    host_.openAnswer = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <SimulatorCatalogProvider epicId={EPIC}>
            <Boot />
            <SwitcherSimulatorsList
              epicId={EPIC}
              tabId={TAB}
              onClose={world.onClose}
            />
          </SimulatorCatalogProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Boot" }));

    const requestId = await waitFor(() => {
      const requestIds = host_.opens.map((params) =>
        typeof params === "object" && params !== null && "requestId" in params
          ? params.requestId
          : null,
      );
      const [id] = requestIds;
      expect(id).toBeTruthy();
      return id as string;
    });
    const pending = await screen.findByTestId(
      `switcher-simulator-pending-${requestId}`,
    );
    expect(pending.textContent).toContain("Booting");

    fireEvent.click(pending);
    expect(world.openTile).not.toHaveBeenCalled();
    expect(world.onClose).not.toHaveBeenCalled();

    act(() => {
      answer(openResponse("session-new"));
    });
  });

  it("sends the Watch open naming the row's instance, closes the sheet at once, and places the tile only on the answer", async () => {
    setCatalog([record("session-held", {})]);
    let answer: (response: SimulatorOpenResponse) => void = () => undefined;
    host_.openAnswer = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    renderList();

    const row = await screen.findByTestId("switcher-simulator-row-udid-1");
    fireEvent.click(row);

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
    expect(world.onClose).toHaveBeenCalledTimes(1);
    expect(world.openTile).not.toHaveBeenCalled();

    act(() => {
      answer(openResponse("session-mine"));
    });

    await waitFor(() => {
      expect(world.openTile).toHaveBeenCalledTimes(1);
    });
    expect(world.openTile.mock.calls[0][0]).toMatchObject({
      node: { type: "simulator", hostId: HOST, simulatorId: "udid-1" },
    });
  });
});
