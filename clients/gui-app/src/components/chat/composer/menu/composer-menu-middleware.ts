import { flip, offset, shift, type Middleware } from "@floating-ui/dom";

const MENU_CARET_GAP_PX = 6;
const MENU_VIEWPORT_PADDING_PX = 8;

/**
 * Positioning for the composer's picker menu, opened at `bottom-start` or
 * `top-start` of the caret.
 *
 * - `flip()` picks the side of the caret with room for the menu, and within
 *   that side the start/end alignment that overflows least.
 * - `shift()` then clamps the menu inside the viewport on BOTH axes, less the
 *   padding. Horizontally, that is what keeps a menu opened at a caret near
 *   either edge fully on screen; the menu's width is capped at 90% of the
 *   viewport's, so on any real screen the clamp has room. Vertically, a menu
 *   taller than the room on either side of the caret is slid back on screen,
 *   over the caret line if need be, rather than left with its header or rows
 *   out of reach.
 */
export function composerMenuMiddleware(): Array<Middleware> {
  return [
    offset(MENU_CARET_GAP_PX),
    flip({ padding: MENU_VIEWPORT_PADDING_PX }),
    shift({
      mainAxis: true,
      crossAxis: true,
      padding: MENU_VIEWPORT_PADDING_PX,
    }),
  ];
}
