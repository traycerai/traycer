import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
  RunnerHostSync,
} from "../../ipc-contracts/ipc-channels";
import type {
  HostLifecycleSetRequest,
  HostLifecycleView,
} from "../../ipc-contracts/host-lifecycle-types";
import type {
  HostQuitDecisionRequest,
  HostQuitDecisionResponse,
  HostQuitStateEvent,
} from "../../ipc-contracts/host-quit-types";

type Listener = (event: unknown, payload: unknown) => void;

interface InvokeCall {
  readonly channel: string;
  readonly args: readonly unknown[];
}

const fake = vi.hoisted(() => {
  const state = {
    invokeCalls: [] as Array<{ channel: string; args: readonly unknown[] }>,
    syncChannels: [] as string[],
    syncImpl: (_channel: string): unknown => null,
    listeners: new Map<
      string,
      Set<(event: unknown, payload: unknown) => void>
    >(),
  };
  return state;
});

vi.mock("electron", () => ({
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]): Promise<unknown> => {
      fake.invokeCalls.push({ channel, args });
      return Promise.resolve({ echoed: channel });
    },
    sendSync: (channel: string): unknown => {
      fake.syncChannels.push(channel);
      return fake.syncImpl(channel);
    },
    on: (channel: string, listener: Listener): void => {
      let set = fake.listeners.get(channel);
      if (set === undefined) {
        set = new Set();
        fake.listeners.set(channel, set);
      }
      set.add(listener);
    },
    removeListener: (channel: string, listener: Listener): void => {
      fake.listeners.get(channel)?.delete(listener);
    },
  },
}));

import {
  buildHostLifecycleBridge,
  readLocalHostCapability,
} from "../host-lifecycle-bridge";

const VIEW: HostLifecycleView = {
  desired: { mode: "none", rev: 2, updatedBy: "desktop", updatedAt: null },
  applied: { localHostCapability: "none", supervisor: "not-running" },
  pending: "none",
};

function calls(): readonly InvokeCall[] {
  return fake.invokeCalls;
}

beforeEach(() => {
  fake.invokeCalls.length = 0;
  fake.syncChannels.length = 0;
  fake.syncImpl = () => null;
  fake.listeners.clear();
});

describe("buildHostLifecycleBridge", () => {
  it("get invokes the hostLifecycleGet channel once with no payload", async () => {
    await buildHostLifecycleBridge().get();
    expect(calls()).toEqual([
      { channel: RunnerHostInvoke.hostLifecycleGet, args: [] },
    ]);
  });

  it("set invokes hostLifecycleSet with the request unchanged", async () => {
    const request: HostLifecycleSetRequest = { mode: "none", stop: "force" };
    await buildHostLifecycleBridge().set(request);
    expect(calls()).toEqual([
      { channel: RunnerHostInvoke.hostLifecycleSet, args: [request] },
    ]);
  });

  it("onChange delivers events from hostLifecycleChange and stops after dispose", () => {
    const received: HostLifecycleView[] = [];
    const subscription = buildHostLifecycleBridge().onChange((view) => {
      received.push(view);
    });
    const listeners = fake.listeners.get(RunnerHostEvent.hostLifecycleChange);
    expect(listeners?.size).toBe(1);
    for (const listener of [...(listeners ?? [])]) {
      listener({}, VIEW);
    }
    expect(received).toEqual([VIEW]);
    subscription.dispose();
    expect(fake.listeners.get(RunnerHostEvent.hostLifecycleChange)?.size).toBe(
      0,
    );
  });
});

describe("readLocalHostCapability", () => {
  it("reads the localHostCapability sync channel", () => {
    fake.syncImpl = () => "managed";
    readLocalHostCapability();
    expect(fake.syncChannels).toEqual([RunnerHostSync.localHostCapability]);
  });

  it("passes managed and none through", () => {
    fake.syncImpl = () => "managed";
    expect(readLocalHostCapability()).toBe("managed");
    fake.syncImpl = () => "none";
    expect(readLocalHostCapability()).toBe("none");
  });

  it("falls back to managed on unanswered or garbage replies", () => {
    const garbage: unknown[] = [null, undefined, "", "bogus", 7, {}, true];
    for (const value of garbage) {
      fake.syncImpl = () => value;
      expect(readLocalHostCapability()).toBe("managed");
    }
  });

  it("falls back to managed when sendSync throws instead of breaking preload boot", () => {
    fake.syncImpl = () => {
      throw new Error("An object could not be cloned.");
    };
    expect(readLocalHostCapability()).toBe("managed");
    expect(fake.syncChannels).toEqual([RunnerHostSync.localHostCapability]);
  });
});

describe("host quit round-trip", () => {
  const REQUEST: HostQuitDecisionRequest = {
    requestId: "req-1",
    mode: "ask",
    round: "initial",
    busyMessage: null,
  };

  function requestListeners(): readonly Listener[] {
    return [...(fake.listeners.get(RunnerHostEvent.hostQuitRequest) ?? [])];
  }

  function listeningCalls(): readonly unknown[] {
    return calls()
      .filter((call) => call.channel === RunnerHostInvoke.hostQuitListening)
      .map((call) => call.args[0]);
  }

  function ackCalls(): readonly unknown[] {
    return calls()
      .filter((call) => call.channel === RunnerHostInvoke.hostQuitAcknowledge)
      .map((call) => call.args[0]);
  }

  it("uses exactly the documented channel names", () => {
    expect(RunnerHostEvent.hostQuitRequest).toBe(
      "runnerHost:event:hostQuit:request",
    );
    expect(RunnerHostInvoke.hostQuitRespond).toBe(
      "runnerHost:hostQuit:respond",
    );
    expect(RunnerHostEvent.hostQuitState).toBe(
      "runnerHost:event:hostQuit:state",
    );
  });

  it("reports listening:true on the first subscriber only and false on the last dispose only", () => {
    const bridge = buildHostLifecycleBridge();
    const first = bridge.onQuitRequest(() => undefined);
    expect(listeningCalls()).toEqual([true]);
    const second = bridge.onQuitRequest(() => undefined);
    expect(listeningCalls()).toEqual([true]);
    expect(requestListeners()).toHaveLength(2);

    first.dispose();
    expect(listeningCalls()).toEqual([true]);
    // A double dispose must not decrement twice.
    first.dispose();
    expect(listeningCalls()).toEqual([true]);
    expect(requestListeners()).toHaveLength(1);

    second.dispose();
    expect(listeningCalls()).toEqual([true, false]);
    expect(requestListeners()).toHaveLength(0);
  });

  it("acknowledges the requestId after the handler returns, not before", () => {
    const order: string[] = [];
    const bridge = buildHostLifecycleBridge();
    bridge.onQuitRequest(() => {
      order.push(`handler(acks=${ackCalls().length})`);
    });
    const [listener] = requestListeners();
    listener({}, REQUEST);
    expect(order).toEqual(["handler(acks=0)"]);
    expect(ackCalls()).toEqual(["req-1"]);
  });

  it("does not acknowledge when the handler throws", () => {
    const bridge = buildHostLifecycleBridge();
    bridge.onQuitRequest(() => {
      throw new Error("modal crashed");
    });
    const [listener] = requestListeners();
    expect(() => {
      listener({}, REQUEST);
    }).toThrow("modal crashed");
    expect(ackCalls()).toEqual([]);
  });

  it("respondToQuitRequest invokes hostQuitRespond with the payload unchanged", async () => {
    const response: HostQuitDecisionResponse = {
      requestId: "req-1",
      decision: { kind: "stop", force: true, remember: false },
    };
    await buildHostLifecycleBridge().respondToQuitRequest(response);
    expect(calls()).toEqual([
      { channel: RunnerHostInvoke.hostQuitRespond, args: [response] },
    ]);
  });

  it("onQuitState delivers state events and stops after dispose", () => {
    const received: HostQuitStateEvent[] = [];
    const subscription = buildHostLifecycleBridge().onQuitState((event) => {
      received.push(event);
    });
    const listeners = [
      ...(fake.listeners.get(RunnerHostEvent.hostQuitState) ?? []),
    ];
    expect(listeners).toHaveLength(1);
    const event: HostQuitStateEvent = { requestId: "req-1", phase: "stopping" };
    for (const listener of listeners) listener({}, event);
    expect(received).toEqual([event]);
    subscription.dispose();
    expect(fake.listeners.get(RunnerHostEvent.hostQuitState)?.size).toBe(0);
    for (const listener of listeners) {
      // A delivery after dispose reaches nobody: the listener is detached.
      expect(
        fake.listeners.get(RunnerHostEvent.hostQuitState)?.has(listener),
      ).toBe(false);
    }
  });
});
