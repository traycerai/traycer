import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import { isVoiceInputRowAvailable } from "@/lib/settings/settings-availability";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useId, type ReactNode } from "react";
import { SegmentedControl } from "@/components/layout-editor/inspector/segmented-control";
import { readControlValue } from "@/components/layout-editor/inspector/region-control-io";
import {
  regionShownOnValue,
  setRegionShown,
} from "@/components/layout-editor/layout-gestures";
import { regionFacts } from "@/components/layout-editor/regions/region-facts";
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
import { isAutoRailRegionId, RAIL_REGION_IDS } from "@/lib/layout/rail";
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
  if (regionId === "mic") return <MicrophoneDisplayControl values={values} />;
  if (regionId === "access" && narrow) return null;
  const ariaLabel = `${facts.name} display`;

  // A phone has no rail: a panel switched off there moves into the tab
  // switcher's More menu rather than disappearing, so the off state says so.
  const inMore = narrow && RAIL_REGION_IDS.some((id) => id === regionId);

  if (isAutoRailRegionId(regionId)) {
    return (
      <SegmentedControl
        ariaLabel={ariaLabel}
        value={String(readControlValue(regionValues, "shown"))}
        options={
          inMore
            ? inMoreOptions(AUTO_SHOWN_HIDDEN_OPTIONS)
            : AUTO_SHOWN_HIDDEN_OPTIONS
        }
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
  if (!regionHides(regionId)) return null;
  return (
    <SegmentedControl
      ariaLabel={ariaLabel}
      value={hidden ? "hidden" : "shown"}
      options={
        inMore ? inMoreOptions(SHOWN_HIDDEN_OPTIONS) : SHOWN_HIDDEN_OPTIONS
      }
      onChange={(next) => {
        setRegionShown(regionId, next === "shown");
      }}
    />
  );
}

/** A rail panel's options on a phone, where `hidden` means "in More". */
function inMoreOptions(
  options: ReadonlyArray<SegmentOption>,
): ReadonlyArray<SegmentOption> {
  return options.map((option) =>
    option.value === "hidden" ? { ...option, label: "In More" } : option,
  );
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

function MicrophoneDisplayControl(props: {
  readonly values: LayoutValues;
}): ReactNode {
  const availability = useSettingsAvailabilityContext();
  const enabled = useSettingsStore((state) => state.voiceInputEnabled);
  const reasonId = useId();
  if (!isVoiceInputRowAvailable(availability)) return null;
  const shown = props.values.mic.shown !== "hidden";
  return (
    <div className="flex min-w-0 flex-col items-end gap-1.5">
      <SegmentedControl
        ariaLabel="Microphone display"
        value={shown ? "shown" : "hidden"}
        options={SHOWN_HIDDEN_OPTIONS.map((option) => ({
          ...option,
          disabled: !enabled,
          describedBy: enabled ? undefined : reasonId,
        }))}
        onChange={(next) => {
          setRegionShown("mic", next === "shown");
        }}
      />
      {!enabled ? (
        <p
          id={reasonId}
          // `w-0 min-w-full`: as wide as the control above and no wider, so
          // the reason wraps under it instead of widening the control column.
          className="w-0 min-w-full text-ui-xs text-pretty text-muted-foreground"
        >
          Enable Voice input in General settings to show the microphone.
        </p>
      ) : null}
    </div>
  );
}
