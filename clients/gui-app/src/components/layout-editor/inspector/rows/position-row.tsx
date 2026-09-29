import type { ReactNode } from "react";
import { LayoutFormRow } from "@/components/layout-editor/inspector/rows/layout-form-row";
import {
  BarHostControl,
  RegionSideControl,
} from "@/components/layout-editor/inspector/region-controls";
import {
  SIDE_TAB_ALIGNMENT_HELPER,
  sideTabFootAlignment,
} from "@/components/layout-editor/regions/region-grammar";
import { writeArrangement } from "@/lib/layout/arrangement-gestures";
import {
  positionAxisChanged,
  revertPositionAxis,
} from "@/components/layout-editor/regions/region-position-rows";
import {
  asBarRegionId,
  barPlacement,
  type LayoutArrangement,
} from "@/lib/layout/layout-arrangement";
import type { LayoutSnapshot } from "@/lib/layout/layout-snapshot";
import type { RegionId } from "@/lib/layout/region-id";

/**
 * Where a region sits, in the two shapes a row's disclosure draws: which bar
 * hosts it, and which end of its surface it is anchored to. Its place in a
 * list IS its row's place in that list.
 *
 * A revert belongs to the ROW it sits on, and since L-156 the two bar readings
 * have two of them - a bar and an end of it - so each puts its own axis back
 * and leaves the other alone.
 */

/**
 * Which of the two bars a reading lives in: the usage cluster and the resource
 * monitor, each answering for itself (L-156).
 *
 * Only a bar region has this row, so a region id that is not one draws no
 * control rather than a control writing somewhere else.
 */
export function PositionHostRow(props: {
  readonly regionId: RegionId;
  readonly arrangement: LayoutArrangement;
  readonly snapshot: LayoutSnapshot;
  readonly description: string;
}): ReactNode {
  const { regionId, arrangement, snapshot, description } = props;
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
      description={description}
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
        <BarHostControl regionId={barRegion} arrangement={arrangement} />
      }
    />
  );
}

/**
 * Which end of its surface an edge-anchored region sits at: "Alignment" for a
 * bar reading (the start or end of its reading area), "Side" for the minimap's
 * edge of the transcript (C9). In the side tabs' foot the options read Start
 * and End, and the row says what that means.
 */
export function PositionSideRow(props: {
  readonly regionId: RegionId;
  readonly arrangement: LayoutArrangement;
  readonly snapshot: LayoutSnapshot;
  readonly description: string;
}): ReactNode {
  const { regionId, arrangement, snapshot, description } = props;
  const bar = asBarRegionId(regionId);
  // A bar reading's row is never drawn narrow (`regionRowAvailable`), so a
  // vertical strip's foot is the only other place its ends read differently.
  const footAlignment =
    bar !== null &&
    sideTabFootAlignment(
      barPlacement(arrangement, bar).host,
      arrangement.tabStripPlacement,
    );
  return (
    <LayoutFormRow
      anchor={null}
      icon={null}
      label={bar === null ? "Side" : "Alignment"}
      revertLabel={bar === null ? "Revert Side" : "Revert Alignment"}
      stacked={false}
      selected={false}
      description={footAlignment ? SIDE_TAB_ALIGNMENT_HELPER : description}
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
