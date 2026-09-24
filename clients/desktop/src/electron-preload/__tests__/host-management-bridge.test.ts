// MIX-OLD-SUPERVISOR: the preload's `restartHostServiceIfHostIdle` method,
// mirroring `host-lifecycle-bridge.test.ts`'s mock-`ipcRenderer` pattern.
// Scoped to just this method - `buildHostManagementBridge`'s other ~25
// passthroughs have no dedicated preload suite today (see that file's
// module comment); adding one here is this ticket's concern, not a
// reason to grow into a full-bridge test.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunnerHostInvoke } from "../../ipc-contracts/ipc-channels";
import type { HostServiceRestartResult } from "../../ipc-contracts/host-management-types";

interface InvokeCall {
  readonly channel: string;
  readonly args: readonly unknown[];
}

const fake = vi.hoisted(() => {
  const state: {
    invokeCalls: InvokeCall[];
    invokeResult: HostServiceRestartResult | null;
  } = {
    invokeCalls: [],
    invokeResult: null,
  };
  return state;
});

vi.mock("electron", () => ({
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]): Promise<unknown> => {
      fake.invokeCalls.push({ channel, args });
      return Promise.resolve(fake.invokeResult);
    },
    on: () => undefined,
    removeListener: () => undefined,
  },
}));

import { buildHostManagementBridge } from "../host-management-bridge";

beforeEach(() => {
  fake.invokeCalls.length = 0;
  fake.invokeResult = null;
});

describe("buildHostManagementBridge - restartHostServiceIfHostIdle", () => {
  it("invokes traycerHostServiceRestartIfHostIdle with exactly {expectedHostId}", async () => {
    fake.invokeResult = { kind: "restarted" };

    await buildHostManagementBridge().restartHostServiceIfHostIdle({
      expectedHostId: "host-local",
    });

    expect(fake.invokeCalls).toEqual([
      {
        channel: RunnerHostInvoke.traycerHostServiceRestartIfHostIdle,
        args: [{ expectedHostId: "host-local" }],
      },
    ]);
  });

  it("resolves whatever the channel returns, unchanged", async () => {
    const results: HostServiceRestartResult[] = [
      { kind: "restarted" },
      { kind: "declined", message: "Another Traycer process holds the lock." },
      { kind: "host-busy" },
    ];
    for (const result of results) {
      fake.invokeResult = result;
      await expect(
        buildHostManagementBridge().restartHostServiceIfHostIdle({
          expectedHostId: "host-local",
        }),
      ).resolves.toEqual(result);
    }
  });

  it("uses the DIFFERENT channel from the cooperative restartHostIfIdle bridge method", async () => {
    fake.invokeResult = { kind: "restarted" };
    const bridge = buildHostManagementBridge();

    await bridge.restartHostIfIdle({ expectedHostId: "host-local" });
    await bridge.restartHostServiceIfHostIdle({ expectedHostId: "host-local" });

    expect(fake.invokeCalls.map((call) => call.channel)).toEqual([
      RunnerHostInvoke.traycerHostRestartIfIdle,
      RunnerHostInvoke.traycerHostServiceRestartIfHostIdle,
    ]);
  });
});
