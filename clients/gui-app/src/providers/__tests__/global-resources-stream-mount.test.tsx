import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { ResourcesStreamCallbacks } from "@traycer-clients/shared/host-transport/resources-stream-client";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { GlobalResourcesStreamMount } from "@/providers/resources-stream-mount";
import { __setResourcesStreamClientFactoryForTests } from "@/providers/resources-stream-factory-override";
import { resourcesRegistry } from "@/stores/resources/resources-registry";

// Default remote: unknown support, no schema version. Type via the factory
// return; eslint --fix would strip an as and widen support to string.
const streamMock = vi.hoisted(
  (): {
    support: StreamMethodSupport;
    version: { readonly major: number; readonly minor: number } | null;
  } => ({
    support: "unknown",
    version: null,
  }),
);

vi.mock("@/lib/host/stream-runtime-context", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/host/stream-runtime-context")>();
  return {
    ...actual,
    useWsStreamClient: () => fakeStreamClient,
    useStreamHostId: () => "host-a",
    useStreamMethodSupport: () => streamMock.support,
    useStreamMethodSchemaVersion: () => streamMock.version,
  };
});

// The transport, present only so the mount can subscribe to its recovery
// signal. Nothing below ever calls through it — the resources stream itself is
// driven by `__setResourcesStreamClientFactoryForTests`.
const recoveryListeners = new Set<() => void>();

const fakeStreamClient: IHostStreamClient<HostStreamRpcRegistry> = {
  subscribe: () => {
    throw new Error("not exercised by this test");
  },
  subscribeWithParamsProvider: () => {
    throw new Error("not exercised by this test");
  },
  close: () => undefined,
  isClosed: () => false,
  // Never-ready is the honest answer for a fake that carries no session.
  isReady: () => false,
  notifyBearerRotated: () => undefined,
  reconnectAll: () => undefined,
  getMethodSupport: () => "unknown",
  subscribeMethodSupport: () => () => undefined,
  getMethodSchemaVersion: () => null,
  subscribeAvailabilityRecovered: (listener) => {
    recoveryListeners.add(listener);
    return () => {
      recoveryListeners.delete(listener);
    };
  },
  getClosedReason: () => null,
  onClosed: () => () => undefined,
  instanceId: "fake-global-resources-stream-client",
};

/** The host came back — a resume, a restart, or an in-place upgrade. */
function fireAvailabilityRecovered(): void {
  for (const listener of Array.from(recoveryListeners)) listener();
}

describe("GlobalResourcesStreamMount", () => {
  afterEach(() => {
    __setResourcesStreamClientFactoryForTests(null);
    resourcesRegistry.disposeAll();
    cleanup();
    streamMock.support = "unknown";
    streamMock.version = null;
  });

  it("requests interactive cadence only while its monitor is visible", () => {
    const demands: string[] = [];
    __setResourcesStreamClientFactoryForTests(() => ({
      close: () => undefined,
      setDemand: (demand) => demands.push(demand),
    }));

    const view = render(<GlobalResourcesStreamMount interactive={false} />);
    expect(demands).toEqual(["background"]);

    view.rerender(<GlobalResourcesStreamMount interactive />);
    expect(demands).toEqual(["background", "interactive"]);

    view.rerender(<GlobalResourcesStreamMount interactive={false} />);
    expect(demands).toEqual(["background", "interactive", "background"]);
  });

  /** Local host: the pre-check can convict, so nothing is dialled. Visible only as an absence. */
  it("never opens a stream when the pre-check already convicted the host", () => {
    streamMock.support = "supported";
    streamMock.version = { major: 1, minor: 0 };
    let builds = 0;
    __setResourcesStreamClientFactoryForTests((_scope, _callbacks) => {
      builds += 1;
      return { close: () => undefined, setDemand: () => undefined };
    });

    render(<GlobalResourcesStreamMount interactive={false} />);

    expect(builds).toBe(0);
    expect(resourcesRegistry.getGlobal()).toBeNull();
  });

    /**
   * Gate on the pre-stream verdict, never the full one. Gating on the full verdict is an acquire/release loop.
   */
  it("keeps the stream it opened after that stream convicts its own host", () => {
    let captured: ResourcesStreamCallbacks | null = null;
    let builds = 0;
    const emit = (): ResourcesStreamCallbacks => {
      if (captured === null) throw new Error("stream callbacks not wired");
      return captured;
    };
    __setResourcesStreamClientFactoryForTests((_scope, callbacks) => {
      builds += 1;
      captured = callbacks;
      return { close: () => undefined, setDemand: () => undefined };
    });

    render(<GlobalResourcesStreamMount interactive={false} />);
    expect(builds).toBe(1);

    act(() => {
      emit().onScopeSupport("unsupported");
    });

    expect(builds).toBe(1);
    expect(resourcesRegistry.getGlobal()).not.toBeNull();
    expect(resourcesRegistry.getGlobalScopeSupport("host-a")).toBe(
      "unsupported",
    );
  });

  /** Terminal incompatible close does not change transport identity; this hatch re-probes so an in-place upgrade is not stuck incapable. */
  it("re-probes a terminal verdict when the transport reports the host came back", () => {
    let captured: ResourcesStreamCallbacks | null = null;
    let builds = 0;
    const emit = (): ResourcesStreamCallbacks => {
      if (captured === null) throw new Error("stream callbacks not wired");
      return captured;
    };
    __setResourcesStreamClientFactoryForTests((_scope, callbacks) => {
      builds += 1;
      captured = callbacks;
      return { close: () => undefined, setDemand: () => undefined };
    });

    render(<GlobalResourcesStreamMount interactive={false} />);
    act(() => {
      emit().onScopeSupport("unsupported");
    });
    expect(builds).toBe(1);

    act(() => {
      fireAvailabilityRecovered();
    });

    // A fresh stream against the host that just came back, and the stale
    // verdict gone with the store that held it.
    expect(builds).toBe(2);
    expect(resourcesRegistry.getGlobalScopeSupport("host-a")).toBe("unknown");
  });

  // Gate re-probe on unsupported. Recovery fires on every resume, including
  // the first open.
  it("leaves a working stream alone when the transport merely reconnects", () => {
    let captured: ResourcesStreamCallbacks | null = null;
    let builds = 0;
    const emit = (): ResourcesStreamCallbacks => {
      if (captured === null) throw new Error("stream callbacks not wired");
      return captured;
    };
    __setResourcesStreamClientFactoryForTests((_scope, callbacks) => {
      builds += 1;
      captured = callbacks;
      return { close: () => undefined, setDemand: () => undefined };
    });

    render(<GlobalResourcesStreamMount interactive={false} />);
    act(() => {
      emit().onScopeSupport("supported");
    });

    act(() => {
      fireAvailabilityRecovered();
    });

    expect(builds).toBe(1);
    expect(resourcesRegistry.getGlobalScopeSupport("host-a")).toBe("supported");
  });
});
