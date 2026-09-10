import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  setEpicPinnedResponseSchema,
  setEpicPinnedResponseSchemaPre11,
} from "@traycer/protocol/host/epic/unary-schemas";
import { epicSetPinnedUpgradeV10ToV11 } from "@traycer/protocol/host/epic/contracts";

describe("epic.setPinned@1.1", () => {
  it("is registered alongside the frozen 1.0 contract", () => {
    const registry = hostRpcRegistry["epic.setPinned"];
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

  it("1.0 strips home from the frozen line", () => {
    const parsed = setEpicPinnedResponseSchemaPre11.parse({
      pinned: true,
      home: "local",
    });
    expect(parsed).not.toHaveProperty("home");
    expect(parsed).toEqual({ pinned: true });
  });

  it("1.1 round-trips home for both durability values", () => {
    expect(
      setEpicPinnedResponseSchema.parse({ pinned: true, home: "local" }),
    ).toEqual({ pinned: true, home: "local" });
    expect(
      setEpicPinnedResponseSchema.parse({ pinned: true, home: "cloud" }),
    ).toEqual({ pinned: true, home: "cloud" });
  });

  it("1.1 rejects an unknown home value", () => {
    const result = setEpicPinnedResponseSchema.safeParse({
      pinned: true,
      home: "disk",
    });
    expect(result.success).toBe(false);
  });

  it("1.1 keeps home absent representable", () => {
    const parsed = setEpicPinnedResponseSchema.parse({ pinned: true });
    expect(parsed).not.toHaveProperty("home");
    expect(parsed).toEqual({ pinned: true });
  });

  it("the 1.0-to-1.1 upgrade path does not synthesize home", () => {
    const upgraded = epicSetPinnedUpgradeV10ToV11.upgradeResponse({
      pinned: true,
    });
    expect(upgraded).not.toHaveProperty("home");
    expect(upgraded).toEqual({ pinned: true });
  });
});
