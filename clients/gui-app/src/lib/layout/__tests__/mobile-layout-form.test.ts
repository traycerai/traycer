import { describe, expect, it } from "vitest";
import {
  resolveMobileLayoutForm,
  type MobileLayoutForm,
  type MobileStripPreference,
  type MobileTileCount,
} from "@/lib/layout/mobile-layout-form";

const PHONE_PORTRAIT: MobileLayoutForm = {
  level1: "drawer",
  level2: "bar",
  tiles: 1,
};

function resolve(
  contentWidth: number,
  stripPreference: MobileStripPreference,
  openTiles: MobileTileCount,
): MobileLayoutForm {
  return resolveMobileLayoutForm({
    contentWidth,
    phonePortrait: false,
    stripPreference,
    openTiles,
  });
}

describe("resolveMobileLayoutForm", () => {
  // The device matrix, one row per device and orientation in its order, by
  // content width. The strip is at its default, expanded.
  it.each<[string, number, boolean, MobileLayoutForm]>([
    ["402 portrait", 402, true, PHONE_PORTRAIT],
    [
      "750 landscape",
      750,
      false,
      { level1: "rail", level2: { column: 256 }, tiles: 1 },
    ],
    ["440 portrait", 440, true, PHONE_PORTRAIT],
    [
      "832 landscape",
      832,
      false,
      { level1: "rail", level2: { column: 256 }, tiles: 1 },
    ],
    ["382 portrait", 382, true, PHONE_PORTRAIT],
    ["594 landscape", 594, false, { level1: "rail", level2: "menu", tiles: 1 }],
    [
      "669 portrait",
      669,
      false,
      { level1: "rail", level2: { column: 220 }, tiles: 1 },
    ],
    [
      "867 landscape",
      867,
      false,
      { level1: "rail", level2: { column: 256 }, tiles: 1 },
    ],
    [
      "744 portrait",
      744,
      false,
      { level1: "rail", level2: { column: 256 }, tiles: 1 },
    ],
    [
      "1133 landscape",
      1133,
      false,
      { level1: "expanded", level2: { column: 256 }, tiles: 1 },
    ],
    [
      "834 portrait",
      834,
      false,
      { level1: "rail", level2: { column: 256 }, tiles: 1 },
    ],
    [
      "1210 landscape",
      1210,
      false,
      { level1: "expanded", level2: { column: 256 }, tiles: 1 },
    ],
  ])(
    "answers the matrix cell at %s",
    (_, contentWidth, phonePortrait, form) => {
      expect(
        resolveMobileLayoutForm({
          contentWidth,
          phonePortrait,
          stripPreference: "expanded",
          openTiles: 1,
        }),
      ).toEqual(form);
    },
  );

  it.each<[number, MobileLayoutForm]>([
    [832, { level1: "rail", level2: "menu", tiles: 2 }],
    [867, { level1: "rail", level2: "menu", tiles: 2 }],
    [1210, { level1: "expanded", level2: "menu", tiles: 2 }],
  ])(
    "folds the column for the two tiles of the matrix at %i",
    (width, form) => {
      expect(resolve(width, "expanded", 2)).toEqual(form);
    },
  );

  it("folds the column at the two-tile threshold only while two show", () => {
    expect(resolve(828, "expanded", 2)).toEqual({
      level1: "rail",
      level2: "menu",
      tiles: 2,
    });
    expect(resolve(828, "expanded", 1)).toEqual({
      level1: "rail",
      level2: { column: 256 },
      tiles: 1,
    });
  });

  // No matrix cell sits on a threshold, so each is held on both of its sides.
  it.each<[number, MobileLayoutForm]>([
    [443, PHONE_PORTRAIT],
    [444, { level1: "rail", level2: "menu", tiles: 1 }],
    [663, { level1: "rail", level2: "menu", tiles: 1 }],
    [664, { level1: "rail", level2: { column: 220 }, tiles: 1 }],
    [699, { level1: "rail", level2: { column: 220 }, tiles: 1 }],
    [700, { level1: "rail", level2: { column: 256 }, tiles: 1 }],
    [879, { level1: "rail", level2: { column: 256 }, tiles: 1 }],
    [880, { level1: "expanded", level2: { column: 256 }, tiles: 1 }],
  ])("answers a landscape viewport at the threshold %i", (width, form) => {
    expect(resolve(width, "expanded", 1)).toEqual(form);
  });

  it("gives phone portrait the bar at a width that would otherwise earn the rail", () => {
    expect(
      resolveMobileLayoutForm({
        contentWidth: 466,
        phonePortrait: true,
        stripPreference: "expanded",
        openTiles: 2,
      }),
    ).toEqual(PHONE_PORTRAIT);
  });

  it("keeps one tile while two would not fit, whatever is open", () => {
    expect(resolve(827, "expanded", 2)).toEqual({
      level1: "rail",
      level2: { column: 256 },
      tiles: 1,
    });
  });

  it("fits the second tile beside the strip that draws, not beside the rail", () => {
    expect(resolve(1007, "expanded", 2)).toEqual({
      level1: "expanded",
      level2: { column: 256 },
      tiles: 1,
    });
    expect(resolve(1008, "expanded", 2)).toEqual({
      level1: "expanded",
      level2: "menu",
      tiles: 2,
    });
    expect(resolve(1007, "rail", 2)).toEqual({
      level1: "rail",
      level2: "menu",
      tiles: 2,
    });
  });

  it("keeps the rail past the expanded strip's threshold when the person chose it", () => {
    expect(resolve(1210, "rail", 1)).toEqual({
      level1: "rail",
      level2: { column: 256 },
      tiles: 1,
    });
  });
});
