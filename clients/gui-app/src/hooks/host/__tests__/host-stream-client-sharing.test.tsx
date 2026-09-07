import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";

/** Two surfaces on one host must hold the same stream client object. */
const globalClientRef = vi.hoisted(() => ({
  value: null as HostClient<HostRpcRegistry> | null,
}));

vi.mock("@/lib/host/runtime", () => {
  const spine = () => {
    if (globalClientRef.value === null) {
      throw new Error("test global client not configured");
    }
    return globalClientRef.value;
  };
  return {
    useHostClient: spine,
    // The hook under test takes its auth base from the BINDING's client (the
    // spine), not from `useHostClient()` - see its doc comment. Same object
    // here, so every assertion about the request context still holds.
    useHostBinding: () => ({ hostClient: spine(), hostId: null }),
  };
});

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ authnBaseUrl: "http://localhost:5005" }),
}));

import { useHostStreamClientBindingFor } from "@/hooks/host/use-host-stream-client-for";
import { resetHostStreamClientCacheForTest } from "@/lib/host/host-stream-client-cache";

const knownHostEntries = new Map<string, HostDirectoryEntry>([
  [mockLocalHostEntry.hostId, mockLocalHostEntry],
]);

function buildGlobalClient(): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    findHostById: (hostId) => knownHostEntries.get(hostId) ?? null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {},
    }),
  });
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return client;
}

const HOST_B: HostDirectoryEntry = {
  ...mockLocalHostEntry,
  hostId: "host-b",
  websocketUrl: "ws://127.0.0.1:59999/rpc",
};

const HOST_C: HostDirectoryEntry = {
  ...mockLocalHostEntry,
  hostId: "host-c",
  websocketUrl: "ws://127.0.0.1:59998/rpc",
};

/**
 * Same endpoint, different host id. Remote fleet hosts share one relay URL, so a key that omitted `hostId` survived a URL-differing pair.
 */
const HOST_D_SHARING_B_ENDPOINT: HostDirectoryEntry = {
  ...HOST_B,
  hostId: "host-d",
};

/** One surface: an independent hook instance, as two re-providers would be. */
function renderSurface(target: HostDirectoryEntry) {
  return renderHook(() => useHostStreamClientBindingFor(target, null));
}

afterEach(() => {
  cleanup();
  resetHostStreamClientCacheForTest();
  globalClientRef.value = null;
});

describe("per-host stream clients are shared between surfaces", () => {
  it("gives two surfaces on the SAME host one client object", () => {
    globalClientRef.value = buildGlobalClient();
    const first = renderSurface(HOST_B);
    const second = renderSurface(HOST_B);

    const firstClient = first.result.current?.client;
    const secondClient = second.result.current?.client;
    expect(firstClient).toBeDefined();
    expect(secondClient).toBe(firstClient);
    // Named, because object identity alone reads as an implementation detail:
    // `instanceId` is what every shared-subscription registry keys its entry
    // on, so equal ids is exactly "these two surfaces share a subscription".
    expect(secondClient?.instanceId).toBe(firstClient?.instanceId);
  });

  it("gives surfaces on DIFFERENT hosts their own clients", () => {
    // The control. A cache that returned one client for everything would pass
    // the case above and route host C's subscriptions to host B.
    globalClientRef.value = buildGlobalClient();
    const onB = renderSurface(HOST_B);
    const onC = renderSurface(HOST_C);

    const clientB = onB.result.current?.client;
    const clientC = onC.result.current?.client;
    expect(clientB).toBeDefined();
    expect(clientC).toBeDefined();
    expect(clientC).not.toBe(clientB);
    expect(clientC?.instanceId).not.toBe(clientB?.instanceId);
  });

  it("separates two hosts that share ONE endpoint", () => {
    // The arm above cannot prove `hostId` separates anything, because its two hosts also differ in `websocketUrl`.
    globalClientRef.value = buildGlobalClient();
    const onB = renderSurface(HOST_B);
    const onD = renderSurface(HOST_D_SHARING_B_ENDPOINT);

    const clientB = onB.result.current?.client;
    const clientD = onD.result.current?.client;
    expect(clientB).toBeDefined();
    expect(clientD).toBeDefined();
    expect(clientD).not.toBe(clientB);
  });

  it("keeps the transport alive when only ONE of the two surfaces unmounts", () => {
    // The pairing constraint, asserted as the EFFECT (is the transport dead?) rather than as a reference count.
    globalClientRef.value = buildGlobalClient();
    const first = renderSurface(HOST_B);
    const second = renderSurface(HOST_B);
    const shared = second.result.current?.client;
    expect(shared).toBeDefined();

    first.unmount();
    expect(shared?.isClosed()).toBe(false);

    // ...and the LAST release does close it, or the fix is a leak instead.
    second.unmount();
    expect(shared?.isClosed()).toBe(true);
  });

  it("still defers a pinned transport's close past its own surface's unmount", () => {
    // `HostStreamClientBinding.pin`'s documented contract, which moved from a
    // closure count onto the cache's. Sole consumer, so nothing but the pin
    // can be holding it open.
    globalClientRef.value = buildGlobalClient();
    const surface = renderSurface(HOST_B);
    const binding = surface.result.current;
    expect(binding).not.toBeNull();
    const client = binding?.client;

    act(() => binding?.pin());
    surface.unmount();
    expect(client?.isClosed()).toBe(false);

    act(() => binding?.unpin());
    expect(client?.isClosed()).toBe(true);
  });

  it("ignores an unpin the surface never pinned, instead of closing a sibling's transport", () => {
    // The reference count is now SHARED, so an over-`unpin` no longer just clamps at zero the way the old per-instance closure did - it would return a reference this surface never took and tear down a transport another surface is reading through.
    globalClientRef.value = buildGlobalClient();
    const first = renderSurface(HOST_B);
    const second = renderSurface(HOST_B);
    const binding = first.result.current;
    const shared = second.result.current?.client;
    expect(shared).toBeDefined();

    act(() => binding?.pin());
    act(() => binding?.unpin());
    act(() => binding?.unpin());
    first.unmount();

    // Three returns against two borrows: the third must be ignored, leaving
    // the second surface's own reference holding the transport open.
    expect(shared?.isClosed()).toBe(false);
  });
});
