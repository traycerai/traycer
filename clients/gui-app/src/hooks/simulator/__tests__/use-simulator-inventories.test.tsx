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
} from "@traycer/protocol/host/simulator/schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createAppQueryClient } from "@/lib/query-client";

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
}));

import { useSimulatorInstanceOpen } from "@/hooks/simulator/use-simulator-instance-open";
import { useSimulatorInventories } from "@/hooks/simulator/use-simulator-inventories";

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

/** The same device on the `@1.1` branch, where an agent drives its instance. */
const INSTANCES: SimulatorInstancesResponse = {
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
      drivenByAgent: true,
      keepRunning: false,
      bootedByTraycer: true,
      idleUntil: null,
      tasks: [{ epicId: EPIC_ID }],
      otherTaskCount: 0,
    },
  ],
};

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

function buildSpine(): {
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
      "simulator.list": () => record("simulator.list", LIST),
      "simulator.instances": () => record("simulator.instances", INSTANCES),
      "simulator.open": () => record("simulator.open", OPENED),
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

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  hostBindingMock.current = null;
  vi.clearAllMocks();
});

describe("useSimulatorInventories", () => {
  it("sends nothing while the host's simulator minor is still unnegotiated", async () => {
    const { spine, methods } = buildSpine();
    hostBindingMock.current = { hostClient: spine };

    const { result } = renderInventories();
    await act(async () => {
      await Promise.resolve();
    });

    expect(methods).toEqual([]);
    expect(result.current.inventories[0]?.entries).toEqual([]);
  });

  it("reads the `@1.1` instance shape once the handshake lands, never the `@1.0` stand-in", async () => {
    const { spine, methods } = buildSpine();
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
    const { spine, methods } = buildSpine();
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
    const { spine, methods } = buildSpine();
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
});
