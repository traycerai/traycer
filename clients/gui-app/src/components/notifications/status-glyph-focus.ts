import { createContext, useContext, useState } from "react";

/**
 * `true` while the activation control of the row containing a status glyph
 * has KEYBOARD focus. A status glyph's sentence is tooltip-only, and its
 * trigger is not a tab stop on purpose (a row is one target, not one per
 * mark), so a keyboard user reaches the row and sees the glyph unexplained:
 * `aria-describedby` reads it to a screen reader and opens nothing. A row
 * that knows its target is keyboard-focused provides `true` here, and every
 * glyph under it holds its tooltip open for as long as that lasts.
 *
 * Keyboard, not any focus: a pointer click also parks focus on the row
 * target, and a tooltip that opened on every click would be noise.
 * Default `false` - a glyph outside such a row behaves as it always has.
 */
export const StatusGlyphFocusContext = createContext(false);

export interface StatusGlyphTooltipOpen {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * The controlled open state for a status glyph's tooltip: the hover state
 * Radix drives through `onOpenChange`, OR'd with the containing row's
 * keyboard focus. Always controlled, so the tooltip never switches between
 * Radix's controlled and uncontrolled modes as focus comes and goes.
 */
export function useStatusGlyphTooltipOpen(): StatusGlyphTooltipOpen {
  const rowKeyboardFocused = useContext(StatusGlyphFocusContext);
  const [hoverOpen, setHoverOpen] = useState(false);
  return {
    open: rowKeyboardFocused || hoverOpen,
    onOpenChange: setHoverOpen,
  };
}
