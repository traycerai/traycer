import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { ResourcesStreamCallbacks } from "@traycer-clients/shared/host-transport/resources-stream-client";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { GlobalResourcesStreamMount } from "@/providers/resources-stream-mount";
import { __setResourcesStreamClientFactoryForTests } from "@/providers/resources-stream-factory-override";
import { resourcesRegistry } from "@/stores/resources/resources-registry";

// The two inputs the pre-check reads. Defaults are a REMOTE host as the
// transport actually reports one — `"unknown"` support and no client-wide
// schema version for any method — which is the state that leaves the pre-check
// unable to convict, and the state this mount has to survive.
// Typed through the factory's RETURN annotation, not an `as` on the value:
// `eslint --fix` strips a redundant-looking assertion here, and `support` then
// widens to `string`, which quietly accepts a typo'd verdict.
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

  /**
   * The other side of the gate, and the reason it is still the PRE-STREAM
   * verdict: when the pre-check CAN convict — a local host, where the
   * client-wide capability cache is real — nothing is dialled at all. That is
   * what the pre-check buys, and it is only visible as an absence.
   */
  it("never opens a stream when the pre-check already convicted the host", () => {
    streamMock.support = "supported";
    streamMock.version = { major: 1, minor: 0 };
    let builds = 0;
    __setResourcesStreamClientFactoryForTests((_scope, _callbacks) => {
      builds += 1;
      return { close: () => undefined };
    });

    render(<GlobalResourcesStreamMount />);

    expect(builds).toBe(0);
    expect(resourcesRegistry.getGlobal()).toBeNull();
  });

  /**
   * The mount gates on the PRE-STREAM verdict, never the full one the panel
   * reads — and this is what that buys.
   *
   * Gating on the full verdict is a loop with no exit: acquire → the stream
   * negotiates `@1.0` and reports `unsupported` → the effect re-runs and
   * releases → the store holding the verdict is disposed with it → the verdict
   * reverts to `unknown` → acquire again. It would re-dial a host forever, on
   * the strength of having successfully learned something about it.
   *
   * Asserted as "built once and still held", because a single rebuild is the
   * first lap of that loop, not a lesser symptom of it.
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
      return { close: () => undefined };
    });

    render(<GlobalResourcesStreamMount />);
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

  /**
   * The escape hatch for the one verdict that cannot clear itself.
   *
   * A version verdict self-heals — its stream stays open, so a drop takes the
   * negotiated version with it and the resume re-negotiates. A TERMINAL
   * incompatible close does not: it fails only the stream while the shared
   * session stays healthy, so the transport identity never changes and nothing
   * above would rebuild. Without this, a host upgraded in place goes on being
   * called incapable for as long as the surface stays mounted.
   */
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
      return { close: () => undefined };
    });

    render(<GlobalResourcesStreamMount />);
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

  // The re-probe is gated on `unsupported` for this reason. Recovery fires on
  // every ordinary resume — and on `RemoteStreamClient` even on the clean first
  // open — so an ungated version would tear down and rebuild a perfectly good
  // stream on every blip, dropping its projection each time.
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
      return { close: () => undefined };
    });

    render(<GlobalResourcesStreamMount />);
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
