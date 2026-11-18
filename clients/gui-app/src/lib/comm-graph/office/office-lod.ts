/**
 * SEMANTIC ZOOM: which of the three readings of the office the camera is asking
 * for.
 *
 * The thresholds live here rather than in the renderer because two unrelated
 * things read them. The camera turns a zoom into a level every frame, and Auto
 * turns a measured fit back into a question - "does this view reach office
 * detail on this tile?" - which is the same number seen from the other side. A
 * second copy of `0.7` in the tile is how those two drift apart.
 *
 * - `0` OVERVIEW, below `OFFICE_LOD_OFFICE_ZOOM`: a character is four pixels,
 *   so the floor is a block map and every agent is one pip with a state glyph.
 * - `1` OFFICE: the floor as it has always looked, with signage and the name
 *   tags that matter.
 * - `2` CLOSE-UP, from `OFFICE_LOD_CLOSEUP_ZOOM`: everything.
 */
import type { OfficeLod } from "@/lib/comm-graph/office/office-types";

/** How many bands there are. A renderer keying a cache by band needs the base. */
export const OFFICE_LOD_COUNT = 3;

/** Below this a floor tile is under twelve screen pixels: no longer a room. */
export const OFFICE_LOD_OFFICE_ZOOM = 0.7;
/** From here a desk is big enough that its details are worth drawing. */
export const OFFICE_LOD_CLOSEUP_ZOOM = 1.6;

export function officeLodForZoom(zoom: number): OfficeLod {
  if (zoom < OFFICE_LOD_OFFICE_ZOOM) return 0;
  if (zoom < OFFICE_LOD_CLOSEUP_ZOOM) return 1;
  return 2;
}
