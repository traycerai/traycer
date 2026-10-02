import { describe, expect, it } from "vitest";
import {
  compactIgnoredRows,
  densityDescription,
  locationDescription,
  readingSpot,
  withReadingSpot,
} from "@/components/layout-editor/regions/reading-placement";
import {
  readingPlacement,
  resolvedReadingDensity,
} from "@/lib/layout/reading-density";
import {
  DEFAULT_ARRANGEMENT,
  barPlacement,
  type LayoutArrangement,
} from "@/lib/layout/layout-arrangement";

const IN_STATUS_BAR: LayoutArrangement = {
  ...DEFAULT_ARRANGEMENT,
  usageHost: "status-bar",
  usageSide: "left",
  resourceHost: "status-bar",
  resourceSide: "right",
  tabStripPlacement: "top",
};

describe("withReadingSpot", () => {
  it("writes only the host for the tab strip and keeps the old end", () => {
    const next = withReadingSpot(IN_STATUS_BAR, "resourceMonitor", "tab-strip");
    expect(next.resourceHost).toBe("header");
    expect(next.resourceSide).toBe("right");
    expect(next.usageHost).toBe("status-bar");
  });

  it("writes the host and the end for a status bar spot, leaving the other reading alone", () => {
    const inStrip: LayoutArrangement = {
      ...IN_STATUS_BAR,
      usageHost: "header",
    };
    const next = withReadingSpot(inStrip, "usageLimits", "status-bar-right");
    expect(barPlacement(next, "usageLimits")).toEqual({
      host: "status-bar",
      side: "right",
    });
    expect(next.resourceHost).toBe("status-bar");
    expect(next.resourceSide).toBe("right");
  });

  it("reads the spot back from the stored pair", () => {
    expect(readingSpot({ host: "header", side: "right" })).toBe("tab-strip");
    expect(readingSpot({ host: "status-bar", side: "left" })).toBe(
      "status-bar-left",
    );
    expect(readingSpot({ host: "status-bar", side: "right" })).toBe(
      "status-bar-right",
    );
  });
});

describe("the placement a Density resolves at", () => {
  it("is the status bar, the top strip or a side strip", () => {
    expect(readingPlacement(IN_STATUS_BAR, "usageLimits")).toBe("status-bar");
    const inStrip = withReadingSpot(IN_STATUS_BAR, "usageLimits", "tab-strip");
    expect(readingPlacement(inStrip, "usageLimits")).toBe("top-strip");
    expect(
      readingPlacement(
        { ...inStrip, tabStripPlacement: "left" },
        "usageLimits",
      ),
    ).toBe("side-strip");
  });

  it("resolves Auto by where the reading sits and lets a pick win everywhere", () => {
    const inStrip = withReadingSpot(IN_STATUS_BAR, "usageLimits", "tab-strip");
    expect(resolvedReadingDensity("auto", IN_STATUS_BAR, "usageLimits")).toBe(
      "detailed",
    );
    expect(resolvedReadingDensity("auto", inStrip, "usageLimits")).toBe(
      "compact",
    );
    expect(resolvedReadingDensity("detailed", inStrip, "usageLimits")).toBe(
      "detailed",
    );
    expect(
      resolvedReadingDensity("compact", IN_STATUS_BAR, "usageLimits"),
    ).toBe("compact");
  });
});

describe("what a Compact reading ignores", () => {
  it("is Percent shows and Reset time for usage, and Metrics for the monitor", () => {
    expect(compactIgnoredRows("usageLimits")).toEqual(["amount", "reset"]);
    expect(compactIgnoredRows("resourceMonitor")).toEqual(["metrics"]);
  });
});

describe("the sentences that name the spot", () => {
  it("says what Auto is in the status bar, the top strip and a side strip", () => {
    expect(densityDescription("usageLimits", "status-bar", "top")).toMatch(
      /^Auto is detailed in the status bar/,
    );
    expect(densityDescription("usageLimits", "top-strip", "top")).toBe(
      "Auto is compact in the top tab strip.",
    );
    expect(densityDescription("resourceMonitor", "side-strip", "left")).toBe(
      "Auto is compact in a side strip, showing CPU only.",
    );
  });

  it("says how two readings in the tab strip share it", () => {
    const both: LayoutArrangement = {
      ...IN_STATUS_BAR,
      usageHost: "header",
      resourceHost: "header",
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
