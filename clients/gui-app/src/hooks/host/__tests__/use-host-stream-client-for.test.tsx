import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
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
}));

vi.mock("@/lib/host/runtime", () => ({
  useHostClient: () => {
    if (globalClientRef.value === null) {
      throw new Error("test global client not configured");
    }
    return globalClientRef.value;
  },
}));

import { useHostStreamClientFor } from "@/hooks/host/use-host-stream-client-for";

function buildGlobalClient(withContext: boolean): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {},
    }),
  });
  client.bind(mockLocalHostEntry);
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
    // Building a transient stream client for host B must not move the global
    // client off its own active host (no global side effect).
    expect(globalClient.getActiveHostId()).toBe(mockLocalHostEntry.hostId);
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
