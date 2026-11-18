/**
 * Putting focus on a list row from OUTSIDE the list.
 *
 * The Settings page's search landing does it, landing on the row the result
 * named (5.9), and it has two facts to know that belong to the list.
 *
 * The facts, both `sortable-list.tsx`'s (L-114): the row's identity is on the
 * CARD (`data-sortable-id`), and what a keyboard operates is the GRAB inside
 * it - the `role="button"` that holds the grip, the glyph and the name, and
 * deliberately none of the row's controls. So "focus the row" means the grab
 * and nothing else: focusing the card would focus nothing at all, since the
 * card is a plain box with no tab stop.
 */

/** The row's own tab stop, inside the card that carries its id. */
const ROW_GRAB_SELECTOR = "[data-row-grab]";

/**
 * Focus one row, given the card `layoutRegionRowSelector` found.
 *
 * Silent when the row is not there or has no grab: every caller is reacting to
 * something the user did elsewhere - a key in a field, a search result - and
 * neither has anything to say about a row that has since been filtered away.
 */
export function focusSortableRowGrab(row: Element | null): void {
  if (row === null) return;
  // A reading's section has no grab of its own: its Show switch is the stop.
  const grab = row.matches("[data-region-section]")
    ? row.querySelector<HTMLElement>("[data-region-show]")
    : row.querySelector<HTMLElement>(ROW_GRAB_SELECTOR);
  grab?.focus();
}
