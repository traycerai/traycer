import { describe, expect, it } from "vitest";
import { RPC_ERROR_CODES } from "@traycer/protocol/framework/versioned-rpc-types";
import {
  hostInventorySubscribeServerFrameSchemaV10,
  hostInventorySubscribeServerFrameSchemaV11,
  hostInventorySubscribeV10,
  hostInventorySubscribeV11,
} from "../host-inventory";
import { hostStreamRpcRegistry } from "../registry";
import { HOST_LIST_ITEM_GOLDEN_FIXTURE } from "../__fixtures__/host-status-golden-fixture";

const SANDBOX_ROW = {
  ...HOST_LIST_ITEM_GOLDEN_FIXTURE,
  hostId: "sandbox-host-id",
  kind: "sandbox",
  sandboxState: "suspended",
  sandboxFrozen: true,
  profile: "agent",
} as const;

function snapshot(hosts: readonly object[]) {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    hosts,
    fetchedAtMs: 1_000,
    stale: false,
  };
}

describe("host.hostInventory.subscribe minors", () => {
  it("registers 1.1 as the latest minor with 1.0 still installed", () => {
    const line = hostStreamRpcRegistry["host.hostInventory.subscribe"][1];
    expect(line.latestMinor).toBe(1);
    expect(line.versions[0].contract).toBe(hostInventorySubscribeV10);
    expect(line.versions[1].contract).toBe(hostInventorySubscribeV11);
  });

  it("1.0 stays frozen: a personal row parses, a row carrying any sandbox field does not", () => {
    expect(
      hostInventorySubscribeServerFrameSchemaV10.safeParse(
        snapshot([HOST_LIST_ITEM_GOLDEN_FIXTURE]),
      ).success,
    ).toBe(true);
    expect(
      hostInventorySubscribeServerFrameSchemaV10.safeParse(
        snapshot([SANDBOX_ROW]),
      ).success,
    ).toBe(false);
    expect(
      hostInventorySubscribeServerFrameSchemaV10.safeParse(
        snapshot([{ ...HOST_LIST_ITEM_GOLDEN_FIXTURE, profile: null }]),
      ).success,
    ).toBe(false);
  });

  it("1.1 carries sandbox rows and fields beside personal rows, verbatim", () => {
    const frame = snapshot([HOST_LIST_ITEM_GOLDEN_FIXTURE, SANDBOX_ROW]);
    const parsed = hostInventorySubscribeServerFrameSchemaV11.parse(frame);
    expect(parsed).toEqual(frame);
  });

  it("1.1 still rejects an unknown sandbox state", () => {
    expect(
      hostInventorySubscribeServerFrameSchemaV11.safeParse(
        snapshot([{ ...SANDBOX_ROW, sandboxState: "hibernating" }]),
      ).success,
    ).toBe(false);
  });

  it("1.1 keeps the pong frame", () => {
    expect(
      hostInventorySubscribeServerFrameSchemaV11.safeParse({
        kind: "pong",
        hasBinaryPayload: false,
      }).success,
    ).toBe(true);
  });
});

describe("sandbox refusal codes", () => {
  it("are wire error codes", () => {
    for (const code of [
      "SANDBOX_FROZEN",
      "SANDBOX_HOST_REFUSES_CREDENTIALS",
      "SANDBOX_GUEST_NOT_CONFIGURED",
    ]) {
      expect(RPC_ERROR_CODES).toContain(code);
    }
  });
});
