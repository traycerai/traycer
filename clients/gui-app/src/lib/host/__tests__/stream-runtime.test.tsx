import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, act } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
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

  it("keeps the SAME client across a same-host endpoint change and nudges an immediate re-dial", () => {
    const reconnectSpy = vi.spyOn(WsStreamClient.prototype, "reconnectAll");
    const closeSpy = vi.spyOn(WsStreamClient.prototype, "close");
    const hostClient = buildClient();
    bindingRef.value = { hostClient };
    act(() => {
      hostClient.bind(mockLocalHostEntry);
    });

    const { result } = renderHook(() => useWsStreamClient(), { wrapper });
    const first = result.current;
    expect(first).toBeInstanceOf(WsStreamClient);

    // A host restart keeps the same hostId but moves to a new websocketUrl. The
    // client is keyed on host IDENTITY, so the same instance survives - it is
    // neither rebuilt nor closed - and the live `endpoint()` re-dials the new
    // address. The endpoint move nudges an immediate re-dial instead of waiting
    // out the reconnect backoff.
    act(() => {
      hostClient.bind({
        ...mockLocalHostEntry,
        websocketUrl: "ws://127.0.0.1:4918/rpc",
        status: "available",
      });
    });

    expect(result.current).toBe(first);
    expect(closeSpy).not.toHaveBeenCalled();
    expect(reconnectSpy).toHaveBeenCalledWith("host-endpoint-change");
  });

  it("rebuilds and closes the client only on a host identity change", () => {
    const closeSpy = vi.spyOn(WsStreamClient.prototype, "close");
    const hostClient = buildClient();
    bindingRef.value = { hostClient };
    act(() => {
      hostClient.bind(mockLocalHostEntry);
    });

    const { result } = renderHook(() => useWsStreamClient(), { wrapper });
    const first = result.current;
    expect(first).toBeInstanceOf(WsStreamClient);

    // A DIFFERENT hostId is a genuine identity change (host swap): the old
    // client is replaced and closed, a fresh one built for the new host.
    act(() => {
      hostClient.bind({
        ...mockLocalHostEntry,
        hostId: "host-other",
        websocketUrl: "ws://127.0.0.1:4918/rpc",
      });
    });

    expect(result.current).toBeInstanceOf(WsStreamClient);
    expect(result.current).not.toBe(first);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy.mock.contexts[0]).toBe(first);
  });

  it("rebuilds the client when it is closed underneath the provider", () => {
    const hostClient = buildClient();
    bindingRef.value = { hostClient };
    act(() => {
      hostClient.bind(mockLocalHostEntry);
    });

    const { result } = renderHook(() => useWsStreamClient(), { wrapper });
    const first = result.current;
    expect(first).toBeInstanceOf(WsStreamClient);

    // Nothing legitimate closes the served client without also replacing it;
    // if it happens anyway (the closed-client-in-context wedge), the liveness
    // guard must mint a fresh client instead of serving the dead one until a
    // window reload.
    act(() => {
      first?.close("test-external-close");
    });

    expect(first?.isClosed()).toBe(true);
    expect(result.current).toBeInstanceOf(WsStreamClient);
    expect(result.current).not.toBe(first);
    expect(result.current?.isClosed()).toBe(false);
  });

  it("nudges a re-dial exactly once under a StrictMode double-invoke", () => {
    const reconnectSpy = vi.spyOn(WsStreamClient.prototype, "reconnectAll");
    const hostClient = buildClient();
    bindingRef.value = { hostClient };
    act(() => {
      hostClient.bind(mockLocalHostEntry);
    });

    // StrictMode runs each effect setup -> cleanup -> setup on mount. The
    // ref-based dedup in `useReconnectStreamOnEndpointChange` must absorb the
    // double-invoke: a stable mount fires NO nudge, and a later same-host
    // endpoint change fires EXACTLY one - never a spurious or doubled re-dial.
    const strictWrapper = (props: {
      readonly children: ReactNode;
    }): ReactNode => (
      <StrictMode>
        <HostStreamProvider>{props.children}</HostStreamProvider>
      </StrictMode>
    );
    const { result } = renderHook(() => useWsStreamClient(), {
      wrapper: strictWrapper,
    });
    const first = result.current;
    expect(first).toBeInstanceOf(WsStreamClient);
    expect(reconnectSpy).not.toHaveBeenCalled();

    act(() => {
      hostClient.bind({
        ...mockLocalHostEntry,
        websocketUrl: "ws://127.0.0.1:4918/rpc",
        status: "available",
      });
    });

    expect(result.current).toBe(first);
    expect(reconnectSpy).toHaveBeenCalledTimes(1);
    expect(reconnectSpy).toHaveBeenCalledWith("host-endpoint-change");
  });
});
