import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type {
  SimulatorHostInstance,
  SimulatorOpenResponse,
  SimulatorPackState,
  SimulatorState,
  SimulatorStatusResponse,
} from "@traycer/protocol/host/simulator/schemas";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { resetSimulatorPendingOpensForTests } from "@/stores/epics/simulator-pending-opens-store";
import type { SimulatorTileRef } from "@/stores/epics/canvas/types";

const HOST = mockLocalHostEntry.hostId;
const EPIC = "epic-1";

const world = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
  negotiated: null as SchemaVersion | false | null,
  openTile: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/components/settings/host-scope/use-host-options", () => ({
  useHostOptions: () => ({
    hosts: [
      {
        hostId: "mock-local",
        name: "Studio Mac",
        connectable: true,
        health: { state: "online" },
        sandbox: null,
        entry: null,
        item: null,
      },
    ],
  }),
}));
vi.mock("@/hooks/browser/use-browser-open-host", () => ({
  useServingLocalHostId: () => "mock-local",
}));
vi.mock("../use-simulator-panel-availability", () => ({
  useSimulatorPanelAvailability: () => ({
    localHostRunsSimulators: true,
    hasSimulatorRecords: false,
  }),
}));
vi.mock("@/hooks/host/use-surface-host-pin", () => ({
  useTabSurfaceKey: (kind: string, tabId: string) => `${kind}:${tabId}`,
  useSurfaceHostPin: () => ({ followingHostId: "mock-local" }),
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => world.client,
}));
vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersion: () => world.negotiated,
}));
vi.mock("@/lib/host/read-negotiated-method-version", () => ({
  readNegotiatedMethodVersion: () => world.negotiated,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => true,
  useHostMethodSupport: () => true,
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
vi.mock("@traycer-clients/shared/host-transport/remote/index", () => ({
  hasReadyRemoteSession: () => false,
}));
vi.mock("@/lib/host-error-toast", () => ({ toastFromHostError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: world.toastError } }));

import { useSimulatorInstanceOpen } from "@/hooks/simulator/use-simulator-instance-open";
import { SimulatorCreatePicker } from "../simulator-create-picker";

const DEVICES: SimulatorState["simulators"] = [
  {
    simulatorId: "udid-1",
    platform: "ios",
    name: "iPhone 16",
    version: "18.0",
    booted: true,
    physical: false,
  },
  {
    simulatorId: "udid-cold",
    platform: "ios",
    name: "iPad Air",
    version: "18.0",
    booted: false,
    physical: false,
  },
];

const LIST: SimulatorState = {
  revision: 1,
  hostId: HOST,
  platforms: [{ platform: "ios", available: true, reason: null }],
  packState: { kind: "ready", reason: null, progress: null },
  hubState: { kind: "running", lastError: null },
  simulators: DEVICES,
  sessions: [],
  booting: [],
};

const READY_PACK: SimulatorPackState = {
  kind: "ready",
  reason: null,
  progress: null,
};

/**
 * The host's pack, which both reads carry. Without the tools there is nothing
 * to enumerate, so the list answers with no devices until the pack is ready.
 */
const pack: { state: SimulatorPackState } = { state: READY_PACK };

function listNow(): SimulatorState {
  return {
    ...LIST,
    packState: pack.state,
    simulators: pack.state.kind === "ready" ? DEVICES : [],
  };
}

function statusNow(): SimulatorStatusResponse {
  return {
    platforms: LIST.platforms,
    packState: pack.state,
    packVersion: null,
    installed: null,
  };
}

const RUNNING: SimulatorHostInstance = {
  instanceKey: "udid-1",
  name: "iPhone 16",
  booted: true,
  cloneOf: null,
  drivenByAgent: true,
  keepRunning: false,
  idleUntil: null,
  simulatorId: "udid-1",
  platform: "ios",
  version: "18.0",
  cloneOfName: null,
  bootedByTraycer: true,
  tasks: [],
  otherTaskCount: 0,
};

const opens: unknown[] = [];

function answer(): SimulatorOpenResponse {
  return {
    session: {
      epicId: EPIC,
      ownerUserId: "user",
      hostId: HOST,
      simulatorId: "udid-1",
      platform: "ios",
      openedAt: "2026-10-29T00:00:00.000Z",
      sessionId: "session-1",
    },
    simulator: LIST.simulators[0],
  };
}

let queryClient: QueryClient;

function freshQueryClient(): void {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function wrap(children: ReactNode) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
}

/** Makes the next `simulator.status` read happen now, as its pack poll would. */
async function tickPackPoll(): Promise<void> {
  await act(async () => {
    await queryClient.invalidateQueries({
      queryKey: hostQueryKeys.methodScope(HOST, "simulator.status"),
    });
  });
}

async function openPicker() {
  const user = userEvent.setup();
  render(
    wrap(
      <SimulatorCreatePicker
        epicId={EPIC}
        tabId="tab-1"
        onOpened={null}
        testId="add"
      />,
    ),
  );
  await user.click(screen.getByTestId("add"));
  await screen.findByTestId("simulator-create-picker");
  return user;
}

describe("SimulatorCreatePicker", () => {
  beforeEach(() => {
    resetSimulatorPendingOpensForTests();
    freshQueryClient();
    opens.length = 0;
    pack.state = READY_PACK;
    world.negotiated = { major: 1, minor: 1 };
    world.openTile.mockReset();
    world.toastError.mockReset();
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "request",
      handlers: {
        "simulator.list": () => listNow(),
        "simulator.status": () => statusNow(),
        "simulator.instances": () => ({ instances: [RUNNING] }),
        "config.simulator.set": () => {
          // The host takes the flip and starts fetching the tools.
          pack.state = { kind: "installing", reason: null, progress: 0 };
          return { enabled: true, idleMinutes: 15 };
        },
        "simulator.open": (params) => {
          opens.push(params);
          return answer();
        },
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: { invalidateHostScope: () => undefined },
      schedulingPolicy: hostRpcSchedulingPolicy,
      findHostById: (hostId) => (hostId === HOST ? mockLocalHostEntry : null),
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({ origin: "renderer" }),
    );
    world.client = spine.createRequester(mockLocalHostEntry);
  });
  afterEach(cleanup);

  it("sends every open with a requestId: Watch names the instance, Boot another says new, Boot says auto", async () => {
    const user = await openPicker();
    const picks: ReadonlyArray<() => HTMLElement> = [
      () =>
        within(screen.getByTestId("simulator-picker-running-udid-1")).getByRole(
          "button",
          { name: "Watch" },
        ),
      () =>
        within(screen.getByTestId("simulator-picker-running-udid-1")).getByRole(
          "button",
          { name: "Boot another" },
        ),
      () =>
        within(screen.getByTestId("simulator-picker-cold-udid-cold")).getByRole(
          "button",
          { name: "Boot" },
        ),
    ];
    for (const [index, pick] of picks.entries()) {
      if (index > 0) {
        await user.click(screen.getByTestId("add"));
        await screen.findByTestId("simulator-create-picker");
      }
      await screen.findByTestId("simulator-picker-running-udid-1");
      await user.click(pick());
      await waitFor(() => expect(opens).toHaveLength(index + 1));
    }

    expect(opens[0]).toMatchObject({
      epicId: EPIC,
      simulatorId: "udid-1",
      boot: true,
      instance: "udid-1",
    });
    expect(opens[1]).toMatchObject({ simulatorId: "udid-1", instance: "new" });
    expect(opens[2]).toMatchObject({
      simulatorId: "udid-cold",
      instance: "auto",
    });
    const requestIds = opens.map((sent) =>
      typeof sent === "object" && sent !== null && "requestId" in sent
        ? sent.requestId
        : undefined,
    );
    for (const requestId of requestIds) {
      expect(typeof requestId).toBe("string");
    }
    expect(new Set(requestIds).size).toBe(3);
  });

  it("leaves the off state and lists the cold devices once the switch is on and the pack has installed", async () => {
    pack.state = { kind: "off", reason: null, progress: null };
    const user = await openPicker();
    const turnOn = await screen.findByTestId("simulator-create-picker-turn-on");
    expect(screen.queryByTestId("simulator-picker-cold-udid-cold")).toBeNull();

    await user.click(turnOn);

    // The switch-on's own answer: the picker stops saying simulators are off.
    await waitFor(() => {
      expect(
        screen.queryByTestId("simulator-create-picker-turn-on"),
      ).toBeNull();
    });
    expect(screen.queryByTestId("simulator-picker-cold-udid-cold")).toBeNull();

    pack.state = READY_PACK;
    await tickPackPoll();

    expect(
      await screen.findByTestId("simulator-picker-cold-udid-cold"),
    ).toBeTruthy();
  });

  it("disables Boot another toward a 1.0 host, says why, and sends nothing for it", async () => {
    world.negotiated = { major: 1, minor: 0 };
    const user = await openPicker();
    const running = await screen.findByTestId(
      "simulator-picker-running-udid-1",
    );

    const bootAnother = within(running).getByRole("button", {
      name: "Boot another",
    });
    expect(bootAnother).toHaveProperty("disabled", true);
    expect(
      screen.getByText(
        "Studio Mac needs an update before it can boot another copy.",
      ),
    ).toBeTruthy();
    await user.click(bootAnother);
    expect(opens).toEqual([]);
  });
});

describe("useSimulatorInstanceOpen toward a 1.0 host", () => {
  beforeEach(() => {
    resetSimulatorPendingOpensForTests();
    freshQueryClient();
    opens.length = 0;
    pack.state = READY_PACK;
    world.negotiated = { major: 1, minor: 0 };
    world.toastError.mockReset();
    world.client = null;
  });
  afterEach(cleanup);

  function Controls(props: {
    readonly place: (ref: SimulatorTileRef) => void;
  }) {
    const { open } = useSimulatorInstanceOpen(EPIC);
    const target = {
      simulatorId: "udid-1",
      platform: "ios",
      name: "iPhone 16",
      version: "18.0",
    } as const;
    return (
      <>
        <button
          type="button"
          onClick={() =>
            open({ hostId: HOST, target, instance: "new", place: props.place })
          }
        >
          New
        </button>
        <button
          type="button"
          onClick={() =>
            open({ hostId: HOST, target, instance: "auto", place: props.place })
          }
        >
          Auto
        </button>
      </>
    );
  }

  it("refuses new, and for auto only places the tile, which sends its own bare open", async () => {
    const place = vi.fn();
    const user = userEvent.setup();
    render(wrap(<Controls place={place} />));

    await user.click(screen.getByRole("button", { name: "New" }));
    expect(world.toastError).toHaveBeenCalledWith(
      "Mock Mac needs an update before it can boot another copy.",
    );
    expect(place).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Auto" }));
    expect(place).toHaveBeenCalledTimes(1);
    expect(opens).toEqual([]);
  });
});
