import { describe, expect, it } from "vitest";
import { doctorFixRoute } from "@/components/settings/panels/host-doctor-actions";

describe("doctorFixRoute", () => {
  it.each([
    {
      fixAction: "host-restart",
      rpcRestartSupported: true,
      bridgeRestartRoute: false,
      isLocalMachine: true,
      hasLocalBridge: true,
      expected: "rpc",
    },
    {
      fixAction: "host-start",
      rpcRestartSupported: true,
      bridgeRestartRoute: false,
      isLocalMachine: false,
      hasLocalBridge: false,
      expected: "rpc",
    },
    {
      fixAction: "host-restart",
      rpcRestartSupported: false,
      bridgeRestartRoute: true,
      isLocalMachine: true,
      hasLocalBridge: true,
      expected: "local-bridge",
    },
    {
      fixAction: "host-start",
      rpcRestartSupported: false,
      bridgeRestartRoute: true,
      isLocalMachine: true,
      hasLocalBridge: true,
      expected: "local-bridge",
    },
    {
      fixAction: "host-restart",
      rpcRestartSupported: false,
      bridgeRestartRoute: false,
      isLocalMachine: false,
      hasLocalBridge: true,
      expected: "copy-command",
    },
    {
      fixAction: "host-start",
      rpcRestartSupported: false,
      bridgeRestartRoute: false,
      isLocalMachine: false,
      hasLocalBridge: false,
      expected: "copy-command",
    },
    {
      fixAction: "host-restart",
      rpcRestartSupported: false,
      bridgeRestartRoute: false,
      isLocalMachine: true,
      hasLocalBridge: true,
      expected: "copy-command",
    },
  ] as const)(
    "$fixAction supported=$rpcRestartSupported route=$bridgeRestartRoute local=$isLocalMachine bridge=$hasLocalBridge → $expected",
    (row) => {
      expect(
        doctorFixRoute({
          fixAction: row.fixAction,
          isLocalMachine: row.isLocalMachine,
          hasLocalBridge: row.hasLocalBridge,
          rpcRestartSupported: row.rpcRestartSupported,
          bridgeRestartRoute: row.bridgeRestartRoute,
        }),
      ).toBe(row.expected);
    },
  );

  it("routes host-logs to rpc regardless of restart support, locality, or a bridge", () => {
    expect(
      doctorFixRoute({
        fixAction: "host-logs",
        isLocalMachine: true,
        hasLocalBridge: true,
        rpcRestartSupported: false,
        bridgeRestartRoute: true,
      }),
    ).toBe("rpc");
    expect(
      doctorFixRoute({
        fixAction: "host-logs",
        isLocalMachine: false,
        hasLocalBridge: false,
        rpcRestartSupported: true,
        bridgeRestartRoute: false,
      }),
    ).toBe("rpc");
  });
});
