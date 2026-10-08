import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProtocolSurface } from "@traycer/protocol/framework/surface-build";
import { protocolSurfaceSchema } from "@traycer/protocol/framework/surface-compat";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry as hostStreamRegistryFromIndex,
} from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
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

describe("host.hostInventory.subscribe against the released baseline", () => {
  const baseline = protocolSurfaceSchema.parse(
    JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          "__fixtures__/released-baseline-surface.json",
        ),
        "utf8",
      ),
    ),
  );
  const live = buildProtocolSurface({
    unary: hostRpcRegistry,
    unaryFloorMethodNames: RELEASED_FLOOR_METHOD_NAMES,
    stream: hostStreamRegistryFromIndex,
  });
  const METHOD = "host.hostInventory.subscribe";

  it("serves a 1.0 frame schema field for field the one the released clients shipped", () => {
    const released = baseline.stream[METHOD];
    const current = live.stream[METHOD];
    expect(released.schemas["1.0"]).toBeDefined();
    expect(current.schemas["1.0"]).toEqual(released.schemas["1.0"]);
  });

  it("stays on major 1 and adds 1.1 as a new installed minor", () => {
    const current = live.stream[METHOD];
    expect(current.canonical.major).toBe(
      baseline.stream[METHOD].canonical.major,
    );
    expect(baseline.stream[METHOD].majors["1"].installedMinors).toEqual([0]);
    expect(current.majors["1"].installedMinors).toEqual([0, 1]);
    expect(current.majors["1"].latestMinor).toBe(1);
  });

  it("does not let the 1.1 row leak into the 1.0 frame schema", () => {
    const current = live.stream[METHOD];
    expect(JSON.stringify(current.schemas["1.0"])).not.toContain(
      "sandboxState",
    );
    expect(JSON.stringify(current.schemas["1.1"])).toContain("sandboxState");
  });
});
