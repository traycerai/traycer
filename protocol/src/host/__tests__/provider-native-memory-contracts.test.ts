import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  providerCliStateSchema,
  providersListResponseSchema,
  providersListResponseSchemaV107Preimage,
  providersSetNativeMemoryRequestSchema,
  providersSetNativeMemoryResponseSchema,
} from "@traycer/protocol/host/provider-schemas";

function providerStateFixture(): Record<string, unknown> {
  return {
    providerId: "claude-code",
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
  };
}

describe("native memory protocol surface", () => {
  it("accepts and round-trips a row's native-memory pair on providers.list@10.8", () => {
    const row = {
      ...providerStateFixture(),
      nativeMemory: false,
      nativeMemorySupported: true,
    };

    const parsed = providersListResponseSchema.parse({
      providers: [row],
      native: null,
    });

    expect(parsed.providers[0].nativeMemory).toBe(false);
    expect(parsed.providers[0].nativeMemorySupported).toBe(true);
  });

  it("strips both keys through the frozen providers.list@10.7 preimage", () => {
    const row = {
      ...providerStateFixture(),
      nativeMemory: false,
      nativeMemorySupported: true,
    };

    const frozen = providersListResponseSchemaV107Preimage.parse({
      providers: [row],
      native: null,
    });

    expect(Object.hasOwn(frozen.providers[0], "nativeMemory")).toBe(false);
    expect(Object.hasOwn(frozen.providers[0], "nativeMemorySupported")).toBe(
      false,
    );
  });

  it("leaves nativeMemory absent rather than defaulted to true", () => {
    const parsed = providerCliStateSchema.parse(providerStateFixture());

    expect(Object.hasOwn(parsed, "nativeMemory")).toBe(false);
  });

  it("rejects a non-boolean nativeMemory", () => {
    const row = { ...providerStateFixture(), nativeMemory: "off" };

    expect(providerCliStateSchema.safeParse(row).success).toBe(false);
  });

  it("rejects an unknown harness id and a non-boolean on the write request", () => {
    expect(
      providersSetNativeMemoryRequestSchema.safeParse({
        harnessId: "claude",
        nativeMemory: false,
      }).success,
    ).toBe(true);
    expect(
      providersSetNativeMemoryRequestSchema.safeParse({
        harnessId: "not-a-real-harness",
        nativeMemory: false,
      }).success,
    ).toBe(false);
    expect(
      providersSetNativeMemoryRequestSchema.safeParse({
        harnessId: "claude",
        nativeMemory: "off",
      }).success,
    ).toBe(false);
  });

  it("echoes the persisted value on the write response", () => {
    expect(
      providersSetNativeMemoryResponseSchema.parse({ nativeMemory: false }),
    ).toEqual({ nativeMemory: false });
    expect(
      providersSetNativeMemoryResponseSchema.safeParse({ nativeMemory: "off" })
        .success,
    ).toBe(false);
  });

  it("is registered as an optional 1.0 method, out of the released floor", () => {
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(
      "providers.setNativeMemory",
    );
    const entry = hostRpcRegistry["providers.setNativeMemory"];
    expect(entry.degrade).toEqual({ kind: "unsupported" });
    expect(entry[1].latestMinor).toBe(0);
  });

  it("upgrades 10.7 to 10.8 as identity, never synthesizing nativeMemorySupported", () => {
    const majorTen = hostRpcRegistry["providers.list"][10];
    const upgrade = majorTen.versions[8].upgradeFromPreviousVersion;
    if (!upgrade) {
      throw new Error("providers.list@10.8 must declare an upgrade from 10.7");
    }

    // The 10.7 response type is what the bridge is handed, so parse the
    // fixture through the frozen preimage to get it.
    const response = providersListResponseSchemaV107Preimage.parse({
      providers: [providerStateFixture()],
      native: null,
    });
    const upgraded = upgrade.upgradeResponse(response);

    expect(upgraded).toBe(response);
  });
});
