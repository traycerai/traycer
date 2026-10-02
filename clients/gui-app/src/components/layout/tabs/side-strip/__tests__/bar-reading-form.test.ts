import { describe, expect, it } from "vitest";
import {
  barReadingForm,
  type BarReadingForm,
  type StripReadingPlacement,
} from "@/components/layout/tabs/side-strip/side-strip-tokens";
import type { ReadingDensity } from "@/lib/layout/reading-density";

describe("barReadingForm", () => {
  it.each<[StripReadingPlacement, ReadingDensity, BarReadingForm]>([
    ["top-strip", "auto", "strip"],
    ["top-strip", "compact", "strip"],
    ["top-strip", "detailed", "inline"],
    ["side-strip", "auto", "readout"],
    ["side-strip", "compact", "readout"],
    ["side-strip", "detailed", "rows"],
    // A rail has no room for rows, whatever was chosen.
    ["side-strip-collapsed", "auto", "tile"],
    ["side-strip-collapsed", "detailed", "tile"],
  ])("%s with %s density draws the %s form", (placement, density, form) => {
    expect(barReadingForm(placement, density)).toBe(form);
  });
});
