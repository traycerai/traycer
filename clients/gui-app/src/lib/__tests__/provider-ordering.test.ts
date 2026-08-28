import { describe, expect, it } from "vitest";
import {
  guiHarnessIdSchema,
  type GuiHarnessId,
} from "@traycer/protocol/host/index";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import {
  guiHarnessIdToProviderId,
  ORDERED_PROVIDERS,
  orderProvidersByEnablement,
  providerCliIdForHarness,
} from "@/lib/provider-ordering";

// Read from the protocol schema rather than hand-copying the harness id
// list, so a future harness lands in this coverage automatically.
const ALL_HARNESS_IDS: ReadonlyArray<GuiHarnessId> = guiHarnessIdSchema.options;

describe("providerCliIdForHarness", () => {
  it("covers at least one harness id (guards against an empty schema read)", () => {
    expect(ALL_HARNESS_IDS.length).toBeGreaterThan(0);
  });

  it("returns null for traycer - the one harness with no provider-CLI login concept", () => {
    expect(providerCliIdForHarness("traycer")).toBeNull();
  });

  it("diverges from guiHarnessIdToProviderId only on traycer - the exact divergence this consolidation exists to keep explicit", () => {
    expect(guiHarnessIdToProviderId("traycer")).toBe("traycer");
    expect(providerCliIdForHarness("traycer")).toBeNull();
  });

  it("matches guiHarnessIdToProviderId for every harness id other than traycer", () => {
    ALL_HARNESS_IDS.filter((harnessId) => harnessId !== "traycer").forEach(
      (harnessId) => {
        expect(providerCliIdForHarness(harnessId)).toBe(
          guiHarnessIdToProviderId(harnessId),
        );
      },
    );
  });
});

describe("orderProvidersByEnablement", () => {
  const ALL_PROVIDER_IDS: ReadonlyArray<ProviderId> = ORDERED_PROVIDERS.map(
    (p) => p.providerId,
  );

  it("puts the enabled group first, each group keeping ORDERED_PROVIDERS' relative order", () => {
    const enabledIds: ReadonlySet<ProviderId> = new Set([
      // Deliberately NOT the first two entries of ORDERED_PROVIDERS, and out
      // of relative order in the input set, so a pass here can't be
      // explained by the set already matching ORDERED_PROVIDERS' order.
      "grok",
      "codex",
    ]);
    const result = orderProvidersByEnablement((id) => enabledIds.has(id));

    const enabledGroup = ORDERED_PROVIDERS.filter((p) =>
      enabledIds.has(p.providerId),
    ).map((p) => p.providerId);
    const disabledGroup = ORDERED_PROVIDERS.filter(
      (p) => !enabledIds.has(p.providerId),
    ).map((p) => p.providerId);

    expect(result.map((p) => p.providerId)).toEqual([
      ...enabledGroup,
      ...disabledGroup,
    ]);
    // `result[0]` proves nothing on its own - codex is already index 0 of
    // ORDERED_PROVIDERS, so it leads whether or not the partition ran. `grok`
    // is the real evidence: it sits at index 9 and only reaches position 1 if
    // the partition - not the original order - decided position.
    expect(result[0]?.providerId).toBe("codex");
    expect(result[1]?.providerId).toBe("grok");
  });

  it("is a reorder, not a filter - every provider stays present under any enablement", () => {
    const result = orderProvidersByEnablement((id) => id === "hermes");
    expect(result).toHaveLength(ALL_PROVIDER_IDS.length);
    expect(new Set(result.map((p) => p.providerId))).toEqual(
      new Set(ALL_PROVIDER_IDS),
    );
  });

  it("is stable for equal input - two calls with the same predicate produce the same list", () => {
    const isEnabled = (id: ProviderId): boolean =>
      id === "claude-code" || id === "kiro";
    const first = orderProvidersByEnablement(isEnabled);
    const second = orderProvidersByEnablement(isEnabled);
    expect(second).toEqual(first);
  });

  it("with nothing enabled, the whole list is the disabled group in ORDERED_PROVIDERS order", () => {
    const result = orderProvidersByEnablement(() => false);
    expect(result).toEqual(ORDERED_PROVIDERS);
  });

  it("with everything enabled, the whole list is the enabled group in ORDERED_PROVIDERS order", () => {
    const result = orderProvidersByEnablement(() => true);
    expect(result).toEqual(ORDERED_PROVIDERS);
  });
});
