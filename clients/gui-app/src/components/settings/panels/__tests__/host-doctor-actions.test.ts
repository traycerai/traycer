import { describe, expect, it } from "vitest";
import {
  doctorFixRoute,
  freePortConfirmWentStale,
} from "@/components/settings/panels/host-doctor-actions";

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

describe("freePortConfirmWentStale", () => {
  it.each([
    {
      name: "no dialog open",
      issue: null,
      lifecycleArmed: true,
      ownDispatchCode: null,
      expected: false,
    },
    {
      name: "open + gate idle",
      issue: { code: "PORT_CONFLICT" },
      lifecycleArmed: false,
      ownDispatchCode: null,
      expected: false,
    },
    {
      name: "open + gate armed + a different code dispatching",
      issue: { code: "PORT_CONFLICT" },
      lifecycleArmed: true,
      ownDispatchCode: "HOST_NOT_INSTALLED",
      expected: true,
    },
    {
      name: "open + gate armed + this code dispatching",
      issue: { code: "PORT_CONFLICT" },
      lifecycleArmed: true,
      ownDispatchCode: "PORT_CONFLICT",
      expected: false,
    },
  ] as const)("$name → $expected", (row) => {
    expect(
      freePortConfirmWentStale({
        issue: row.issue,
        lifecycleArmed: row.lifecycleArmed,
        ownDispatchCode: row.ownDispatchCode,
      }),
    ).toBe(row.expected);
  });
});
