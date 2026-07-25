import { describe, expect, it } from "vitest";
import {
  guiHarnessIdSchema,
  type GuiHarnessId,
} from "@traycer/protocol/host/index";
import {
  guiHarnessIdToProviderId,
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
