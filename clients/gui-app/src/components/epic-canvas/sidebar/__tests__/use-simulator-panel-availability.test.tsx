import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { JSX, ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createAppQueryClient } from "@/lib/query-client";

/**
 * The Mobile simulators panel's first presence input: can THIS MACHINE run a
 * simulator platform (`left-panel-registry.ts`'s `SIMULATORS_AUTO_HINT`
 * promises exactly that wording). Every other suite that touches the panel -
 * `epic-sidebar`, `simulator-create-picker`, the palette's simulators subpage -
 * fakes `useSimulatorPanelAvailability` wholesale, so nothing covered the hook
 * itself, and nothing said which host it asks.
 *
 * Which host it asks is the whole content. `useHostClientForHostId(null)`
 * returns the FOLLOWING client, not `null`, so the `localHostId === null`
 * guard in the hook is the only thing standing between "this machine" and
 * "whatever host this window follows". The fixture therefore gives the two
 * different hosts and makes the followed one a tempting wrong answer: it
 * advertises `simulator.status` and reports iOS available, exactly as a desk
 * Mac does to a browser or phone client bound to it.
 *
 * A shell with no local machine (`IRunnerHost.hasLocalHost === false`:
 * `clients/mobile/src/mobile-runner-host.ts`, and a desktop launch whose
 * bridge reports `localHostCapability: "none"`) keeps
 * `HostDirectoryService.getLocalHostId()` at `null` for its whole life, so the
 * second case below is that shell: the panel rides the task's catalog records
 * alone there, and that is the rule rather than a gap in it.
 */

const LOCAL_HOST: HostDirectoryEntry = {
  ...mockLocalHostEntry,
  hostId: "host-this-machine",
};
const FOLLOWED_HOST: HostDirectoryEntry = {
  ...mockRemoteHostEntry,
  hostId: "host-followed",
};

const spineRef = vi.hoisted<{ value: HostClient<HostRpcRegistry> | null }>(
  () => ({ value: null }),
);
const localHostIdRef = vi.hoisted<{ value: string | null }>(() => ({
  value: null,
}));

function getSpine(): HostClient<HostRpcRegistry> {
  if (spineRef.value === null) {
    throw new Error("test spine not configured");
  }
  return spineRef.value;
}

/** Only the two members `getLocalHostId` is reached through. */
const testDirectory = {
  onChange: () => ({ dispose: () => undefined }),
  getLocalHostId: () => localHostIdRef.value,
};

vi.mock("@/lib/host", () => ({
  // The app-wide binding: it names no host, so a consumer resolving through
  // it gets the selection layer's answer (`useHostClient` below) and an
  // explicit id gets a named requester off this same spine.
  useHostBinding: () => ({
    hostClient: getSpine(),
    hostId: null,
    directory: testDirectory,
  }),
  useHostClient: () =>
    getSpine().createRequesterForHostId(FOLLOWED_HOST.hostId),
  useHostDirectory: () => testDirectory,
}));

import { useSimulatorPanelAvailability } from "@/components/epic-canvas/sidebar/use-simulator-panel-availability";

function buildSpine(): MockHostMessenger<HostRpcRegistry> {
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "simulator-status-req",
    handlers: {
      // Both machines can run iOS, so "it answered true" proves nothing on its
      // own - only the endpoint the answer came from does.
      "simulator.status": () => ({
        platforms: [
          { platform: "ios", available: true, reason: null },
          { platform: "android", available: false, reason: "No Android SDK." },
        ],
        packState: { kind: "ready", reason: null, progress: null },
        packVersion: "0.15.3-0.21.25.22.23.3",
        installed: {
          version: "0.15.3-0.21.25.22.23.3",
          sizeBytes: 216 * 1024 ** 2,
        },
      }),
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    messenger,
    invalidator: { invalidateHostScope: () => undefined },
    schedulingPolicy: hostRpcSchedulingPolicy,
    findHostById: (hostId) =>
      [LOCAL_HOST, FOLLOWED_HOST].find((entry) => entry.hostId === hostId) ??
      null,
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-simulator-panel",
    }),
  );
  spineRef.value = spine;
  // Both hosts completed a handshake advertising the read, so the fail-closed
  // support gate is not what suppresses anything below.
  recordNegotiatedHostMethods(LOCAL_HOST.hostId, [
    "host.status",
    "simulator.status",
  ]);
  recordNegotiatedHostMethods(FOLLOWED_HOST.hostId, [
    "host.status",
    "simulator.status",
  ]);
  return messenger;
}

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

function askedHostIds(
  messenger: MockHostMessenger<HostRpcRegistry>,
): readonly string[] {
  return messenger.calls
    .filter((call) => call.method === "simulator.status")
    .map((call) => call.authority.endpoint.hostId);
}

afterEach(() => {
  cleanup();
  spineRef.value = null;
  localHostIdRef.value = null;
  resetNegotiatedManifests();
  vi.clearAllMocks();
});

describe("useSimulatorPanelAvailability", () => {
  it("asks this machine's host, never the one the window follows", async () => {
    const messenger = buildSpine();
    localHostIdRef.value = LOCAL_HOST.hostId;

    const { result } = renderHook(() => useSimulatorPanelAvailability(), {
      wrapper: wrapper(),
    });

    await waitFor(() => {
      expect(result.current.localHostRunsSimulators).toBe(true);
    });
    expect(new Set(askedHostIds(messenger))).toEqual(
      new Set([LOCAL_HOST.hostId]),
    );
  });

  it("asks nothing on a shell with no local machine, and answers once one exists", async () => {
    const messenger = buildSpine();

    const { result, rerender } = renderHook(
      () => useSimulatorPanelAvailability(),
      { wrapper: wrapper() },
    );

    expect(result.current.localHostRunsSimulators).toBe(false);
    // No catalog provider above the hook, so the panel's other presence input
    // is absent too - which is what leaves the panel off this shell until the
    // task holds a record.
    expect(result.current.hasSimulatorRecords).toBe(false);

    // The flip is what makes the assertion below mean something: it proves
    // the read was live all along and had simply been given no machine to
    // ask, rather than the test having asserted an absence too early.
    localHostIdRef.value = LOCAL_HOST.hostId;
    rerender();
    await waitFor(() => {
      expect(result.current.localHostRunsSimulators).toBe(true);
    });

    expect(askedHostIds(messenger)).not.toContain(FOLLOWED_HOST.hostId);
  });
});
