import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { IDisposable } from "@xterm/xterm";

import {
  QUOTE_CONTROL_SLOT,
  terminalSelectionAnchor,
  type TerminalSelectionAnchor,
} from "./terminal-selection-anchor";

export interface TerminalQuoteSelection {
  /** The selected lines, exactly as xterm reports them. */
  readonly text: string;
  readonly anchor: TerminalSelectionAnchor;
}

/**
 * The slice of xterm's `Terminal` this hook reads, satisfied structurally by
 * the real engine. Narrow on purpose: it says exactly what watching a
 * selection needs, and it is what lets the state machine be exercised without
 * standing up a canvas-backed terminal.
 */
export interface TerminalSelectionSource {
  readonly element: HTMLElement | undefined;
  readonly rows: number;
  readonly cols: number;
  readonly buffer: { readonly active: { readonly viewportY: number } };
  hasSelection(): boolean;
  getSelection(): string;
  getSelectionPosition():
    { readonly start: { readonly x: number; readonly y: number } } | undefined;
  onSelectionChange(listener: () => void): IDisposable;
  onScroll(listener: (yDisp: number) => void): IDisposable;
}

interface UseTerminalQuoteSelectionArgs {
  /** The pane's live xterm engine; `null` until the tile has one. */
  readonly term: TerminalSelectionSource | null;
  /** The `position: relative` pane box the control is positioned within. */
  readonly paneRef: RefObject<HTMLElement | null>;
  /**
   * True while the control's own menu is open. Dismissal is suspended for as
   * long as it is: picking a target from the menu must not retract the control
   * that opened it.
   */
  readonly menuOpen: boolean;
}

/**
 * Publishes the terminal selection the quote control acts on.
 *
 * Two signals, doing different jobs. `onSelectionChange` fires continuously
 * while dragging, so it is used only to RETRACT (an empty selection means the
 * control has nothing to act on). `mouseup` is what PUBLISHES, so the control
 * appears once the user has finished choosing rather than flickering along
 * behind the cursor.
 *
 * That `mouseup` is watched on the DOCUMENT, for the length of a drag that
 * began in the pane. Selecting to the end of the output means dragging past
 * the pane's edge, and xterm follows the pointer out and finishes the drag
 * wherever it is released - so a pane-local listener misses exactly the
 * selections a user most wants to quote.
 *
 * Nothing here resizes or refits the terminal. That is load-bearing: a reflow
 * makes xterm drop its selection, which would retract the control the moment it
 * appeared. The control floats over the output for exactly this reason.
 */
export function useTerminalQuoteSelection(
  args: UseTerminalQuoteSelectionArgs,
): {
  readonly selection: TerminalQuoteSelection | null;
  readonly dismiss: () => void;
} {
  const { term, paneRef, menuOpen } = args;
  const [selection, setSelection] = useState<TerminalQuoteSelection | null>(
    null,
  );
  // Read from inside long-lived xterm event handlers, which must not be torn
  // down and re-bound every time the menu opens. Written in an effect so the
  // lint rule forbidding ref writes during render is satisfied.
  const menuOpenRef = useRef(menuOpen);
  useEffect(() => {
    menuOpenRef.current = menuOpen;
  }, [menuOpen]);

  const dismiss = useCallback(() => setSelection(null), []);

  useEffect(() => {
    if (term === null) return;
    const element = term.element;
    if (element === undefined) return;

    const readSelection = (): TerminalQuoteSelection | null => {
      if (!term.hasSelection()) return null;
      const text = term.getSelection();
      if (text.length === 0) return null;
      const range = term.getSelectionPosition();
      const pane = paneRef.current;
      const screen = element.querySelector(".xterm-screen");
      if (range === undefined || pane === null || screen === null) return null;
      const screenRect = screen.getBoundingClientRect();
      const paneRect = pane.getBoundingClientRect();
      return {
        text,
        anchor: terminalSelectionAnchor({
          selectionStartRow: range.start.y,
          selectionStartColumn: range.start.x,
          viewportY: term.buffer.active.viewportY,
          rows: term.rows,
          cols: term.cols,
          screenTop: screenRect.top - paneRect.top,
          screenHeight: screenRect.height,
          screenLeft: screenRect.left - paneRect.left,
          screenWidth: screenRect.width,
          paneWidth: paneRect.width,
        }),
      };
    };

    const publish = (): void => {
      const next = readSelection();
      setSelection((current) =>
        sameSelection(current, next) ? current : next,
      );
    };

    // Retract only. Publishing from here would chase the cursor mid-drag.
    const selectionCleared = term.onSelectionChange(() => {
      if (term.hasSelection()) return;
      if (menuOpenRef.current) return;
      setSelection(null);
    });
    // The selection keeps its absolute buffer rows while output scrolls under
    // it, so the anchor - not the selection - is what has to be recomputed.
    const scrolled = term.onScroll(() => {
      // Read before the updater, as `publish` does: React may invoke an
      // updater more than once, and `readSelection` measures live DOM.
      const next = readSelection();
      setSelection((current) => (current === null ? null : next));
    });

    // Only a drag that STARTED in this pane publishes: `readSelection` already
    // returns null for a selection this terminal does not own, but binding on
    // mousedown keeps the document listener off entirely except while this
    // pane's drag is in flight.
    const handleMouseUp = (): void => {
      document.removeEventListener("mouseup", handleMouseUp);
      publish();
    };
    const handleMouseDown = (): void => {
      document.addEventListener("mouseup", handleMouseUp);
    };
    element.addEventListener("mousedown", handleMouseDown);
    return () => {
      element.removeEventListener("mousedown", handleMouseDown);
      // A drag in flight when the tile unmounts never gets its mouseup.
      document.removeEventListener("mouseup", handleMouseUp);
      selectionCleared.dispose();
      scrolled.dispose();
    };
  }, [term, paneRef]);

  // Escape dismisses the control without touching the terminal's selection, so
  // the user can hide the affordance and keep what they highlighted. Exempt
  // while the menu is open, for the same reason the click-away handler is:
  // Escape closes the menu (Radix handles that), and the control it was opened
  // from must survive to be used again.
  useEffect(() => {
    if (selection === null) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (menuOpenRef.current) return;
      setSelection(null);
    };
    // Capture phase: focus usually sits inside the xterm right after a
    // selection, and xterm's own key handling can swallow the event before it
    // bubbles back to the document.
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [selection]);

  // Clicking away dismisses. A click INSIDE the terminal already clears xterm's
  // own selection and is handled above; this covers clicks that land elsewhere
  // entirely - another pane, the sidebar - where the selection survives but the
  // affordance no longer belongs on screen. The control's own surface is
  // exempt, as is everything while its menu is open: that menu portals to the
  // body, so its items are outside both elements.
  useEffect(() => {
    if (selection === null) return;
    const handleMouseDown = (event: MouseEvent): void => {
      if (menuOpenRef.current) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (term?.element?.contains(target) === true) return;
      if (target.closest(`[data-slot="${QUOTE_CONTROL_SLOT}"]`) !== null)
        return;
      setSelection(null);
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [selection, term]);

  return { selection, dismiss };
}

function sameSelection(
  left: TerminalQuoteSelection | null,
  right: TerminalQuoteSelection | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.text === right.text &&
    left.anchor.top === right.anchor.top &&
    left.anchor.left === right.anchor.left &&
    left.anchor.maxWidth === right.anchor.maxWidth &&
    left.anchor.placement === right.anchor.placement
  );
}
