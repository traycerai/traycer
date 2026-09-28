/**
 * What a rail slot LOOKS like, in one place because two surfaces draw it: the
 * epic rail itself, and the strip on Layout ▸ Sidebar that previews it. The
 * strip has to read as the rail - same tile size, same tab underline - and a
 * hand-copied class list drifts the first time either one is tuned.
 *
 * Classes rather than a shared component: the two tiles differ in everything
 * BUT their look. The rail's is a real button that activates a panel, carries a
 * tooltip and reports the panel under a right-click; the strip's is an inert
 * drag handle inside an `aria-hidden` preview.
 */

/** One rail slot: the room a panel icon takes, and its resting colour. */
export const LEFT_PANEL_RAIL_TILE_CLASS =
  "relative size-9 rounded-md text-muted-foreground hover:text-foreground";

/**
 * The icon a drop will stack the dragged panel INTO. The ring is drawn
 * outside the tile, because the dragged tile is centred on the pointer and
 * covers the target it is aimed at; a fill alone was painted underneath it.
 * Two pixels, flush: the horizontal rail is `h-10` around a `size-9` tile and
 * clips anything further out.
 */
export const LEFT_PANEL_RAIL_COMBINE_TARGET_CLASS =
  "bg-primary/10 text-foreground ring-2 ring-primary";

/**
 * The same place, for a drop that would be refused: one that would take a
 * stack past `MAX_RAIL_STACK_MEMBERS` (L-181). Drawn rather than left silent, so the user
 * sees why releasing there will do nothing.
 */
export const LEFT_PANEL_RAIL_REFUSED_TARGET_CLASS =
  "bg-destructive/10 ring-2 ring-destructive";

/** The underline a horizontal rail draws under the panel it is showing. */
export const LEFT_PANEL_RAIL_TAB_UNDERLINE_CLASS =
  "absolute inset-x-2 bottom-0 rounded-b-none rounded-t";

/**
 * A stack's name (G3, L-181): every member's title, in order, the way the
 * stack icon's tooltip and accessible name read it.
 */
export function railGroupLabel(titles: ReadonlyArray<string>): string {
  return titles.join(" · ");
}
