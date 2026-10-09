import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import type { ReactNode } from "react";
import {
  SegmentedControl,
  type SegmentedControlOption,
} from "@/components/layout-editor/inspector/segmented-control";
import { readControlValue } from "@/components/layout-editor/inspector/region-control-io";
import {
  regionShownOnValue,
  setRegionShown,
} from "@/components/layout-editor/layout-gestures";
import {
  regionFacts,
  regionHasDisplayControl,
} from "@/components/layout-editor/regions/region-facts";
import {
  ACCESS_DISPLAY_OPTIONS,
  AUTO_SHOWN_HIDDEN_OPTIONS,
  DISCLOSURE_HIDDEN_OPTIONS,
  DISCLOSURE_OPTIONS,
  DOCK_DISPLAY_OPTIONS,
  EDGE_SIDE_OPTIONS,
  SHOWN_HIDDEN_OPTIONS,
  type SegmentOption,
} from "@/components/layout-editor/regions/region-grammar";
import { writeArrangement } from "@/lib/layout/arrangement-gestures";
import type { LayoutArrangement } from "@/lib/layout/layout-arrangement";
import { PRESET_VALUES } from "@/lib/layout/layout-presets";
import {
  isAutoRailRegionId,
  isLastShownRailPanel,
  RAIL_REGION_IDS,
  railPanelShownByValue,
} from "@/lib/layout/rail";
import {
  regionValuesHidden,
  type LayoutValues,
} from "@/lib/layout/layout-values";
import type { RegionId } from "@/lib/layout/region-id";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import { useLayoutStore } from "@/stores/layout/layout-store";

/**
 * The bare controls the layout form's settings are operated with, with no row
 * around them.
 *
 * Both hosts draw these same controls; a second copy of one is how two
 * vocabularies for one value get built (D5).
 */

/**
 * A region's ONE display control, the same in both hosts (L-128 overturned).
 *
 * | Region | Options |
 * | --- | --- |
 * | Pull requests, Comments | `Auto` `Shown` `Hidden` (L-47) |
 * | dock row | `Full row` `Chip` `Hidden` |
 * | Access | `Icon and label` `Icon only` (never hidden, G6) |
 * | Thinking | `Open` `Closed` `Hidden` |
 * | Tool activity | `Open` `Closed` (never hidden) |
 * | everything else that hides | `Shown` `Hidden` |
 *
 * `Full row / Chip / Hidden` is not a new value: it is `size` and `shown` read
 * together and written apart. `Hidden` writes `shown` and leaves `size` alone,
 * so a hidden chip comes back as a chip; `Full row` or `Chip` writes both in
 * one gesture, so the round trip is lossless and one undo step.
 */
export function RegionDisplayControl(props: {
  readonly regionId: RegionId;
  readonly values: LayoutValues;
}): ReactNode {
  const { regionId, values } = props;
  const facts = regionFacts(regionId);
  const regionValues = values[regionId];
  const hidden = regionValuesHidden(regionValues);
  const narrow = useIsMobileViewport();
  if (!regionHasDisplayControl(regionId, narrow)) return null;
  const ariaLabel = `${facts.name} display`;

  // A phone has no rail: a panel switched off there moves into the tab
  // switcher's More menu rather than disappearing, so the off state says so.
  const rail = RAIL_REGION_IDS.find((id) => id === regionId) ?? null;
  const inMore = narrow && rail !== null;
  // The last panel the rail draws cannot leave Shown (T3), not even for Auto,
  // which counts as not shown and would let every panel be hidden next. Its
  // row says why, and the rail's own menu refuses the same press by the same
  // rule.
  const lastShown =
    rail !== null &&
    isLastShownRailPanel(rail, (candidate) =>
      railPanelShownByValue(values, candidate),
    );

  if (isAutoRailRegionId(regionId)) {
    return (
      <SegmentedControl
        ariaLabel={ariaLabel}
        value={String(readControlValue(regionValues, "shown"))}
        options={railOptions(AUTO_SHOWN_HIDDEN_OPTIONS, inMore, lastShown)}
        onChange={(next) => {
          writeAutoRailVisibility(regionId, next);
        }}
      />
    );
  }
  if ("size" in PRESET_VALUES.default[regionId]) {
    const hides = regionHides(regionId);
    return (
      <SegmentedControl
        ariaLabel={ariaLabel}
        value={
          hidden ? "hidden" : String(readControlValue(regionValues, "size"))
        }
        options={sizeOptions(regionId, hides)}
        onChange={(next) => {
          if (next === "hidden") {
            setRegionShown(regionId, false);
            return;
          }
          writeSizeShown(regionId, next, hides);
        }}
      />
    );
  }
  return (
    <SegmentedControl
      ariaLabel={ariaLabel}
      value={hidden ? "hidden" : "shown"}
      options={railOptions(SHOWN_HIDDEN_OPTIONS, inMore, lastShown)}
      onChange={(next) => {
        setRegionShown(regionId, next === "shown");
      }}
    />
  );
}

/**
 * A region's Shown options as a rail panel's row offers them: on a phone,
 * where the switcher has no rail, `hidden` means "In More"; on the last panel
 * shown, every option but `shown` is off. Every other region's options pass
 * through.
 */
function railOptions(
  options: ReadonlyArray<SegmentOption>,
  inMore: boolean,
  lastShown: boolean,
): ReadonlyArray<SegmentedControlOption> {
  return options.map((option) => ({
    ...option,
    label: inMore && option.value === "hidden" ? "In More" : option.label,
    disabled: lastShown && option.value !== "shown",
  }));
}

/** The words a sized region's one control uses for its two sizes. */
function sizeOptions(
  regionId: RegionId,
  hides: boolean,
): ReadonlyArray<SegmentOption> {
  if (regionId === "thinking" || regionId === "toolActivity") {
    return hides ? DISCLOSURE_HIDDEN_OPTIONS : DISCLOSURE_OPTIONS;
  }
  return hides ? DOCK_DISPLAY_OPTIONS : ACCESS_DISPLAY_OPTIONS;
}

/**
 * Whether a region can be hidden at all: it has a `shown` leaf. Access and
 * Model do not - each is a floor the composer always draws (G6) - so they get
 * no Hidden option.
 */
function regionHides(regionId: RegionId): boolean {
  return "shown" in PRESET_VALUES.default[regionId];
}

/** Pull requests' and Comments' three-state write. */
function writeAutoRailVisibility(regionId: RegionId, next: string): void {
  if (next !== "auto" && next !== "shown" && next !== "hidden") return;
  useLayoutEditorStore.getState().recordGesture(() => {
    useLayoutStore.getState().setRegionValues(regionId, { shown: next });
  });
}

/**
 * Size and Shown as ONE gesture, which is what makes the merged control one
 * undo step rather than two.
 *
 * `Reflect.set` for the same reason `region-control-io.ts` uses it: `keyof
 * LayoutValues[K]` collapses to the one field all regions share once the
 * region is a plain `RegionId`, and `setRegionValues` parses the merged patch
 * through the same total resolver a rehydrate uses, so a wrong key cannot
 * persist.
 */
function writeSizeShown(
  regionId: RegionId,
  size: string,
  hides: boolean,
): void {
  useLayoutEditorStore.getState().recordGesture(() => {
    const patch: Partial<LayoutValues[RegionId]> = {};
    Reflect.set(patch, "size", size);
    if (hides) Reflect.set(patch, "shown", regionShownOnValue(regionId));
    useLayoutStore.getState().setRegionValues(regionId, patch);
  });
}

/** Which edge of the transcript and artifact the minimap sits on. */
export function RegionSideControl(props: {
  readonly regionId: RegionId;
  readonly arrangement: LayoutArrangement;
}): ReactNode {
  const { regionId, arrangement } = props;
  return (
    <SegmentedControl
      ariaLabel={`${regionFacts(regionId).name} side`}
      options={EDGE_SIDE_OPTIONS}
      value={arrangement.minimapSide}
      onChange={(next) => {
        if (next !== "left" && next !== "right") return;
        writeArrangement({ ...arrangement, minimapSide: next });
      }}
    />
  );
}
