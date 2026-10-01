import { describe, expect, it } from "vitest";
import {
  regionStateWord,
  regionWhere,
} from "@/components/layout-editor/regions/region-facts";
import {
  BAR_HOST_OPTIONS,
  edgeSideOptions,
} from "@/components/layout-editor/regions/region-grammar";
import {
  DEFAULT_ARRANGEMENT,
  type BarHost,
  type EdgeSide,
  type LayoutArrangement,
  type TabStripPlacement,
} from "@/lib/layout/layout-arrangement";
import { effectiveLayoutValues } from "@/lib/layout/layout-presets";

/**
 * The words that say where a region is, in every tab strip placement. While
 * the tabs are a vertical strip there is no header, and in every placement
 * the place is called the tab strip, never "Header" or "Top bar".
 */

function arrangementWith(
  placement: TabStripPlacement,
  usageHost: BarHost,
  usageSide: EdgeSide,
): LayoutArrangement {
  return {
    ...DEFAULT_ARRANGEMENT,
    tabStripPlacement: placement,
    usageHost,
    usageSide,
    resourceHost: usageHost,
    resourceSide: usageSide,
  };
}

function labels(
  options: ReadonlyArray<{ readonly label: string }>,
): ReadonlyArray<string> {
  return options.map((option) => option.label);
}

describe("regionWhere at the top", () => {
  it("names the tab strip for Home and for a header-hosted reading", () => {
    const header = arrangementWith("top", "header", "left");
    expect(regionWhere("homeTab", header)).toBe("Tab strip - left of the tabs");
    expect(regionWhere("usageLimits", header)).toBe("Tab strip - left side");
    expect(
      regionWhere("resourceMonitor", arrangementWith("top", "header", "right")),
    ).toBe("Tab strip - right side");
    expect(
      regionWhere("usageLimits", arrangementWith("top", "status-bar", "right")),
    ).toBe("Status bar - right side");
  });
});

describe.each<TabStripPlacement>(["left", "right"])(
  "regionWhere with the tabs at the %s",
  (placement) => {
    it("puts Home above the tabs", () => {
      expect(
        regionWhere("homeTab", arrangementWith(placement, "header", "left")),
      ).toBe("Tab strip - above the tabs");
    });

    it("puts a header-hosted reading in the strip's foot, start or end", () => {
      expect(
        regionWhere(
          "usageLimits",
          arrangementWith(placement, "header", "left"),
        ),
      ).toBe("Tab strip foot - start");
      expect(
        regionWhere(
          "resourceMonitor",
          arrangementWith(placement, "header", "right"),
        ),
      ).toBe("Tab strip foot - end");
    });

    it("keeps a status-bar reading's wording", () => {
      expect(
        regionWhere(
          "usageLimits",
          arrangementWith(placement, "status-bar", "left"),
        ),
      ).toBe("Status bar - left side");
    });

    it("keeps every other region's static wording", () => {
      const arrangement = arrangementWith(placement, "header", "left");
      expect(regionWhere("minimap", arrangement)).toBe(
        regionWhere("minimap", DEFAULT_ARRANGEMENT),
      );
    });
  },
);

describe("BAR_HOST_OPTIONS", () => {
  it("names the tab strip, keeping the stored values", () => {
    expect(labels(BAR_HOST_OPTIONS)).toEqual(["Status bar", "Tab strip"]);
    expect(BAR_HOST_OPTIONS.map((option) => option.value)).toEqual([
      "status-bar",
      "header",
    ]);
  });
});

describe("edgeSideOptions", () => {
  it("says Start / End for the header host while vertical", () => {
    expect(labels(edgeSideOptions("header", "left"))).toEqual(["Start", "End"]);
    expect(labels(edgeSideOptions("header", "right"))).toEqual([
      "Start",
      "End",
    ]);
  });

  it("says Left / Right everywhere else", () => {
    expect(labels(edgeSideOptions("header", "top"))).toEqual(["Left", "Right"]);
    for (const placement of ["top", "left", "right"] as const) {
      expect(labels(edgeSideOptions("status-bar", placement))).toEqual([
        "Left",
        "Right",
      ]);
    }
  });

  it("keeps the stored values whatever the labels say", () => {
    expect(
      edgeSideOptions("header", "left").map((option) => option.value),
    ).toEqual(["left", "right"]);
  });
});

describe("the index state word of a bar reading", () => {
  const values = effectiveLayoutValues("default", {});

  it.each<TabStripPlacement>(["left", "right"])(
    "names the tab strip, start or end, with the tabs at the %s",
    (placement) => {
      expect(
        regionStateWord(
          "usageLimits",
          values,
          arrangementWith(placement, "header", "left"),
        ),
      ).toBe("Tab strip, start");
      expect(
        regionStateWord(
          "resourceMonitor",
          values,
          arrangementWith(placement, "header", "right"),
        ),
      ).toBe("Tab strip, end");
    },
  );

  it("keeps a status-bar reading's words in every placement", () => {
    for (const placement of ["top", "left", "right"] as const) {
      expect(
        regionStateWord(
          "usageLimits",
          values,
          arrangementWith(placement, "status-bar", "right"),
        ),
      ).toBe("Status bar, right");
    }
  });
});
