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
