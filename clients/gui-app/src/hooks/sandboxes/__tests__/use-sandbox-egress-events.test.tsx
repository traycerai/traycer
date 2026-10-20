import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  SANDBOX_EGRESS_SNAPSHOT_MAX_EVENTS,
  type SandboxEgressEvent,
} from "@traycer/protocol/host/sandbox-egress";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  ServerFrameHandler,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { StreamRuntimeBinding } from "@/lib/host/stream-runtime-context";

type SupportRead = StreamMethodSupport | null;

const mocks = vi.hoisted(() => ({
  binding: null as StreamRuntimeBinding | null,
  support: "supported" as SupportRead,
  frameHandler: null as ServerFrameHandler | null,
  requestedBindingHosts: [] as Array<string | null>,
  supportedMethods: [] as string[],
}));

vi.mock("@/hooks/host/use-surface-host-stream-binding", () => ({
  useSurfaceHostStreamBinding: (hostId: string | null) => {
    mocks.requestedBindingHosts.push(hostId);
    return mocks.binding;
  },
}));
vi.mock("@/lib/host/stream-runtime-context", () => ({
  useStreamMethodSupportFor: (_client: unknown, method: string) => {
    mocks.supportedMethods.push(method);
    return mocks.support;
  },
}));

import {
  appendSandboxEgressEvent,
  useSandboxEgressEvents,
} from "@/hooks/sandboxes/use-sandbox-egress-events";

const HOST_ID = "host-sbx";

function teardownEvent(id: string): SandboxEgressEvent {
  return {
    kind: "egress.teardown",
    id,
    at: 1_000,
    emitter: "gateway",
    untrusted: false,
    route: "route-1",
    reason: "drain",
  };
}

const closeSession = vi.fn<() => void>();
const subscribe = vi.fn<(method: string, params: unknown) => IStreamSession>();

function fakeSession(): IStreamSession {
  return {
    sendClientFrame: () => undefined,
    onServerFrame: (handler) => {
      mocks.frameHandler = handler;
    },
    onStatusChange: () => undefined,
    requestReconnect: () => undefined,
    getNegotiatedSchemaVersion: () => null,
    close: closeSession,
  };
}

function fakeClient(): IHostStreamClient<HostStreamRpcRegistry> {
  return {
    subscribe,
    subscribeWithParamsProvider: () => {
      throw new Error("not exercised by this test");
    },
    close: () => undefined,
    isClosed: () => false,
    isReady: () => true,
    notifyBearerRotated: () => undefined,
    notifyCloudVerdictChanged: () => undefined,
    reconnectAll: () => undefined,
    getMethodSupport: () => "supported",
    subscribeMethodSupport: () => () => undefined,
    getMethodSchemaVersion: () => null,
    subscribeAvailabilityRecovered: () => () => undefined,
    getClosedReason: () => null,
    onClosed: () => () => undefined,
    instanceId: "fake-sandbox-egress-client",
  };
}

function pushFrame(envelope: StreamFrameEnvelope): void {
  const handler = mocks.frameHandler;
  if (handler === null) throw new Error("no frame handler was installed");
  act(() => {
    handler(envelope, null);
  });
}

function snapshotFrame(
  events: readonly SandboxEgressEvent[],
): StreamFrameEnvelope {
  return { kind: "snapshot", hasBinaryPayload: false, events };
}

function eventFrame(event: SandboxEgressEvent): StreamFrameEnvelope {
  return { kind: "event", hasBinaryPayload: false, event };
}

function idsOf(events: readonly SandboxEgressEvent[]): string[] {
  return events.map((event) => event.id);
}

beforeEach(() => {
  mocks.binding = {
    wsStreamClient: fakeClient(),
    hostId: HOST_ID,
    retain: () => () => undefined,
  };
  mocks.support = "supported";
  mocks.frameHandler = null;
  mocks.requestedBindingHosts.length = 0;
  mocks.supportedMethods.length = 0;
  closeSession.mockReset();
  subscribe.mockReset();
  subscribe.mockImplementation(() => fakeSession());
});
afterEach(cleanup);

describe("appendSandboxEgressEvent", () => {
  it("appends a new event after the ones held", () => {
    const held = [teardownEvent("e1")];

    const next = appendSandboxEgressEvent(held, teardownEvent("e2"));

    expect(idsOf(next)).toEqual(["e1", "e2"]);
  });

  it("returns the same array for an id already held", () => {
    const held = [teardownEvent("e1"), teardownEvent("e2")];

    const next = appendSandboxEgressEvent(held, teardownEvent("e1"));

    expect(next).toBe(held);
  });

  it("drops the oldest past the snapshot cap, keeping the newest last", () => {
    const held: SandboxEgressEvent[] = [];
    for (let n = 1; n <= SANDBOX_EGRESS_SNAPSHOT_MAX_EVENTS; n += 1) {
      held.push(teardownEvent(`e${n}`));
    }

    const next = appendSandboxEgressEvent(held, teardownEvent("newest"));

    expect(next).toHaveLength(SANDBOX_EGRESS_SNAPSHOT_MAX_EVENTS);
    expect(next.at(-1)?.id).toBe("newest");
    expect(next[0]?.id).toBe("e2");
    expect(idsOf(next)).not.toContain("e1");
  });
});

describe("useSandboxEgressEvents", () => {
  it("subscribes to nothing and yields no events while the host is null", () => {
    const { result } = renderHook(() => useSandboxEgressEvents(null));

    expect(subscribe).not.toHaveBeenCalled();
    expect(result.current).toEqual([]);
  });

  it("subscribes to the egress stream with an empty request", () => {
    renderHook(() => useSandboxEgressEvents(HOST_ID));

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith("host.sandbox.egress.subscribe", {});
    expect(mocks.requestedBindingHosts).toContain(HOST_ID);
    expect(mocks.supportedMethods).toContain("host.sandbox.egress.subscribe");
  });

  it("holds nothing before the first snapshot arrives", () => {
    const { result } = renderHook(() => useSandboxEgressEvents(HOST_ID));

    expect(result.current).toEqual([]);
  });

  it("returns the events of a snapshot frame", () => {
    const { result } = renderHook(() => useSandboxEgressEvents(HOST_ID));

    pushFrame(snapshotFrame([teardownEvent("e1"), teardownEvent("e2")]));

    expect(idsOf(result.current)).toEqual(["e1", "e2"]);
  });

  it("appends an event frame after the snapshot", () => {
    const { result } = renderHook(() => useSandboxEgressEvents(HOST_ID));
    pushFrame(snapshotFrame([teardownEvent("e1"), teardownEvent("e2")]));

    pushFrame(eventFrame(teardownEvent("e3")));

    expect(idsOf(result.current)).toEqual(["e1", "e2", "e3"]);
  });

  it("starts from an event frame that arrives before any snapshot", () => {
    const { result } = renderHook(() => useSandboxEgressEvents(HOST_ID));

    pushFrame(eventFrame(teardownEvent("e1")));

    expect(idsOf(result.current)).toEqual(["e1"]);
  });

  it("does not duplicate a replayed event id", () => {
    const { result } = renderHook(() => useSandboxEgressEvents(HOST_ID));
    pushFrame(snapshotFrame([teardownEvent("e1"), teardownEvent("e2")]));
    pushFrame(eventFrame(teardownEvent("e3")));

    pushFrame(eventFrame(teardownEvent("e2")));
    pushFrame(eventFrame(teardownEvent("e3")));

    expect(idsOf(result.current)).toEqual(["e1", "e2", "e3"]);
  });

  it("replaces what it holds when a second snapshot arrives", () => {
    const { result } = renderHook(() => useSandboxEgressEvents(HOST_ID));
    pushFrame(snapshotFrame([teardownEvent("e1"), teardownEvent("e2")]));
    pushFrame(eventFrame(teardownEvent("e3")));

    pushFrame(snapshotFrame([teardownEvent("e9")]));

    expect(idsOf(result.current)).toEqual(["e9"]);
  });

  it("changes nothing for a frame it cannot parse", () => {
    const { result } = renderHook(() => useSandboxEgressEvents(HOST_ID));
    pushFrame(snapshotFrame([teardownEvent("e1")]));

    pushFrame({ kind: "nonsense", hasBinaryPayload: false });

    expect(idsOf(result.current)).toEqual(["e1"]);
  });

  it("ignores a pong frame", () => {
    const { result } = renderHook(() => useSandboxEgressEvents(HOST_ID));
    pushFrame(snapshotFrame([teardownEvent("e1")]));

    pushFrame({ kind: "pong", hasBinaryPayload: false });

    expect(idsOf(result.current)).toEqual(["e1"]);
  });

  it("subscribes to nothing when the binding names a different host", () => {
    mocks.binding = {
      wsStreamClient: fakeClient(),
      hostId: "other-host",
      retain: () => () => undefined,
    };

    const { result } = renderHook(() => useSandboxEgressEvents(HOST_ID));

    expect(subscribe).not.toHaveBeenCalled();
    expect(result.current).toEqual([]);
  });

  it("subscribes to nothing when there is no binding", () => {
    mocks.binding = null;

    const { result } = renderHook(() => useSandboxEgressEvents(HOST_ID));

    expect(subscribe).not.toHaveBeenCalled();
    expect(result.current).toEqual([]);
  });

  it("subscribes to nothing when the host does not support the stream", () => {
    mocks.support = "unsupported";

    const { result } = renderHook(() => useSandboxEgressEvents(HOST_ID));

    expect(subscribe).not.toHaveBeenCalled();
    expect(result.current).toEqual([]);
  });

  it("closes the session on unmount", () => {
    const { unmount } = renderHook(() => useSandboxEgressEvents(HOST_ID));
    expect(closeSession).not.toHaveBeenCalled();

    unmount();

    expect(closeSession).toHaveBeenCalledTimes(1);
  });

  it("ignores a frame that arrives after unmount", () => {
    const { unmount } = renderHook(() => useSandboxEgressEvents(HOST_ID));
    const handler = mocks.frameHandler;
    unmount();

    expect(() => {
      handler?.(snapshotFrame([teardownEvent("late")]), null);
    }).not.toThrow();
  });

  it("shows no events once the host goes back to null", () => {
    const initialProps: { readonly hostId: string | null } = {
      hostId: HOST_ID,
    };
    const { result, rerender } = renderHook(
      (props: { readonly hostId: string | null }) =>
        useSandboxEgressEvents(props.hostId),
      { initialProps },
    );
    pushFrame(snapshotFrame([teardownEvent("e1")]));
    expect(idsOf(result.current)).toEqual(["e1"]);

    rerender({ hostId: null });

    expect(result.current).toEqual([]);
    expect(closeSession).toHaveBeenCalledTimes(1);
  });
});
