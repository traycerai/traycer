import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  providerCliStateSchema,
  providersSetNativeSubagentsRequestSchema,
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

describe("native subagents protocol surface", () => {
  it("registers providers.setNativeSubagents as an optional 1.0 method", () => {
    // A brand-new name at 1.0 stays out of the released floor: a floor entry
    // would make a host without it incompatible instead of "unsupported".
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(
      "providers.setNativeSubagents",
    );
    const entry = hostRpcRegistry["providers.setNativeSubagents"];
    expect(entry.degrade).toEqual({ kind: "unsupported" });
    expect(entry[1].latestMinor).toBe(0);
  });

  it("publishes nativeSubagents from providers.list 10.5 and strips it on 10.4", () => {
    const majorTen = hostRpcRegistry["providers.list"][10];
    const withValue = {
      providers: [{ ...providerStateFixture(), nativeSubagents: false }],
      native: null,
    };

    const published =
      majorTen.versions[5].contract.responseSchema.parse(withValue);
    expect(published.providers[0].nativeSubagents).toBe(false);

    const frozen =
      majorTen.versions[4].contract.responseSchema.parse(withValue);
    expect(Object.hasOwn(frozen.providers[0], "nativeSubagents")).toBe(false);
  });

  it("leaves nativeSubagents absent rather than defaulted", () => {
    const parsed = providerCliStateSchema.parse(providerStateFixture());
    expect(Object.hasOwn(parsed, "nativeSubagents")).toBe(false);
  });

  it("requires a boolean for the write", () => {
    expect(
      providersSetNativeSubagentsRequestSchema.safeParse({
        harnessId: "claude",
        nativeSubagents: false,
      }).success,
    ).toBe(true);
    expect(
      providersSetNativeSubagentsRequestSchema.safeParse({
        harnessId: "claude",
        nativeSubagents: "off",
      }).success,
    ).toBe(false);
  });
});
