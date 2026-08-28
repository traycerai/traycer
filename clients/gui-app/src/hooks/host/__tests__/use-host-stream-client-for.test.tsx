import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { StreamAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";

// One global client shared between the mocked `useHostClient` and the tests.
const globalClientRef = vi.hoisted(() => ({
  value: null as HostClient<HostRpcRegistry> | null,
  // Bumped by a test to make `useHostClient()` hand back a NEW requester on
  // the next render - what production does when the effective host moves.
  requesterEpoch: 0,
  requester: null as HostClient<HostRpcRegistry> | null,
  requesterFor: -1,
}));

vi.mock("@/lib/host/runtime", () => {
  const spine = () => {
    if (globalClientRef.value === null) {
      throw new Error("test global client not configured");
    }
    return globalClientRef.value;
  };
  return {
    // A requester re-minted per `requesterEpoch`, which is what production
    // `useHostClient()` hands back whenever the effective host moves. The hook
    // under test must take its auth base from the BINDING's client (the stable
    // spine) instead - with the requester in its build effect's deps, every
    // Activate/failover tore down and re-dialed unrelated stream clients.
    useHostClient: () => {
      if (globalClientRef.requesterFor !== globalClientRef.requesterEpoch) {
        globalClientRef.requester = spine().createRequesterForHostId(null);
        globalClientRef.requesterFor = globalClientRef.requesterEpoch;
      }
      return globalClientRef.requester ?? spine();
    },
    useHostBinding: () => ({ hostClient: spine(), hostId: null }),
  };
});

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ authnBaseUrl: "http://localhost:5005" }),
}));

import { useHostStreamClientFor } from "@/hooks/host/use-host-stream-client-for";

// The SPINE `useHostClient` hands back in this suite - never bound to any one
// host (redesign P4.2 deleted the active slot `.bind()` used to fill).
const knownHostEntries = new Map<string, HostDirectoryEntry>([
  [mockLocalHostEntry.hostId, mockLocalHostEntry],
]);

function buildGlobalClient(withContext: boolean): HostClient<HostRpcRegistry> {
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
  if (withContext) {
    client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-1",
      }),
    );
  }
  return client;
}

const TARGET_B: HostDirectoryEntry = {
  ...mockLocalHostEntry,
  hostId: "host-b",
  websocketUrl: "ws://127.0.0.1:59999/rpc",
};

describe("useHostStreamClientFor", () => {
  afterEach(() => {
    cleanup();
    globalClientRef.value = null;
    vi.restoreAllMocks();
  });

  it("returns null when there is no target", () => {
    globalClientRef.value = buildGlobalClient(true);
    const { result } = renderHook(() => useHostStreamClientFor(null, null));
    expect(result.current).toBeNull();
  });

  it("returns null when there is no authenticated request context", () => {
    globalClientRef.value = buildGlobalClient(false);
    const { result } = renderHook(() => useHostStreamClientFor(TARGET_B, null));
    expect(result.current).toBeNull();
  });

  it("builds a stream client for the chosen host without moving the global active host", () => {
    const globalClient = buildGlobalClient(true);
    globalClientRef.value = globalClient;
    const { result } = renderHook(() => useHostStreamClientFor(TARGET_B, null));
    expect(result.current).toBeInstanceOf(WsStreamClient);
    // Building a transient stream client for host B must not give the global
    // SPINE an active host of its own (no global side effect) - it stays
    // unbound (redesign P4.2 deleted the active slot `.bind()` used to set).
    expect(globalClient.getActiveHostId()).toBeNull();
  });

  it("memoizes for a stable target and rebuilds for a different host", () => {
    globalClientRef.value = buildGlobalClient(true);
    const { result, rerender } = renderHook(
      ({ target }) => useHostStreamClientFor(target, null),
      { initialProps: { target: TARGET_B } },
    );
    const first = result.current;
    expect(first).not.toBeNull();

    rerender({ target: TARGET_B });
    expect(result.current).toBe(first);

    const targetC: HostDirectoryEntry = { ...TARGET_B, hostId: "host-c" };
    rerender({ target: targetC });
    expect(result.current).not.toBe(first);
  });

  it("does not rebuild when the app-wide requester is re-minted (an effective-host move)", () => {
    // `useHostClient()` returns a requester pinned to the effective host and
    // re-minted when that host moves. This hook needs only the transport
    // identity - request context, user id, bearer rotation - which every
    // requester binds to the same underlying client, so it reads the
    // BINDING's client. With the requester in the build effect's deps, an
    // Activate or failover tore down and re-dialed every stream this hook
    // owns, including ones bound to hosts the move never touched, and the
    // notifications provider read its local stream's fresh instance as a
    // respawn and wiped its replica.
    globalClientRef.value = buildGlobalClient(true);
    const { result, rerender } = renderHook(
      ({ target }) => useHostStreamClientFor(target, null),
      { initialProps: { target: TARGET_B } },
    );
    const first = result.current;
    expect(first).not.toBeNull();

    globalClientRef.requesterEpoch += 1;
    rerender({ target: TARGET_B });
    expect(result.current).toBe(first);
  });

  it("does not rebuild when a fresh entry has the same transport identity", async () => {
    const closeSpy = vi.spyOn(WsStreamClient.prototype, "close");
    globalClientRef.value = buildGlobalClient(true);
    const { result, rerender } = renderHook(
      ({ target }) => useHostStreamClientFor(target, null),
      { initialProps: { target: TARGET_B } },
    );
    const first = result.current;
    expect(first).toBeInstanceOf(WsStreamClient);

    rerender({
      target: {
        ...TARGET_B,
        label: "Renamed host",
      },
    });

    expect(result.current).toBe(first);
    expect(closeSpy).not.toHaveBeenCalled();

    cleanup();
    await Promise.resolve();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy.mock.contexts[0]).toBe(first);
  });

  it("rebuilds when the same host id receives a new websocket URL", async () => {
    const closeSpy = vi.spyOn(WsStreamClient.prototype, "close");
    globalClientRef.value = buildGlobalClient(true);
    const { result, rerender } = renderHook(
      ({ target }) => useHostStreamClientFor(target, null),
      { initialProps: { target: TARGET_B } },
    );
    const first = result.current;
    expect(first).toBeInstanceOf(WsStreamClient);

    rerender({
      target: {
        ...TARGET_B,
        websocketUrl: "ws://127.0.0.1:60000/rpc",
      },
    });

    expect(result.current).toBeInstanceOf(WsStreamClient);
    expect(result.current).not.toBe(first);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy.mock.contexts[0]).toBe(first);

    const second = result.current;
    cleanup();
    await Promise.resolve();
    expect(closeSpy).toHaveBeenCalledTimes(2);
    expect(closeSpy.mock.contexts[1]).toBe(second);
  });

  it("replaces a client that closes while its host identity remains unchanged", async () => {
    globalClientRef.value = buildGlobalClient(true);
    const { result } = renderHook(() => useHostStreamClientFor(TARGET_B, null));
    const first = result.current;
    expect(first).toBeInstanceOf(WsStreamClient);

    act(() => {
      first?.close("unexpected-terminal-close");
    });

    await waitFor(() => {
      expect(result.current).toBeInstanceOf(WsStreamClient);
      expect(result.current).not.toBe(first);
      expect(result.current?.isClosed()).toBe(false);
    });
  });

  it("keeps the same stream client across a byte-identical directory re-emit (benign onLocalHostChange churn)", () => {
    // Regression for the silent chat-freeze: every `onLocalHostChange`
    // rebuilds `localEntry` and (on desktop) crosses the IPC bridge as a fresh
    // object, so even an unchanged host arrives as a NEW entry reference.
    // The memo must key on transport VALUE, not entry identity, or it tears the
    // socket down and the chat session is left holding a closed WsStreamClient.
    const closeSpy = vi.spyOn(WsStreamClient.prototype, "close");
    globalClientRef.value = buildGlobalClient(true);
    const { result, rerender } = renderHook(
      ({ target }) => useHostStreamClientFor(target, null),
      { initialProps: { target: { ...TARGET_B } } },
    );
    const first = result.current;
    expect(first).toBeInstanceOf(WsStreamClient);

    // A distinct object with byte-for-byte identical connection details.
    rerender({ target: { ...TARGET_B } });

    expect(result.current).toBe(first);
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("does not rebuild when the request context object rotates for the same user", () => {
    // Credential-lease rotation swaps the `RequestContext` object but keeps the
    // same user. The live `bearer` closure re-reads the new token on the next
    // (re)connect, so the client must NOT be rebuilt - rebuilding would close
    // the active chat socket on every token refresh.
    const closeSpy = vi.spyOn(WsStreamClient.prototype, "close");
    const globalClient = buildGlobalClient(true);
    globalClientRef.value = globalClient;
    const { result, rerender } = renderHook(
      ({ target }) => useHostStreamClientFor(target, null),
      { initialProps: { target: TARGET_B } },
    );
    const first = result.current;
    expect(first).toBeInstanceOf(WsStreamClient);

    globalClient.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-2",
      }),
    );
    rerender({ target: TARGET_B });

    expect(result.current).toBe(first);
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("threads a stable auth revalidator without churning the client, and rebuilds when it changes", () => {
    const closeSpy = vi.spyOn(WsStreamClient.prototype, "close");
    globalClientRef.value = buildGlobalClient(true);
    const authA: StreamAuthRevalidator = {
      revalidateForReconnect: () => Promise.resolve("rotated"),
    };
    const { result, rerender } = renderHook(
      ({ auth }) => useHostStreamClientFor(TARGET_B, auth),
      { initialProps: { auth: authA } },
    );
    const first = result.current;
    expect(first).toBeInstanceOf(WsStreamClient);

    // A stable revalidator (the production case - `useStreamAuthRevalidator`
    // returns a referentially stable object) must keep the same client.
    rerender({ auth: authA });
    expect(result.current).toBe(first);
    expect(closeSpy).not.toHaveBeenCalled();

    // A genuinely different revalidator identity rebuilds (and closes the old).
    const authB: StreamAuthRevalidator = {
      revalidateForReconnect: () => Promise.resolve("rotated"),
    };
    rerender({ auth: authB });
    expect(result.current).not.toBe(first);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy.mock.contexts[0]).toBe(first);
  });
});
