import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";

const bindingRef = vi.hoisted(() => ({
  value: null as {
    readonly hostClient: HostClient<HostRpcRegistry>;
  } | null,
}));

// Stable hoisted stubs: both feed the value-memo / effect deps, so a fresh
// reference each render would churn the stream client.
const authServiceRef = vi.hoisted(() => ({
  value: { revalidateCurrentContext: () => Promise.resolve(null) },
}));

const runnerHostRef = vi.hoisted(() => {
  const handlers = new Set<() => void>();
  return {
    handlers,
    host: {
      onSystemResumed: (handler: () => void) => {
        handlers.add(handler);
        return { dispose: () => handlers.delete(handler) };
      },
    },
  };
});

vi.mock("@/lib/host/runtime", () => ({
  useHostBinding: () => bindingRef.value,
  useAuthService: () => authServiceRef.value,
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => runnerHostRef.host,
}));

import { HostStreamProvider } from "@/lib/host/stream-runtime";
import { useWsStreamClient } from "@/lib/host/stream-runtime-context";

function buildClient(): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {},
    }),
  });
  client.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-1",
    }),
  );
  return client;
}

function wrapper(props: { readonly children: ReactNode }): ReactNode {
  return <HostStreamProvider>{props.children}</HostStreamProvider>;
}

describe("HostStreamProvider", () => {
  afterEach(() => {
    cleanup();
    bindingRef.value = null;
    runnerHostRef.handlers.clear();
    vi.restoreAllMocks();
  });

  it("force-reconnects all stream sessions on a shell system-resume signal", () => {
    const reconnectSpy = vi.spyOn(WsStreamClient.prototype, "reconnectAll");
    const hostClient = buildClient();
    bindingRef.value = { hostClient };
    act(() => {
      hostClient.bind(mockLocalHostEntry);
    });

    const { result } = renderHook(() => useWsStreamClient(), { wrapper });
    expect(result.current).toBeInstanceOf(WsStreamClient);
    expect(runnerHostRef.handlers.size).toBe(1);

    act(() => {
      for (const handler of runnerHostRef.handlers) {
        handler();
      }
    });

    expect(reconnectSpy).toHaveBeenCalledWith("wake-resume");
  });

  it("drops and rebuilds the stream client on same-host transport changes", async () => {
    const closeSpy = vi.spyOn(WsStreamClient.prototype, "close");
    const hostClient = buildClient();
    bindingRef.value = { hostClient };
    act(() => {
      hostClient.bind(mockLocalHostEntry);
    });

    const { result } = renderHook(() => useWsStreamClient(), { wrapper });
    const first = result.current;
    expect(first).toBeInstanceOf(WsStreamClient);

    act(() => {
      hostClient.bind({
        ...mockLocalHostEntry,
        status: "unavailable",
      });
    });
    expect(result.current).toBeNull();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy.mock.contexts[0]).toBe(first);

    act(() => {
      hostClient.bind({
        ...mockLocalHostEntry,
        websocketUrl: "ws://127.0.0.1:4918/rpc",
        status: "available",
      });
    });

    expect(result.current).toBeInstanceOf(WsStreamClient);
    expect(result.current).not.toBe(first);
    const second = result.current;
    cleanup();
    await Promise.resolve();
    expect(closeSpy).toHaveBeenCalledTimes(2);
    expect(closeSpy.mock.contexts[1]).toBe(second);
  });
});
