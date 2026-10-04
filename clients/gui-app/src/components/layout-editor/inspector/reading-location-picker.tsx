import type { ReactNode } from "react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import {
  READING_SPOT_LABELS,
  READING_SPOTS,
  readingSpot,
  withReadingSpot,
  type ReadingSpot,
} from "@/components/layout-editor/regions/reading-placement";
import { regionFacts } from "@/components/layout-editor/regions/region-facts";
import { writeArrangement } from "@/lib/layout/arrangement-gestures";
import {
  barPlacement,
  type BarRegionId,
  type LayoutArrangement,
  type TabStripPlacement,
} from "@/lib/layout/layout-arrangement";
import { cn } from "@/lib/utils";

/**
 * Where one reading lives: a small window with three spots, each one a radio.
 *
 * The window is drawn the way the app is - tab strip across the top, or down
 * the left or right edge when the tabs are there - so the spot a reader
 * presses is the spot it ends up in. The tab strip has no side, so the picker
 * writes only the host for it and the host with an end for a status-bar spot.
 */
export function ReadingLocationPicker(props: {
  readonly regionId: BarRegionId;
  readonly arrangement: LayoutArrangement;
}): ReactNode {
  const { regionId, arrangement } = props;
  const spot = readingSpot(barPlacement(arrangement, regionId));
  const strip = arrangement.tabStripPlacement;
  const grid = WINDOW_GRID[strip];
  return (
    <div className="flex flex-col items-end gap-1.5">
      <RadioGroupPrimitive.Root
        aria-label={`${regionFacts(regionId).name} location`}
        value={spot}
        onValueChange={(next) => {
          const picked = spotOf(next);
          if (picked === null) return;
          writeArrangement(withReadingSpot(arrangement, regionId, picked));
        }}
        data-reading-location-window={strip}
        className={cn(
          "grid h-[4.5rem] w-32 gap-0.5 rounded-md border border-border bg-card p-0.5",
          grid.window,
        )}
      >
        {READING_SPOTS.map((value) => (
          <RadioGroupPrimitive.Item
            key={value}
            value={value}
            aria-label={READING_SPOT_LABELS[value]}
            data-spot={value}
            className={cn(
              "rounded-sm bg-foreground/10 outline-none transition-colors hover:bg-foreground/20 focus-visible:ring-2 focus-visible:ring-ring",
              "data-[state=checked]:bg-primary data-[state=checked]:hover:bg-primary",
              grid.spots[value],
            )}
          />
        ))}
        <span
          aria-hidden
          className={cn(
            "rounded-sm border border-dashed border-border/60",
            grid.spots.body,
          )}
        />
      </RadioGroupPrimitive.Root>
      <span className="text-ui-xs text-muted-foreground">
        {READING_SPOT_LABELS[spot]}
      </span>
    </div>
  );
}

/** The one place a radio's string value is read back as a spot. */
function spotOf(value: string): ReadingSpot | null {
  switch (value) {
    case "tab-strip":
    case "status-bar-left":
    case "status-bar-right":
      return value;
    default:
      return null;
  }
}

/**
 * The window's grid, as classes: the strip across the top, or down one edge.
 * Written out whole, never composed, so every class is one the build can see.
 */
const WINDOW_GRID: Readonly<
  Record<
    TabStripPlacement,
    {
      readonly window: string;
      readonly spots: Readonly<Record<ReadingSpot | "body", string>>;
    }
  >
> = {
  top: {
    window: "grid-cols-2 grid-rows-[0.75rem_1fr_0.75rem]",
    spots: {
      "tab-strip": "col-span-2 row-start-1",
      body: "col-span-2 row-start-2",
      "status-bar-left": "col-start-1 row-start-3",
      "status-bar-right": "col-start-2 row-start-3",
    },
  },
  left: {
    window: "grid-cols-[0.75rem_1fr_1fr] grid-rows-[1fr_0.75rem]",
    spots: {
      "tab-strip": "col-start-1 row-span-2 row-start-1",
      body: "col-span-2 col-start-2 row-start-1",
      "status-bar-left": "col-start-2 row-start-2",
      "status-bar-right": "col-start-3 row-start-2",
    },
  },
  right: {
    window: "grid-cols-[1fr_1fr_0.75rem] grid-rows-[1fr_0.75rem]",
    spots: {
      "tab-strip": "col-start-3 row-span-2 row-start-1",
      body: "col-span-2 col-start-1 row-start-1",
      "status-bar-left": "col-start-1 row-start-2",
      "status-bar-right": "col-start-2 row-start-2",
    },
  },
};
