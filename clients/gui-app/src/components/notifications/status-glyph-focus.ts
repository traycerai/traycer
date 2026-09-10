import { createContext, useCallback, useContext, useState } from "react";

/**
 * The keyboard-focus SESSION of the row containing a status glyph, or `null`
 * while its activation control does not have keyboard focus. A status glyph's
 * sentence is tooltip-only, and its trigger is not a tab stop on purpose (a
 * row is one target, not one per mark), so a keyboard user reaches the row
 * and sees the glyph unexplained: `aria-describedby` reads it to a screen
 * reader and opens nothing. A row that knows its target is keyboard-focused
 * provides a fresh session id here, and the glyph under it holds its tooltip
 * open for as long as that session lasts.
 *
 * A session id rather than a boolean, because a held-open tooltip must still
 * be dismissable: Radix reports Escape as `onOpenChange(false)`, and the hook
 * remembers that dismissal FOR THE SESSION, so the tooltip stays closed until
 * focus leaves and comes back - which is a new id. A boolean could not tell
 * "still the same focus" from "focused again".
 *
 * Keyboard, not any focus: a pointer click also parks focus on the row
 * target, and a tooltip that opened on every click would be noise.
 * Default `null` - a glyph outside such a row behaves as it always has.
 */
export const StatusGlyphFocusContext = createContext<number | null>(null);

export interface StatusGlyphTooltipOpen {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * The controlled open state for a status glyph's tooltip: the hover state
 * Radix drives through `onOpenChange`, OR'd with the containing row's
 * keyboard-focus hold. Always controlled, so the tooltip never switches
 * between Radix's controlled and uncontrolled modes as focus comes and goes.
 *
 * A close reported while the hold is on (Escape, or the pointer leaving a
 * glyph it had hovered) dismisses the hold for the current focus session.
 */
export function useStatusGlyphTooltipOpen(): StatusGlyphTooltipOpen {
  const focusSession = useContext(StatusGlyphFocusContext);
  const [hoverOpen, setHoverOpen] = useState(false);
  const [dismissedSession, setDismissedSession] = useState<number | null>(null);
  const onOpenChange = useCallback(
    (open: boolean) => {
      setHoverOpen(open);
      if (!open && focusSession !== null) setDismissedSession(focusSession);
    },
    [focusSession],
  );
  const heldOpen = focusSession !== null && focusSession !== dismissedSession;
  return { open: heldOpen || hoverOpen, onOpenChange };
}
