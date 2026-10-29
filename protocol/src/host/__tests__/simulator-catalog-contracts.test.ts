import { describe, expect, it } from "vitest";
import { simulatorCatalogRecordSchema } from "@traycer/protocol/host/simulator/catalog-contracts";
import {
  simulatorCatalogReadV10,
  simulatorPowerOffV10,
} from "@traycer/protocol/host/simulator/contracts";

const RECORD = {
  epicId: "epic-1",
  hostId: "host-1",
  sessionId: "session-1",
  inventoryRevision: 3,
  lastActivityAt: 1_760_000_000_000,
  instanceKey: "ABCDEF-0000",
  simulatorId: "ABCDEF-0000",
  name: "iPhone 17",
  platform: "ios",
  version: "iOS 26.0",
  cloneOf: null,
  drivenByAgent: true,
  idleUntil: null,
  endedReason: null,
};

describe("simulator catalog contracts", () => {
  it("accepts a full record and keeps it strict", () => {
    const schema = simulatorCatalogRecordSchema;
    expect(schema.parse(RECORD)).toEqual(RECORD);
    expect(schema.safeParse({ ...RECORD, extra: true }).success).toBe(false);
    expect(
      schema.safeParse({ ...RECORD, endedReason: "crashed" }).success,
    ).toBe(false);
    expect(schema.parse({ ...RECORD, endedReason: "idle" }).endedReason).toBe(
      "idle",
    );
  });

  it("relays every catalog outcome, including a cloud that is not ready", () => {
    const schema = simulatorCatalogReadV10.responseSchema;
    expect(
      schema.parse({
        kind: "available",
        snapshot: { version: 3, records: [RECORD] },
      }),
    ).toEqual({
      kind: "available",
      snapshot: { version: 3, records: [RECORD] },
    });
    for (const kind of [
      "inaccessible",
      "unavailable",
      "local-only",
      "not-ready",
    ]) {
      expect(schema.parse({ kind })).toEqual({ kind });
    }
    expect(schema.safeParse({ kind: "pending" }).success).toBe(false);
  });

  it("answers a power-off as done or as needing confirmation", () => {
    const schema = simulatorPowerOffV10.responseSchema;
    expect(schema.parse({ kind: "powered-off", instanceKey: "k" })).toEqual({
      kind: "powered-off",
      instanceKey: "k",
    });
    expect(
      schema.parse({ kind: "confirm-required", instanceKey: "k" }),
    ).toEqual({ kind: "confirm-required", instanceKey: "k" });
    expect(
      schema.safeParse({ kind: "refused", instanceKey: "k" }).success,
    ).toBe(false);
  });
});
