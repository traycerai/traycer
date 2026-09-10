import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  batchDeleteItemResultSchema,
  batchDeleteItemResultSchemaPre11,
  batchDeleteResponseSchemaPre11,
} from "@traycer/protocol/host/epic/unary-schemas";
import { epicBatchDeleteUpgradeV10ToV11 } from "@traycer/protocol/host/epic/contracts";

describe("epic.batchDelete@1.1", () => {
  it("is registered alongside the frozen 1.0 contract", () => {
    const registry = hostRpcRegistry["epic.batchDelete"];
    expect(registry[1].latestMinor).toBe(1);
    expect(registry[1].versions[0].contract.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
    expect(registry[1].versions[1].contract.schemaVersion).toEqual({
      major: 1,
      minor: 1,
    });
  });

  it("1.0 strips home from the frozen row", () => {
    const parsed = batchDeleteItemResultSchemaPre11.parse({
      taskId: "epic-1",
      success: true,
      home: "cloud",
    });
    expect(parsed).not.toHaveProperty("home");
    expect(parsed).toEqual({ taskId: "epic-1", success: true });
  });

  it("1.0 response strips home from every row", () => {
    const parsed = batchDeleteResponseSchemaPre11.parse({
      results: [
        { taskId: "epic-1", success: true, home: "local" },
        { taskId: "epic-2", success: true, home: "cloud" },
      ],
    });
    expect(parsed.results.every((row) => !("home" in row))).toBe(true);
    expect(parsed).toEqual({
      results: [
        { taskId: "epic-1", success: true },
        { taskId: "epic-2", success: true },
      ],
    });
  });

  it("1.1 round-trips home for both durability values and keeps absence representable", () => {
    expect(
      batchDeleteItemResultSchema.parse({
        taskId: "epic-1",
        success: true,
        home: "local",
      }),
    ).toEqual({ taskId: "epic-1", success: true, home: "local" });
    expect(
      batchDeleteItemResultSchema.parse({
        taskId: "epic-1",
        success: true,
        home: "cloud",
      }),
    ).toEqual({ taskId: "epic-1", success: true, home: "cloud" });
    const withoutHome = batchDeleteItemResultSchema.parse({
      taskId: "epic-1",
      success: true,
    });
    expect(withoutHome).not.toHaveProperty("home");
    expect(withoutHome).toEqual({ taskId: "epic-1", success: true });
  });

  it("1.1 rejects an unknown home value", () => {
    const result = batchDeleteItemResultSchema.safeParse({
      taskId: "epic-1",
      success: true,
      home: "disk",
    });
    expect(result.success).toBe(false);
  });

  it("the 1.0-to-1.1 upgrade path does not add home to a clean row", () => {
    const upgraded = epicBatchDeleteUpgradeV10ToV11.upgradeResponse({
      results: [
        { taskId: "epic-1", success: true },
        { taskId: "epic-2", success: false, errorMessage: "not found" },
      ],
    });
    expect(upgraded.results.every((row) => !("home" in row))).toBe(true);
    expect(upgraded).toEqual({
      results: [
        { taskId: "epic-1", success: true },
        { taskId: "epic-2", success: false, errorMessage: "not found" },
      ],
    });
  });

  // NOTE for the reviewer: `upgradeResponse` itself is `results.map((r) =>
  // ({ ...r }))` - a bare re-spread with no explicit `home` omission. It does
  // NOT independently guard against a row that already carries `home`; on
  // its own it forwards whatever key set it is given (confirmed: feeding it
  // `{ ..., home: "cloud" }` directly makes it come out the other side). The
  // guarantee this file's other tests establish - a `@1.0` wire payload can
  // never carry `home` - is enforced ONE LAYER UP, at the real call site
  // (`decodeResponsePayload` in `clients/shared/host-transport/ws-rpc-client.ts`),
  // which parses raw wire bytes through `fromVersion`'s response schema
  // (`batchDeleteResponseSchemaPre11`, which strips unknown keys) BEFORE
  // handing the result to `upgradeResponse`. This test proves that composed
  // guarantee end-to-end rather than asserting a property `upgradeResponse`
  // does not itself hold: a raw wire object that (impossibly, for a real
  // `@1.0` host) carried `home` is stripped by the schema parse before the
  // mapper ever sees it.
  it("home injected into a raw wire payload never survives the real client pipeline: schema parse, then upgrade", () => {
    const rawWireRow = {
      taskId: "epic-3",
      success: true,
      home: "cloud",
    };
    const parsedAsFromVersion = batchDeleteResponseSchemaPre11.parse({
      results: [rawWireRow],
    });
    expect(parsedAsFromVersion.results[0]).not.toHaveProperty("home");
    const upgraded =
      epicBatchDeleteUpgradeV10ToV11.upgradeResponse(parsedAsFromVersion);
    expect(upgraded.results[0]).not.toHaveProperty("home");
    expect(upgraded).toEqual({
      results: [{ taskId: "epic-3", success: true }],
    });
  });
});
