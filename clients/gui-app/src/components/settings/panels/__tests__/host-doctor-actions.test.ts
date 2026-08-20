import { describe, expect, it } from "vitest";
import { doctorFixRoute } from "@/components/settings/panels/host-doctor-actions";

describe("doctorFixRoute", () => {
  it.each([
    {
      fixAction: "host-restart",
      rpcRestartSupported: true,
      isLocalMachine: true,
      hasLocalBridge: true,
      expected: "rpc",
    },
    {
      fixAction: "host-start",
      rpcRestartSupported: true,
      isLocalMachine: false,
      hasLocalBridge: false,
      expected: "rpc",
    },
    {
      fixAction: "host-restart",
      rpcRestartSupported: false,
      isLocalMachine: true,
      hasLocalBridge: true,
      expected: "local-bridge",
    },
    {
      fixAction: "host-start",
      rpcRestartSupported: false,
      isLocalMachine: true,
      hasLocalBridge: true,
      expected: "local-bridge",
    },
    {
      fixAction: "host-restart",
      rpcRestartSupported: false,
      isLocalMachine: false,
      hasLocalBridge: true,
      expected: "copy-command",
    },
    {
      fixAction: "host-start",
      rpcRestartSupported: false,
      isLocalMachine: false,
      hasLocalBridge: false,
      expected: "copy-command",
    },
  ] as const)(
    "$fixAction supported=$rpcRestartSupported local=$isLocalMachine bridge=$hasLocalBridge → $expected",
    (row) => {
      expect(
        doctorFixRoute({
          fixAction: row.fixAction,
          isLocalMachine: row.isLocalMachine,
          hasLocalBridge: row.hasLocalBridge,
          rpcRestartSupported: row.rpcRestartSupported,
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
      }),
    ).toBe("rpc");
    expect(
      doctorFixRoute({
        fixAction: "host-logs",
        isLocalMachine: false,
        hasLocalBridge: false,
        rpcRestartSupported: true,
      }),
    ).toBe("rpc");
  });
});
