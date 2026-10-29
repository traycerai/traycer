import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { JSX, ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type {
  SimulatorInstancesResponse,
  SimulatorListResponse,
  SimulatorOpenResponse,
  SimulatorShutdownResponse,
} from "@traycer/protocol/host/simulator/schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createAppQueryClient } from "@/lib/query-client";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Two facts about the palette's per-machine inventory read, both about its
 * CACHE IDENTITY rather than its arithmetic (which
 * `simulatorInventoryEntries` is unit-covered for).
 *
 * 1. The read's shape is decided by the host's negotiated simulator minor: a
 *    `@1.1` host answers `simulator.instances`, a `@1.0` host has none and its
 *    booted devices stand in. So it must not fire before the handshake lands,
 *    where the gate reads `null` and the `@1.0` branch would file its
 *    stand-in shape as the answer for a host that turns out to speak `@1.1`.
 * 2. The entry lives under the `simulator.instances` method scope, so the
 *    invalidations the simulator mutations already send reach it - otherwise
 *    the palette reopened inside the 60 s freshness window serves an
 *    inventory from before the open.
 */

const HOST_ID = mockLocalHostEntry.hostId;
const EPIC_ID = "epic-sim-1";

const hostBindingMock = vi.hoisted(() => ({
  current: null as { readonly hostClient: unknown } | null,
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => hostBindingMock.current,
  useHostDirectory: () => ({ findById: () => mockLocalHostEntry }),
  useHostClient: () => hostBindingMock.current?.hostClient ?? null,
}));

import { useSimulatorInstanceOpen } from "@/hooks/simulator/use-simulator-instance-open";
import { useSimulatorInventories } from "@/hooks/simulator/use-simulator-inventories";
import { useSimulatorCatalogActions } from "@/hooks/simulator/use-simulator-catalog-actions";
import {
  useSimulatorCloseMutation,
  useSimulatorConfigSetMutation,
  useSimulatorShutdownMutation,
} from "@/hooks/simulator/use-simulator-mutations";

/** One booted device, so the `@1.0` branch has an instance row to mint. */
const LIST: SimulatorListResponse = {
  revision: 1,
  hostId: HOST_ID,
  platforms: [{ platform: "ios", available: true, reason: null }],
  packState: { kind: "ready", reason: null, progress: null },
  hubState: { kind: "running", lastError: null },
  simulators: [
    {
      simulatorId: "udid-1",
      platform: "ios",
      name: "iPhone 17",
      version: "26.0",
      booted: true,
      physical: false,
    },
  ],
  sessions: [],
  booting: [],
};

/** Whether an agent still holds the instance; a close is what ends that. */
const agentHolds = { on: true };

/** The same device on the `@1.1` branch, where an agent drives its instance. */
function instancesNow(): SimulatorInstancesResponse {
  return {
    instances: [
      {
        instanceKey: "udid-1",
        simulatorId: "udid-1",
        platform: "ios",
        name: "iPhone 17",
        version: "26.0",
        booted: true,
        cloneOf: null,
        cloneOfName: null,
        drivenByAgent: agentHolds.on,
        keepRunning: false,
        bootedByTraycer: true,
        idleUntil: null,
        tasks: agentHolds.on ? [{ epicId: EPIC_ID }] : [],
        otherTaskCount: 0,
      },
    ],
  };
}

const OPENED: SimulatorOpenResponse = {
  session: {
    epicId: EPIC_ID,
    ownerUserId: "user-1",
    hostId: HOST_ID,
    simulatorId: "udid-1",
    platform: "ios",
    openedAt: "2026-10-29T00:00:00.000Z",
  },
  simulator: {
    simulatorId: "udid-1",
    platform: "ios",
    name: "iPhone 17",
    version: "26.0",
    booted: true,
    physical: false,
  },
};

function buildSpine(args: { readonly reachable: () => boolean }): {
  readonly spine: HostClient<HostRpcRegistry>;
  readonly methods: string[];
} {
  const methods: string[] = [];
  const record = <T,>(method: string, response: T): T => {
    methods.push(method);
    return response;
  };
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "simulator-inventory-req",
    handlers: {
      "simulator.list": () => {
        record("simulator.list", null);
        if (!args.reachable()) throw new Error("dial refused");
        return LIST;
      },
      "simulator.instances": () =>
        record("simulator.instances", instancesNow()),
      "simulator.close": () => {
        // The host ends the session; no agent holds the instance after it.
        agentHolds.on = false;
        return record("simulator.close", { closed: 1 });
      },
      "simulator.open": () => record("simulator.open", OPENED),
      "config.simulator.set": () =>
        record("config.simulator.set", { enabled: false, idleMinutes: 15 }),
      "simulator.shutdown": (params) =>
        record<SimulatorShutdownResponse>("simulator.shutdown", {
          simulatorId: params.simulatorId,
          booted: false,
        }),
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    messenger,
    invalidator: { invalidateHostScope: () => undefined },
    schedulingPolicy: hostRpcSchedulingPolicy,
    findHostById: (hostId) => (hostId === HOST_ID ? mockLocalHostEntry : null),
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-simulator-inventory",
    }),
  );
  return { spine, methods };
}

/** The production client, for its real 60 s `staleTime`. */
function wrapper(): (props: { children: ReactNode }) => JSX.Element {
  const queryClient = createAppQueryClient();
  return function Wrapper(props: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  };
}

function negotiateV11(): void {
  recordNegotiatedHostManifest(HOST_ID, {
    "simulator.open": { major: 1, minor: 1 },
    "simulator.list": { major: 1, minor: 1 },
    "simulator.instances": { major: 1, minor: 0 },
  });
}

function renderInventories() {
  return renderHook(
    () => ({
      inventories: useSimulatorInventories({
        hostIds: [HOST_ID],
        epicId: EPIC_ID,
        enabled: true,
      }),
      open: useSimulatorInstanceOpen(EPIC_ID).open,
    }),
    { wrapper: wrapper() },
  );
}

/**
 * The palette beside the tile that owns the power off, on a `@1.0` host: the
 * tile's shutdown is the only write, so this inventory moves only if that
 * mutation sweeps it.
 */
function renderInventoriesWithPowerOff(spine: HostClient<HostRpcRegistry>) {
  const client = spine.createRequester(mockLocalHostEntry);
  return renderHook(
    () => ({
      inventories: useSimulatorInventories({
        hostIds: [HOST_ID],
        epicId: EPIC_ID,
        enabled: true,
      }),
      shutdown: useSimulatorShutdownMutation(client, HOST_ID, "udid-1")
        .mutation,
    }),
    { wrapper: wrapper() },
  );
}

/**
 * The palette beside Settings' Mobile simulators switch: turning simulators
 * off is a machine-wide write, and this inventory is the read it moves.
 */
function renderInventoriesWithConfigSet(spine: HostClient<HostRpcRegistry>) {
  const client = spine.createRequester(mockLocalHostEntry);
  return renderHook(
    () => ({
      inventories: useSimulatorInventories({
        hostIds: [HOST_ID],
        epicId: EPIC_ID,
        enabled: true,
      }),
      configSet: useSimulatorConfigSetMutation(client, HOST_ID).mutation,
    }),
    { wrapper: wrapper() },
  );
}

/**
 * The palette beside the tile that owns the Close: ending a session leaves
 * the instance up but changes who holds it, which is this inventory's own
 * `drivenByAgent`.
 */
function renderInventoriesWithClose(spine: HostClient<HostRpcRegistry>) {
  const client = spine.createRequester(mockLocalHostEntry);
  return renderHook(
    () => ({
      inventories: useSimulatorInventories({
        hostIds: [HOST_ID],
        epicId: EPIC_ID,
        enabled: true,
      }),
      close: useSimulatorCloseMutation(client, HOST_ID, "udid-1").mutation,
    }),
    { wrapper: wrapper() },
  );
}

/** The viewer the spine's own request context is signed in as. */
const VIEWER = "user-fixture-1";

/** The same palette beside the catalog row's Close, which is not a host hook. */
function renderInventoriesWithCatalogClose(spine: HostClient<HostRpcRegistry>) {
  hostBindingMock.current = { hostClient: spine };
  // The row's Close refuses a viewer the client is not signed in as.
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId: VIEWER, userName: VIEWER, email: "u@example.com" },
    contextMetadata: { userId: VIEWER, username: VIEWER },
  });
  return renderHook(
    () => ({
      inventories: useSimulatorInventories({
        hostIds: [HOST_ID],
        epicId: EPIC_ID,
        enabled: true,
      }),
      catalog: useSimulatorCatalogActions(EPIC_ID),
    }),
    { wrapper: wrapper() },
  );
}

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  hostBindingMock.current = null;
  agentHolds.on = true;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  vi.clearAllMocks();
});

describe("useSimulatorInventories", () => {
  it("contacts a host whose simulator minor is unknown, and withholds only the version-dependent read", async () => {
    const { spine, methods } = buildSpine({ reachable: () => true });
    hostBindingMock.current = { hostClient: spine };

    const { result } = renderInventories();
    await waitFor(() => {
      expect(methods).toContain("simulator.list");
    });

    // `simulator.list` is what reaches the machine, so it goes out with the
    // minor still unknown; `simulator.instances` is the read whose presence
    // the minor decides, and it waits. Until the handshake it records answers
    // the question, no shape is committed - an entry list here would be the
    // `@1.0` stand-in asserted without evidence.
    expect(methods).toEqual(["simulator.list"]);
    expect(result.current.inventories[0]?.status).toBe("loading");
    expect(result.current.inventories[0]?.entries).toEqual([]);
  });

  it("reports a host it cannot reach instead of loading for ever", async () => {
    const { spine } = buildSpine({ reachable: () => false });
    hostBindingMock.current = { hostClient: spine };

    const { result } = renderInventories();

    await waitFor(() => {
      expect(result.current.inventories[0]?.status).toBe("error");
    });
  });

  it("stops reporting a failed contact once the minor lands anyway", async () => {
    let reachable = false;
    const { spine } = buildSpine({ reachable: () => reachable });
    hostBindingMock.current = { hostClient: spine };

    const { result } = renderInventories();
    await waitFor(() => {
      expect(result.current.inventories[0]?.status).toBe("error");
    });

    // Another surface reached the machine: the contact read's frozen failure
    // is no longer this host's answer, the shaped read's own state is.
    reachable = true;
    act(() => {
      negotiateV11();
    });

    await waitFor(() => {
      expect(result.current.inventories[0]?.status).toBe("ready");
    });
    expect(result.current.inventories[0]?.entries[0]?.drivenByAgent).toBe(true);
  });

  it("reads the `@1.1` instance shape once the handshake lands, never the `@1.0` stand-in", async () => {
    const { spine, methods } = buildSpine({ reachable: () => true });
    hostBindingMock.current = { hostClient: spine };

    const { result, rerender } = renderInventories();
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      negotiateV11();
    });
    rerender();

    await waitFor(() => {
      expect(result.current.inventories[0]?.status).toBe("ready");
    });
    expect(methods).toContain("simulator.instances");
    // The `@1.0` stand-in mints the same device with `drivenByAgent: false`,
    // so this is what an unnegotiated first fetch gets wrong.
    expect(result.current.inventories[0]?.entries).toEqual([
      {
        key: JSON.stringify([HOST_ID, "instance", "udid-1"]),
        hostId: HOST_ID,
        kind: "instance",
        instanceKey: "udid-1",
        target: {
          simulatorId: "udid-1",
          platform: "ios",
          name: "iPhone 17",
          version: "26.0",
        },
        drivenByAgent: true,
      },
    ]);
  });

  it("re-reads a host that renegotiates from `@1.0` to `@1.1`, inside the 60 s freshness window", async () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "simulator.open": { major: 1, minor: 0 },
      "simulator.list": { major: 1, minor: 0 },
    });
    const { spine, methods } = buildSpine({ reachable: () => true });
    hostBindingMock.current = { hostClient: spine };

    const { result } = renderInventories();
    await waitFor(() => {
      expect(result.current.inventories[0]?.status).toBe("ready");
    });
    // The `@1.0` stand-in: the booted device itself, with no instance read.
    expect(methods).toEqual(["simulator.list"]);
    expect(result.current.inventories[0]?.entries[0]?.drivenByAgent).toBe(
      false,
    );

    act(() => {
      negotiateV11();
    });

    await waitFor(() => {
      expect(result.current.inventories[0]?.entries[0]?.drivenByAgent).toBe(
        true,
      );
    });
  });

  it("is asked again after an open, inside the 60 s freshness window", async () => {
    negotiateV11();
    const { spine, methods } = buildSpine({ reachable: () => true });
    hostBindingMock.current = { hostClient: spine };

    const { result } = renderInventories();
    await waitFor(() => {
      expect(result.current.inventories[0]?.status).toBe("ready");
    });
    const reads = (): number =>
      methods.filter((method) => method === "simulator.list").length;
    expect(reads()).toBe(1);

    act(() => {
      result.current.open({
        hostId: HOST_ID,
        target: {
          simulatorId: "udid-1",
          platform: "ios",
          name: "iPhone 17",
          version: "26.0",
        },
        instance: "auto",
        place: () => undefined,
      });
    });
    await waitFor(() => {
      expect(methods).toContain("simulator.open");
    });

    // The open's own invalidation, with no refetch of its own and no clock
    // moved: a palette reopened now must not serve the pre-open inventory.
    await waitFor(() => {
      expect(reads()).toBe(2);
    });
  });

  it("is asked again after the machine's simulator switch is flipped, inside the 60 s freshness window", async () => {
    negotiateV11();
    const { spine, methods } = buildSpine({ reachable: () => true });
    hostBindingMock.current = { hostClient: spine };

    const { result } = renderInventoriesWithConfigSet(spine);
    await waitFor(() => {
      expect(result.current.inventories[0]?.status).toBe("ready");
    });
    const reads = (): number =>
      methods.filter((method) => method === "simulator.list").length;
    expect(reads()).toBe(1);

    act(() => {
      result.current.configSet.mutate({ enabled: false });
    });
    await waitFor(() => {
      expect(methods).toContain("config.simulator.set");
    });

    // Turning simulators off powers every instance on the machine off and
    // leaves no device to enumerate. The switch's own reads are the config
    // and the pack; this inventory is host-wide, polls for nothing, and the
    // picker's pack-following effect lives on the surface that sent the
    // flip - so without the switch sweeping it too, the palette went on
    // offering a machine's devices and instances for the whole window.
    await waitFor(() => {
      expect(reads()).toBe(2);
    });
  });

  it("drops an instance's Agent badge after the tile's close, inside the 60 s freshness window", async () => {
    negotiateV11();
    const { spine } = buildSpine({ reachable: () => true });
    hostBindingMock.current = { hostClient: spine };

    const { result } = renderInventoriesWithClose(spine);
    await waitFor(() => {
      expect(result.current.inventories[0]?.entries[0]?.drivenByAgent).toBe(
        true,
      );
    });

    act(() => {
      result.current.close.mutate({
        epicId: EPIC_ID,
        simulatorId: "udid-1",
        shutdown: false,
      });
    });

    // A close takes no device off the machine, so the devices are unmoved -
    // but who HOLDS the instance is the host-wide read's own, and the
    // sessions stream carries only this task's half of that census.
    await waitFor(() => {
      expect(result.current.inventories[0]?.entries[0]?.drivenByAgent).toBe(
        false,
      );
    });
  });

  it("drops it after the catalog row's close too, which is no host mutation", async () => {
    negotiateV11();
    const { spine } = buildSpine({ reachable: () => true });

    const { result } = renderInventoriesWithCatalogClose(spine);
    await waitFor(() => {
      expect(result.current.inventories[0]?.entries[0]?.drivenByAgent).toBe(
        true,
      );
    });

    // The row's Close ends the agent's session beside the person's, so it
    // moves the same read - and it is sent from outside the mutation module,
    // which is why the invariant is over every simulator WRITE.
    act(() => {
      result.current.catalog.closeRecords(HOST_ID, [
        {
          sessionId: "session-agent",
          hostId: HOST_ID,
          epicId: EPIC_ID,
          simulatorId: "udid-1",
          instanceKey: "udid-1",
          platform: "ios",
          name: "iPhone 17",
          version: "26.0",
          drivenByAgent: true,
          endedReason: null,
        },
      ]);
    });

    await waitFor(() => {
      expect(result.current.inventories[0]?.entries[0]?.drivenByAgent).toBe(
        false,
      );
    });
  });

  it("is asked again after a `@1.0` host's shutdown, inside the 60 s freshness window", async () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "simulator.open": { major: 1, minor: 0 },
      "simulator.list": { major: 1, minor: 0 },
      "simulator.shutdown": { major: 1, minor: 0 },
    });
    const { spine, methods } = buildSpine({ reachable: () => true });
    hostBindingMock.current = { hostClient: spine };

    const { result } = renderInventoriesWithPowerOff(spine);
    await waitFor(() => {
      expect(result.current.inventories[0]?.status).toBe("ready");
    });
    const reads = (): number =>
      methods.filter((method) => method === "simulator.list").length;
    expect(reads()).toBe(1);
    // The `@1.0` stand-in: the booted device IS this host's instance row.
    expect(result.current.inventories[0]?.entries[0]?.kind).toBe("instance");

    act(() => {
      result.current.shutdown.mutate({
        epicId: EPIC_ID,
        simulatorId: "udid-1",
        platform: "ios",
      });
    });
    await waitFor(() => {
      expect(methods).toContain("simulator.shutdown");
    });

    // `simulator.shutdown` is the whole power off on a `@1.0` host, and it
    // moves this read exactly as `simulator.powerOff` moves it on a `@1.1`
    // one: without its sweep the palette goes on listing the device as
    // running, with no cold Boot row for it, for the whole window.
    await waitFor(() => {
      expect(reads()).toBe(2);
    });
  });
});
