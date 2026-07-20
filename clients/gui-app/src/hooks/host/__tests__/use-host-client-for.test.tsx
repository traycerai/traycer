import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import { RetryableTransportError } from "@traycer-clients/shared/host-transport/host-messenger";

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

// The hook now reads `runnerHost.authnBaseUrl` (for the remote transport's
// attach-grant minting). Local targets never touch it; stub the minimum shape.
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ authnBaseUrl: "https://authn.test" }),
}));

import {
  buildTransientHostClient,
  useHostClientFor,
} from "@/hooks/host/use-host-client-for";

class RetryTestWebSocket {
  static readonly instances: RetryTestWebSocket[] = [];

  readonly url: string;
  private readonly errorListeners = new Set<() => void>();

  constructor(url: string) {
    this.url = url;
    RetryTestWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === "error") {
      this.errorListeners.add(listener);
    }
  }

  send(_data: string): void {}

  close(_code: number, _reason: string): void {}

  emitError(): void {
    for (const listener of this.errorListeners) {
      listener();
    }
  }

  static reset(): void {
    RetryTestWebSocket.instances.length = 0;
  }
}

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
  websocketUrl: "ws://127.0.0.1:59999/stream",
};

describe("useHostClientFor", () => {
  afterEach(() => {
    cleanup();
    globalClientRef.value = null;
    RetryTestWebSocket.reset();
    vi.unstubAllGlobals();
  });

  it("returns null when there is no target", () => {
    globalClientRef.value = buildGlobalClient(true);
    const { result } = renderHook(() => useHostClientFor(null));
    expect(result.current).toBeNull();
  });

  it("returns null when there is no authenticated request context", () => {
    globalClientRef.value = buildGlobalClient(false);
    const { result } = renderHook(() => useHostClientFor(TARGET_B));
    expect(result.current).toBeNull();
  });

  it("binds the chosen host and threads the shared request context without moving the global active host", () => {
    const globalClient = buildGlobalClient(true);
    globalClientRef.value = globalClient;
    const { result } = renderHook(() => useHostClientFor(TARGET_B));
    const client = result.current;
    expect(client).toBeInstanceOf(HostClient);
    expect(client?.getActiveHostId()).toBe("host-b");
    expect(client?.getActiveHost()?.websocketUrl).toBe(TARGET_B.websocketUrl);
    // Auth is per-user, not per-host: the transient client reuses the
    // global client's request context verbatim.
    expect(client?.getRequestContext()).toBe(globalClient.getRequestContext());
    // Building a transient client for host B must not move the global
    // client off its own active host (no global side effect).
    expect(globalClient.getActiveHostId()).toBe(mockLocalHostEntry.hostId);
  });

  it("memoizes for a stable target and rebuilds for a different host", () => {
    globalClientRef.value = buildGlobalClient(true);
    const { result, rerender } = renderHook(
      ({ target }) => useHostClientFor(target),
      { initialProps: { target: TARGET_B } },
    );
    const first = result.current;
    expect(first).not.toBeNull();

    rerender({ target: TARGET_B });
    expect(result.current).toBe(first);

    const targetC: HostDirectoryEntry = { ...TARGET_B, hostId: "host-c" };
    rerender({ target: targetC });
    expect(result.current).not.toBe(first);
    expect(result.current?.getActiveHostId()).toBe("host-c");
  });

  it("keeps every retry pinned to the original target after the default host changes", async () => {
    vi.stubGlobal("WebSocket", RetryTestWebSocket);
    const hostA: HostDirectoryEntry = {
      ...mockLocalHostEntry,
      hostId: "host-a",
      websocketUrl: "ws://host-a/rpc",
    };
    const hostB: HostDirectoryEntry = {
      ...mockLocalHostEntry,
      hostId: "host-b",
      websocketUrl: "ws://host-b/rpc",
    };
    const globalClient = buildGlobalClient(true);
    globalClient.bind(hostA);
    const client = buildTransientHostClient(globalClient, hostA);
    expect(client).not.toBeNull();
    if (client === null) {
      throw new Error("Expected a host-pinned transient client");
    }

    const request = client.request("terminal.kill", { sessionId: "session-a" });
    await waitFor(() => {
      expect(RetryTestWebSocket.instances).toHaveLength(1);
    });
    globalClient.bind(hostB);
    RetryTestWebSocket.instances[0]?.emitError();

    await waitFor(() => {
      expect(RetryTestWebSocket.instances).toHaveLength(2);
    });
    RetryTestWebSocket.instances[1]?.emitError();

    await waitFor(() => {
      expect(RetryTestWebSocket.instances).toHaveLength(3);
    });
    RetryTestWebSocket.instances[2]?.emitError();

    await expect(request).rejects.toBeInstanceOf(RetryableTransportError);
    expect(RetryTestWebSocket.instances.map((socket) => socket.url)).toEqual([
      "ws://host-a/rpc",
      "ws://host-a/rpc",
      "ws://host-a/rpc",
    ]);
  });
});
