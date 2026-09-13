/**
 * Which READING of the office the camera is currently asking for.
 *
 * Semantic zoom changes what the floor is made of, not just how big it is:
 * below 0.7x every agent is a pip on a block map, and from 1.6x every desk
 * carries its detail. Those are real changes, and a person who zooms out and
 * finds the pixel art gone needs to be told that is the band they are in
 * rather than that the office broke.
 *
 * A label and nothing else: the bands are decided by the camera, and the
 * controls for moving the camera are the two buttons under this chip.
 */
import { cn } from "@/lib/utils";
import type { OfficeLod } from "@/lib/comm-graph/office/office-types";

const LOD_LABELS: Readonly<Record<OfficeLod, string>> = {
  0: "Overview",
  1: "Office",
  2: "Close-up",
};

export interface OfficeLodChipProps {
  readonly lod: OfficeLod;
}

export function OfficeLodChip(props: OfficeLodChipProps) {
  return (
    <div
      data-testid="comm-graph-office-lod-chip"
      className={cn(
        // Read-only, like the cursor chip: it must not take the pan or the
        // click a person aims at the floor underneath it.
        "pointer-events-none",
        "rounded-md border border-border bg-popover px-1.5 py-0.5",
        "text-ui-xs text-muted-foreground shadow-xs",
      )}
    >
      {LOD_LABELS[props.lod]}
    </div>
  );
}
