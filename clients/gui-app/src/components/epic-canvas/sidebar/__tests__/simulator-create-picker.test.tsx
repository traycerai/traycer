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
  SimulatorInstancesResponse,
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
import { createAppQueryClient } from "@/lib/query-client";
import { resetSimulatorPendingOpensForTests } from "@/stores/epics/simulator-pending-opens-store";
import { TILE_KIND_SIMULATOR } from "@/stores/epics/canvas/tile-kinds";
import type { SimulatorTileRef } from "@/stores/epics/canvas/types";

const HOST = mockLocalHostEntry.hostId;
const EPIC = "epic-1";

const world = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
  negotiated: null as SchemaVersion | false | null,
  /** The manifest registry's three states for every simulator method. */
  support: true as boolean | null,
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
  useHostSupportsMethod: () => world.support === true,
  useHostMethodSupport: () => world.support,
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
import { useSimulatorOpenMutation } from "@/hooks/simulator/use-simulator-mutations";
import { useSimulatorTilePowerOff } from "@/components/simulator-tile/use-simulator-tile-session";
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

/** The devices this host has booted right now; `DEVICES` carries the seed. */
const booted = new Set<string>();

function resetBootState(): void {
  booted.clear();
  for (const device of DEVICES) {
    if (device.booted) booted.add(device.simulatorId);
  }
}

function listNow(): SimulatorState {
  return {
    ...LIST,
    packState: pack.state,
    simulators:
      pack.state.kind === "ready"
        ? DEVICES.map((device) => ({
            ...device,
            booted: booted.has(device.simulatorId),
          }))
        : [],
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

/**
 * The host's instances, one per booted device, so a boot from the picker moves
 * this read and `simulator.list` together, as it does on a real machine.
 */
function instancesNow(): SimulatorInstancesResponse {
  return {
    instances: listNow()
      .simulators.filter((device) => device.booted)
      .map((device) =>
        device.simulatorId === RUNNING.instanceKey
          ? RUNNING
          : {
              ...RUNNING,
              instanceKey: device.simulatorId,
              simulatorId: device.simulatorId,
              name: device.name,
              version: device.version,
              drivenByAgent: false,
            },
      ),
  };
}

const opens: unknown[] = [];
const shutdowns: unknown[] = [];
/** Whether the host's instance read refuses, as a dropped dial does. */
const instancesFail = { on: false };
/** Whether the picker reached the host at all: the read that handshakes it. */
const reads = { list: 0 };

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

/**
 * Makes the next `simulator.instances` read happen now, as its poll would -
 * and only that read, so `simulator.list` stays on the answer it is holding,
 * which is the picker's two freshnesses as the person meets them.
 */
async function tickInstancePoll(): Promise<void> {
  await act(async () => {
    await queryClient.invalidateQueries({
      queryKey: hostQueryKeys.methodScope(HOST, "simulator.instances"),
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

const PLACED_NODE: SimulatorTileRef = {
  id: "tile-1",
  instanceId: "tile-1",
  type: TILE_KIND_SIMULATOR,
  name: "iPhone 16",
  hostId: HOST,
  simulatorId: "udid-1",
  platform: "ios",
  instanceKey: null,
};

/**
 * Stands in for the tile the picker PLACES on a `@1.0` host, where both the
 * open and the power off are the tile's own: the picker sends neither, so the
 * device list it reads moves only if those mutations sweep it. Power off goes
 * through the tile's own hook, which is what routes a `@1.0` host to
 * `simulator.shutdown`.
 */
function PlacedTile() {
  const { mutation } = useSimulatorOpenMutation(world.client, HOST);
  const { mutate } = mutation;
  const { onPowerOff } = useSimulatorTilePowerOff({
    client: world.client,
    hostId: HOST,
    epicId: EPIC,
    node: PLACED_NODE,
    instanceKey: "udid-1",
    platform: "ios",
    v11: false,
    onCloseTile: () => undefined,
  });
  return (
    <>
      <button
        type="button"
        onClick={() =>
          mutate({
            epicId: EPIC,
            simulatorId: "udid-cold",
            platform: "ios",
            boot: true,
          })
        }
      >
        Tile open
      </button>
      <button
        type="button"
        disabled={onPowerOff === null}
        onClick={() => onPowerOff?.()}
      >
        Tile power off
      </button>
    </>
  );
}

describe("SimulatorCreatePicker", () => {
  beforeEach(() => {
    resetSimulatorPendingOpensForTests();
    freshQueryClient();
    opens.length = 0;
    shutdowns.length = 0;
    instancesFail.on = false;
    reads.list = 0;
    resetBootState();
    pack.state = READY_PACK;
    world.support = true;
    world.negotiated = { major: 1, minor: 1 };
    world.openTile.mockReset();
    world.toastError.mockReset();
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "request",
      handlers: {
        "simulator.list": () => {
          reads.list += 1;
          return listNow();
        },
        "simulator.status": () => statusNow(),
        "simulator.instances": () => {
          if (instancesFail.on) throw new Error("dial refused");
          return instancesNow();
        },
        "config.simulator.set": () => {
          // The host takes the flip and starts fetching the tools.
          pack.state = { kind: "installing", reason: null, progress: 0 };
          return { enabled: true, idleMinutes: 15 };
        },
        "simulator.open": (params) => {
          opens.push(params);
          // The host boots the device the open names, so both reads move.
          booted.add(params.simulatorId);
          return answer();
        },
        "simulator.shutdown": (params) => {
          shutdowns.push(params);
          // The `@1.0` power off: the device is off, so its row goes cold.
          booted.delete(params.simulatorId);
          return { simulatorId: params.simulatorId, booted: false };
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

  it("lists a device it just booted once, under Running, when reopened inside the freshness window", async () => {
    // The production client, for its real 60 s `staleTime`: nothing moves the
    // clock here, so a read the open did not invalidate is served from cache.
    queryClient = createAppQueryClient();
    const user = await openPicker();
    const cold = await screen.findByTestId("simulator-picker-cold-udid-cold");

    await user.click(within(cold).getByRole("button", { name: "Boot" }));
    await waitFor(() => expect(opens).toHaveLength(1));

    // The pick closed the picker; reopening it asks both of its reads again.
    await user.click(screen.getByTestId("add"));
    await screen.findByTestId("simulator-create-picker");

    await waitFor(() => {
      expect(
        screen.queryByTestId("simulator-picker-running-udid-cold"),
      ).toBeTruthy();
      expect(
        screen.queryByTestId("simulator-picker-cold-udid-cold"),
      ).toBeNull();
    });
  });

  it("lists it once after the @1.0 path's boot too, where the tile sends the open", async () => {
    world.negotiated = { major: 1, minor: 0 };
    queryClient = createAppQueryClient();
    const user = userEvent.setup();
    render(
      wrap(
        <>
          <SimulatorCreatePicker
            epicId={EPIC}
            tabId="tab-1"
            onOpened={null}
            testId="add"
          />
          <PlacedTile />
        </>,
      ),
    );
    await user.click(screen.getByTestId("add"));
    await screen.findByTestId("simulator-create-picker");
    const cold = await screen.findByTestId("simulator-picker-cold-udid-cold");

    await user.click(within(cold).getByRole("button", { name: "Boot" }));
    // A `@1.0` host ignores `instance`, so the picker places a tile and leaves
    // the open to it.
    expect(opens).toEqual([]);
    expect(world.openTile).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Tile open" }));
    await waitFor(() => expect(opens).toHaveLength(1));

    await user.click(screen.getByTestId("add"));
    await screen.findByTestId("simulator-create-picker");

    // A `@1.0` host has no instances: its booted devices ARE the Running
    // section, so the one read has to move for the device to leave Not running.
    await waitFor(() => {
      expect(
        screen.queryByTestId("simulator-picker-running-udid-cold"),
      ).toBeTruthy();
      expect(
        screen.queryByTestId("simulator-picker-cold-udid-cold"),
      ).toBeNull();
    });
  });

  it("offers Boot again after the @1.0 path's power off, where the tile sends the shutdown", async () => {
    world.negotiated = { major: 1, minor: 0 };
    queryClient = createAppQueryClient();
    const user = userEvent.setup();
    render(
      wrap(
        <>
          <SimulatorCreatePicker
            epicId={EPIC}
            tabId="tab-1"
            onOpened={null}
            testId="add"
          />
          <PlacedTile />
        </>,
      ),
    );
    await user.click(screen.getByTestId("add"));
    await screen.findByTestId("simulator-create-picker");
    await screen.findByTestId("simulator-picker-running-udid-1");

    // Closed with the read cached, as it is while the person works in the
    // tile: nothing moves the clock here, so only an invalidation can.
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByTestId("simulator-create-picker")).toBeNull();
    });

    await user.click(screen.getByRole("button", { name: "Tile power off" }));
    await waitFor(() => expect(shutdowns).toHaveLength(1));

    await user.click(screen.getByTestId("add"));
    await screen.findByTestId("simulator-create-picker");

    // A `@1.0` host has no instances: its booted devices ARE the Running
    // section, so the one read has to move for the device to offer Boot.
    await waitFor(() => {
      expect(screen.queryByTestId("simulator-picker-cold-udid-1")).toBeTruthy();
      expect(
        screen.queryByTestId("simulator-picker-running-udid-1"),
      ).toBeNull();
    });
  });

  it("offers no Boot for a device the instance read shows running, however the device list still calls it", async () => {
    // A boot this client did not send - an agent's, another window's. The
    // host-wide instance read polls and picks it up; `simulator.list` is
    // inside its freshness window with `booted: false` for that device and
    // nothing to move it, which is what put the same device under Running
    // and under Not running with a live Boot button at once.
    queryClient = createAppQueryClient();
    const user = await openPicker();
    expect(
      await screen.findByTestId("simulator-picker-cold-udid-cold"),
    ).toBeTruthy();

    booted.add("udid-cold");
    await tickInstancePoll();

    await waitFor(() => {
      expect(
        screen.queryByTestId("simulator-picker-running-udid-cold"),
      ).toBeTruthy();
    });
    expect(screen.queryByTestId("simulator-picker-cold-udid-cold")).toBeNull();
    await user.keyboard("{Escape}");
  });

  it("says it couldn't reach the machine when the instance read stops answering, rather than drawing its last instances", async () => {
    const user = await openPicker();
    await screen.findByTestId("simulator-picker-running-udid-1");

    // The instance poll is the Running section's only input, and a failed
    // refetch keeps its last answer: the person has to be told the machine
    // stopped confirming it.
    instancesFail.on = true;
    await tickInstancePoll();

    expect(
      await screen.findByText("Couldn't reach Studio Mac."),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("simulator-picker-running-udid-1"),
    ).toBeNull();
    await user.keyboard("{Escape}");
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

  const TOO_OLD = "Studio Mac needs an update before it can run simulators.";

  it("reaches a machine this window has not addressed instead of calling it too old", async () => {
    // Nothing is known about this machine yet: no handshake has completed, so
    // the registry answers `null` for every simulator method.
    world.support = null;
    world.negotiated = null;
    await openPicker();

    // The read is what handshakes the machine, so it has to go out.
    await waitFor(() => {
      expect(reads.list).toBeGreaterThan(0);
    });
    expect(
      await screen.findByTestId("simulator-picker-cold-udid-cold"),
    ).toBeTruthy();
    expect(screen.queryByText(TOO_OLD)).toBeNull();
    // Boot another cannot be offered until the version is known - but then it
    // says so rather than sitting dead.
    expect(
      within(screen.getByTestId("simulator-picker-running-udid-1")).getByRole(
        "button",
        { name: "Boot another" },
      ),
    ).toHaveProperty("disabled", true);
    expect(
      screen.getByText("Asking Studio Mac about mobile simulators."),
    ).toBeTruthy();
  });

  it("says a machine whose manifest lacks the read needs an update, and asks it nothing", async () => {
    world.support = false;
    await openPicker();

    expect(await screen.findByText(TOO_OLD)).toBeTruthy();
    expect(reads.list).toBe(0);
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
    shutdowns.length = 0;
    instancesFail.on = false;
    reads.list = 0;
    resetBootState();
    pack.state = READY_PACK;
    world.support = true;
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
