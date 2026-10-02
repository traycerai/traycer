import { describe, expect, it } from "vitest";
import {
  densityDescription,
  locationDescription,
} from "@/components/layout-editor/regions/reading-placement";
import {
  DEFAULT_ARRANGEMENT,
  type LayoutArrangement,
} from "@/lib/layout/layout-arrangement";

// Where a reading moves, what Compact hides and what the usage Density row says
// are held through the real form in usage-resources-form.test.tsx and
// surface-section-rows.test.tsx; what is left here has no row to read it from.

describe("the sentences that name the spot", () => {
  it("says the monitor shows CPU alone where Auto is compact", () => {
    expect(densityDescription("resourceMonitor", "side-strip", "left")).toBe(
      "Auto is compact in a side strip, showing CPU only.",
    );
  });

  it("says how two readings in the tab strip share it", () => {
    const both: LayoutArrangement = {
      ...DEFAULT_ARRANGEMENT,
      usageHost: "header",
      resourceHost: "header",
      tabStripPlacement: "top",
    };
    expect(locationDescription("usageLimits", both)).toBe(
      "Sits before History, beside Resource monitor.",
    );
    expect(
      locationDescription("resourceMonitor", {
        ...both,
        tabStripPlacement: "right",
      }),
    ).toBe("Sits above the account, beside Usage limits.");
    expect(
      locationDescription("usageLimits", {
        ...both,
        resourceHost: "status-bar",
      }),
    ).toBe("Sits before History.");
  });
});
