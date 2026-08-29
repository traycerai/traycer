import { describe, expect, it, vi } from "vitest";
import type { HostTransportEndpoint } from "@traycer-clients/shared/host-transport/host-messenger";
import { startEndpointPump } from "../epic-runtime-endpoint-pump";

const ONE: HostTransportEndpoint = {
  hostId: "host-1",
  websocketUrl: "ws://one",
};
const TWO: HostTransportEndpoint = {
  hostId: "host-1",
  websocketUrl: "ws://two",
};

interface PumpHarness {
  readonly pushes: Array<HostTransportEndpoint | null>;
  readonly failures: unknown[];
  readonly fire: () => void;
  readonly subscribers: () => number;
  readonly stop: () => void;
}

function startHarness(read: () => HostTransportEndpoint | null): PumpHarness {
  const pushes: Array<HostTransportEndpoint | null> = [];
  const failures: unknown[] = [];
  const changes = new Set<() => void>();
  const stop = startEndpointPump({
    endpoint: read,
    subscribeEndpointChange: (onChange) => {
      changes.add(onChange);
      return () => changes.delete(onChange);
    },
    push: (endpoint) => pushes.push(endpoint),
    onReadFailure: (cause) => failures.push(cause),
  });
  return {
    pushes,
    failures,
    fire: () => {
      for (const onChange of [...changes]) onChange();
    },
    subscribers: () => changes.size,
    stop,
  };
}

describe("startEndpointPump", () => {
  it("pushes the current endpoint immediately", () => {
    const harness = startHarness(() => ONE);

    // Before this push the worker's holder answers `null`, which the transport
    // reads as "do not dial". A pump that waited for the first CHANGE would
    // leave a healthy host undialable until the directory happened to move.
    expect(harness.pushes).toEqual([ONE]);
    harness.stop();
  });

  it("pushes an initial null rather than suppressing it", () => {
    const harness = startHarness(() => null);

    // `null` is a legitimate value - a host with no websocket URL, or a
    // confirmed transport refusal - not the absence of one. A dedupe keyed on
    // `lastPushed !== null` cannot tell "never pushed" from "pushed null" and
    // would drop exactly this frame.
    expect(harness.pushes).toEqual([null]);
    harness.stop();
  });

  it("pushes on a genuine move and stays quiet for an unchanged re-emit", () => {
    let current: HostTransportEndpoint | null = ONE;
    const harness = startHarness(() => current);

    harness.fire();
    harness.fire();
    expect(harness.pushes).toEqual([ONE]);

    current = TWO;
    harness.fire();
    expect(harness.pushes).toEqual([ONE, TWO]);

    // Value equality, not identity: the directory rebuilds its entry on every
    // change, and on desktop it crosses the IPC bridge as a fresh object - so
    // an identity dedupe would post on every one of those.
    current = { hostId: "host-1", websocketUrl: "ws://two" };
    harness.fire();
    expect(harness.pushes).toEqual([ONE, TWO]);
    harness.stop();
  });

  it("pushes a move to null and back", () => {
    let current: HostTransportEndpoint | null = ONE;
    const harness = startHarness(() => current);

    current = null;
    harness.fire();
    current = ONE;
    harness.fire();

    // A host going away and returning. The transport's own filter decides
    // whether either edge is worth a re-dial; the pump's job is only to keep
    // the replica true.
    expect(harness.pushes).toEqual([ONE, null, ONE]);
    harness.stop();
  });

  it("subscribes before taking its first reading", () => {
    // The bearer pump's ordering, for the bearer pump's reason: a host that
    // moved between the snapshot and the subscription would emit to nobody,
    // and the worker would dial a dead address until the next unrelated change
    // arrived. Observed from inside the read, which is the only place that can
    // see which came first.
    let subscribedWhenRead: number | null = null;
    const changes = new Set<() => void>();
    const stop = startEndpointPump({
      endpoint: () => {
        subscribedWhenRead = changes.size;
        return ONE;
      },
      subscribeEndpointChange: (onChange) => {
        changes.add(onChange);
        return () => changes.delete(onChange);
      },
      push: () => {},
      onReadFailure: () => {},
    });

    expect(subscribedWhenRead).toBe(1);
    stop();
  });

  it("reports a throwing read and pushes null rather than escaping", () => {
    const failure = new Error("directory exploded");
    const harness = startHarness(() => {
      throw failure;
    });

    // The pump runs inside the directory's notification loop, which iterates
    // its subscribers without catching. An escaping throw would silently stop
    // every OTHER subscriber of that signal - a failure whose symptom appears
    // nowhere near its cause.
    expect(harness.failures).toEqual([failure]);
    expect(harness.pushes).toEqual([null]);
    harness.stop();
  });

  it("stops pushing once disposed", () => {
    let current: HostTransportEndpoint | null = ONE;
    const harness = startHarness(() => current);
    const push = vi.fn();

    harness.stop();
    expect(harness.subscribers()).toBe(0);
    current = TWO;
    harness.fire();

    expect(harness.pushes).toEqual([ONE]);
    expect(push).not.toHaveBeenCalled();
  });
});
