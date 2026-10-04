import type { ReactNode } from "react";
import { LayoutFormRow } from "@/components/layout-editor/inspector/rows/layout-form-row";
import { ReadingLocationPicker } from "@/components/layout-editor/inspector/reading-location-picker";
import { RegionSideControl } from "@/components/layout-editor/inspector/region-controls";
import { locationDescription } from "@/components/layout-editor/regions/reading-placement";
import { writeArrangement } from "@/lib/layout/arrangement-gestures";
import {
  positionAxisChanged,
  revertPositionAxis,
} from "@/components/layout-editor/regions/region-position-rows";
import {
  asBarRegionId,
  type LayoutArrangement,
} from "@/lib/layout/layout-arrangement";
import type { LayoutSnapshot } from "@/lib/layout/layout-snapshot";
import type { RegionId } from "@/lib/layout/region-id";

/**
 * Where a region sits, in the two shapes a row's disclosure draws: where a bar
 * reading lives, and which edge of its surface the minimap is anchored to. Its
 * place in a list IS its row's place in that list.
 */

/**
 * Where a bar reading lives: the usage cluster and the resource monitor each
 * answer for themselves, in one picker that writes the bar and, for the status
 * bar, the end of it.
 *
 * Only a bar region has this row, so a region id that is not one draws no
 * control rather than a control writing somewhere else.
 */
export function PositionHostRow(props: {
  readonly regionId: RegionId;
  readonly arrangement: LayoutArrangement;
  readonly snapshot: LayoutSnapshot;
}): ReactNode {
  const { regionId, arrangement, snapshot } = props;
  const barRegion = asBarRegionId(regionId);
  if (barRegion === null) return null;
  return (
    <LayoutFormRow
      anchor={null}
      icon={null}
      label="Location"
      revertLabel="Revert Location"
      stacked={false}
      selected={false}
      description={locationDescription(barRegion, arrangement)}
      onRevert={
        positionAxisChanged(snapshot, regionId, "position-host")
          ? () => {
              writeArrangement(
                revertPositionAxis(arrangement, regionId, "position-host"),
              );
            }
          : null
      }
      control={
        <ReadingLocationPicker regionId={barRegion} arrangement={arrangement} />
      }
    />
  );
}

/** Which edge of the transcript and artifact the minimap sits on (C9). */
export function PositionSideRow(props: {
  readonly regionId: RegionId;
  readonly arrangement: LayoutArrangement;
  readonly snapshot: LayoutSnapshot;
  readonly description: string;
}): ReactNode {
  const { regionId, arrangement, snapshot, description } = props;
  return (
    <LayoutFormRow
      anchor={null}
      icon={null}
      label="Side"
      revertLabel="Revert Side"
      stacked={false}
      selected={false}
      description={description}
      onRevert={
        positionAxisChanged(snapshot, regionId, "position-side")
          ? () => {
              writeArrangement(
                revertPositionAxis(arrangement, regionId, "position-side"),
              );
            }
          : null
      }
      control={
        <RegionSideControl regionId={regionId} arrangement={arrangement} />
      }
    />
  );
}
