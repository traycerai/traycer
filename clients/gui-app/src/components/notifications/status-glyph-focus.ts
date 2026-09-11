import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

/**
 * A row's keyboard-focus hold over the status glyph inside it. A status
 * glyph's sentence is tooltip-only, and its trigger is not a tab stop on
 * purpose (a row is one target, not one per mark), so a keyboard user reaches
 * the row and sees the glyph unexplained: `aria-describedby` reads it to a
 * screen reader and opens nothing. A row that knows its target is
 * keyboard-focused provides a hold here, and the glyph under it keeps its
 * tooltip open for as long as the hold lasts.
 *
 * A held-open tooltip must still be dismissable: Radix reports Escape as
 * `onOpenChange(false)`, and the glyph answers by calling `dismiss`, after
 * which the hold reads `dismissed` until focus leaves and comes back - a new
 * `session`. The dismissal is recorded in the PROVIDER's state, not the
 * glyph's, on purpose: the glyph under a slot is swapped for another as the
 * task's state moves (a running spinner becomes a completion mark), and a
 * dismissal kept in the glyph would leave with it, so the next glyph would
 * open uninvited in the same focus session. `useStatusGlyphFocusHold` owns
 * that state for the slot.
 *
 * Keyboard, not any focus: a pointer click also parks focus on the row
 * target, and a tooltip that opened on every click would be noise.
 * Default `null` - a glyph outside such a row behaves as it always has.
 */
export interface StatusGlyphFocusHold {
  /** The keyboard-focus session this hold belongs to; a new id per focus. */
  readonly session: number;
  /** Whether this session's hold was dismissed (Escape, or a close reported while held). */
  readonly dismissed: boolean;
  /** Records the dismissal for this session, in state that outlives the glyph. */
  readonly dismiss: () => void;
}

export const StatusGlyphFocusContext =
  createContext<StatusGlyphFocusHold | null>(null);

/**
 * The hold a slot provides for the row's current keyboard-focus session, or
 * `null` while there is none. Owns the dismissal for the session, so a glyph
 * swapped in mid-session inherits it.
 */
export function useStatusGlyphFocusHold(
  session: number | null,
): StatusGlyphFocusHold | null {
  const [dismissedSession, setDismissedSession] = useState<number | null>(null);
  return useMemo(() => {
    if (session === null) return null;
    return {
      session,
      dismissed: dismissedSession === session,
      dismiss: () => setDismissedSession(session),
    };
  }, [session, dismissedSession]);
}

/**
 * The document event Radix's tooltip sends when one of its tooltips opens
 * through its own path (hover, focus on the trigger), and on which every
 * other open tooltip's content closes - `TOOLTIP_OPEN` in
 * `@radix-ui/react-tooltip`, which has no public name for it. A controlled
 * `open` never sends it, so a hold that opens a glyph's tooltip while a
 * hovered one is still up would show both. A row sends this itself, BEFORE
 * it starts a hold, so the hold arrives alone. The name is pinned by the
 * history list's tests: a Radix release that renames it reddens them rather
 * than silently letting two tooltips overlap again.
 */
export const RADIX_TOOLTIP_OPEN_EVENT = "tooltip.open";

/** Closes every Radix tooltip currently open in `ownerDocument`. */
export function closeOpenTooltips(ownerDocument: Document): void {
  ownerDocument.dispatchEvent(new CustomEvent(RADIX_TOOLTIP_OPEN_EVENT));
}

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
 * A close reported while the hold is on (Escape, the pointer leaving a glyph
 * it had hovered, or another tooltip opening) dismisses the hold for the
 * current focus session.
 */
export function useStatusGlyphTooltipOpen(): StatusGlyphTooltipOpen {
  const hold = useContext(StatusGlyphFocusContext);
  const [hoverOpen, setHoverOpen] = useState(false);
  const onOpenChange = useCallback(
    (open: boolean) => {
      setHoverOpen(open);
      if (!open && hold !== null) hold.dismiss();
    },
    [hold],
  );
  const heldOpen = hold !== null && !hold.dismissed;
  return { open: heldOpen || hoverOpen, onOpenChange };
}
