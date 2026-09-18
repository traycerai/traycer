import {
  flip,
  offset,
  shift,
  size,
  type Middleware,
  type Padding,
} from "@floating-ui/dom";

import { readNativeKeyboardInsetPx } from "@/lib/native-keyboard";
import { readSafeAreaInsets } from "@/lib/safe-area-insets";

const MENU_CARET_GAP_PX = 6;
const MENU_VIEWPORT_PADDING_PX = 8;

// Open-time preference only: how much room a side needs before it is worth
// opening into. The rendered menu routinely exceeds this - a full roster of
// files or terminals grows the list to its `max-h` viewport cap - and that is
// fine, because `flip()` re-picks the side once the real height is known and
// `shift()` clamps the menu inside the usable viewport on both axes. Nothing
// here bounds the menu.
const MENU_HEIGHT_ESTIMATE = 280;

export type ComposerMenuPlacement = "bottom-start" | "top-start";

/**
 * Strips at the top and bottom of the viewport that are on screen but not
 * the menu's to use: the device's top safe-area inset (status bar, sensor
 * housing) and the software keyboard covering the bottom. Both are 0 wherever
 * nothing covers the viewport - desktop, the browser, and shells whose OS
 * resizes the page for the keyboard.
 */
export interface ComposerMenuReservedEdges {
  readonly topPx: number;
  readonly bottomPx: number;
}

/**
 * The edges as they stand right now. Read on every positioning pass: the
 * keyboard moves them while a menu is open, and `subscribeNativeKeyboardState`
 * is the signal that it has.
 */
export function readComposerMenuReservedEdges(): ComposerMenuReservedEdges {
  return {
    topPx: readSafeAreaInsets().top,
    bottomPx: readNativeKeyboardInsetPx(),
  };
}

/**
 * The padding the composer's floating surfaces keep from the viewport: a small
 * gutter on every side, plus the reserved edges above and below.
 */
export function composerMenuViewportPadding(
  reserved: ComposerMenuReservedEdges,
): Padding {
  return {
    top: MENU_VIEWPORT_PADDING_PX + reserved.topPx,
    bottom: MENU_VIEWPORT_PADDING_PX + reserved.bottomPx,
    left: MENU_VIEWPORT_PADDING_PX,
    right: MENU_VIEWPORT_PADDING_PX,
  };
}

/**
 * Positioning for the composer's picker menu, opened at `bottom-start` or
 * `top-start` of the caret. The area it may use is the viewport less the
 * padding and the `reserved` edges, so the menu never occupies the strip the
 * software keyboard covers.
 *
 * - `flip()` picks the side of the caret with room for the menu, and within
 *   that side the start/end alignment that overflows least.
 * - `shift()` then clamps the menu inside that area on BOTH axes.
 *   Horizontally, that is what keeps a menu opened at a caret near either
 *   edge fully on screen; the menu's width is capped at 90% of the viewport's,
 *   so on any real screen the clamp has room. Vertically, a menu taller than
 *   the room on either side of the caret is slid back into the area, over the
 *   caret line if need be, rather than left with its header or rows out of
 *   reach.
 * - `size()` caps the menu's height at the area's height, so a menu taller
 *   than the whole area - a long list above an open keyboard - scrolls its
 *   list instead of running past either edge.
 */
export function composerMenuMiddleware(
  reserved: ComposerMenuReservedEdges,
): Array<Middleware> {
  const padding = composerMenuViewportPadding(reserved);
  return [
    offset(MENU_CARET_GAP_PX),
    flip({ padding }),
    shift({ mainAxis: true, crossAxis: true, padding }),
    size({
      padding,
      apply: ({ availableHeight, elements }) => {
        elements.floating.style.maxHeight = `${Math.max(0, Math.floor(availableHeight))}px`;
      },
    }),
  ];
}

/**
 * The side of the caret the menu opens on, judged against the same usable
 * area `composerMenuMiddleware` positions it in. No rect yet falls back to
 * below; the menu repositions once the rect becomes available.
 */
export function initialComposerMenuPlacement(
  caret: DOMRect | null,
  viewportHeight: number,
  reserved: ComposerMenuReservedEdges,
): ComposerMenuPlacement {
  if (caret === null) return "bottom-start";
  const spaceBelow = viewportHeight - reserved.bottomPx - caret.bottom;
  const spaceAbove = caret.top - reserved.topPx;
  if (spaceBelow >= MENU_HEIGHT_ESTIMATE) return "bottom-start";
  if (spaceAbove >= MENU_HEIGHT_ESTIMATE) return "top-start";
  return spaceBelow >= spaceAbove ? "bottom-start" : "top-start";
}
