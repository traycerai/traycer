/**
 * The two attribute NAMES a canvas drag reads off the app's own elements.
 *
 * A leaf with no imports, deliberately (R3-05). The surfaces that stamp these
 * are app surfaces, not editor ones - the epic sidebar's icon rail mounts on
 * every epic - and reading a string from `region-drag.ts` pulled the drag
 * engine, the gesture writer and `layout-arrangement.ts` into their module
 * graphs to get it. `customize-layout-menu-item.tsx` already carries that
 * ruling for the menu; this is the same ruling for the markers.
 *
 * `region-drag.ts` re-exports both, so the editor's own callers are unchanged.
 */

/**
 * The box a surface lays one cluster of draggable members out in: the dock's
 * rows card, the composer's compact chip strip, each composer toolbar cluster,
 * the sidebar's icon column.
 *
 * Stamped by the surface because only it knows which of its elements is that
 * box - see `resolveGroup` in `region-drag.ts`, which is the one reader.
 */
export const LAYOUT_CLUSTER_ATTRIBUTE = "data-layout-cluster";

/**
 * A member's own id, where it is not a region's.
 *
 * Every member of a canvas order group but one IS a region, and carries its id
 * in `data-layout-region`. The exception is the rail's dividers (L-115,
 * L-155): they are entries in `arrangement.rail` that the rail draws and a drop
 * places by, and nothing else about them is a region - no name, no value bag,
 * no row in the index - so they carry their entry id here instead of a region
 * id `LAYOUT_REGION_IDS` would have to invent.
 */
export const LAYOUT_MEMBER_ATTRIBUTE = "data-layout-member";
