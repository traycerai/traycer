/**
 * The anchor is computed when the selection is published on mouseup (see `useTerminalQuoteSelection`), never while the drag is live, so the control cannot skate sideways while the user is still choosing what to select - the objection that kept this vertical-only.
 */
export interface TerminalSelectionAnchorInput {
  /** Absolute buffer row the selection starts on (`IBufferRange.start.y`). */
  readonly selectionStartRow: number;
  /** Buffer column the selection starts on (`IBufferRange.start.x`). */
  readonly selectionStartColumn: number;
  /** Buffer row currently at the top of the viewport (`buffer.active.viewportY`). */
  readonly viewportY: number;
  /** Visible rows in the grid (`term.rows`). */
  readonly rows: number;
  /** Columns in the grid (`term.cols`). */
  readonly cols: number;
  /** Top of the xterm screen element, in px within the pane's own box. */
  readonly screenTop: number;
  /** Height of the xterm screen element in px (all `rows` of it). */
  readonly screenHeight: number;
  /** Left edge of the xterm screen element, in px within the pane's own box. */
  readonly screenLeft: number;
  /** Width of the xterm screen element in px (all `cols` of it). */
  readonly screenWidth: number;
  /** Width of the pane box the control is positioned within, in px. */
  readonly paneWidth: number;
}

export interface TerminalSelectionAnchor {
  /** Offset for the control's `top`, in px within the pane's box. */
  readonly top: number;
  /** Offset for the control's `left`, in px within the pane's box. */
  readonly left: number;
  /**
   * Paired with `left`, this is what stops a selection near the right edge from pushing the control off the pane - nothing here can measure the control before it is placed.
   */
  readonly maxWidth: number;
  /**
   * `"above"` means `top` is the line's top edge and the control must be shifted up by its own height (`-translate-y-full`) to sit over it - which is how the control avoids ever having to measure itself.
   */
  readonly placement: "above" | "below";
}

/**
 * Named here, next to the other geometry constants, so the control and the click-away rule that must ignore it cannot drift apart.
 */
export const QUOTE_CONTROL_SLOT = "terminal-quote-control";

/** Gap between the control and the line it points at. */
const ANCHOR_GAP_PX = 4;

/**
 * Compared against px rather than a row count because a terminal row is 12px at one font size and 30px at another, while the control's own height barely moves.
 */
const MIN_ROOM_ABOVE_PX = 28;

/**
 * How close the control may come to either pane edge - the same rail it used
 * to be pinned to, now a bound rather than a position.
 */
const PANE_INSET_PX = 8;

/**
 * An approximation is safe because it only decides how far right the control may START - `maxWidth` is what actually prevents spill.
 */
const MIN_CONTROL_WIDTH_PX = 136;

export function terminalSelectionAnchor(
  input: TerminalSelectionAnchorInput,
): TerminalSelectionAnchor {
  const cellHeight = input.rows > 0 ? input.screenHeight / input.rows : 0;
  const cellWidth = input.cols > 0 ? input.screenWidth / input.cols : 0;
  // A selection that starts above the viewport (the user scrolled down after
  // selecting) anchors to the top visible line rather than off-screen.
  const viewportRow = clamp(
    input.selectionStartRow - input.viewportY,
    0,
    Math.max(input.rows - 1, 0),
  );
  const lineTop = input.screenTop + viewportRow * cellHeight;
  const column = clamp(
    input.selectionStartColumn,
    0,
    Math.max(input.cols - 1, 0),
  );
  // On a pane too narrow to hold the control the upper bound falls below the lower one; the inset then wins, keeping the control inside the pane's LEFT edge rather than pushing it out past the right.
  const maxLeft = Math.max(
    PANE_INSET_PX,
    input.paneWidth - PANE_INSET_PX - MIN_CONTROL_WIDTH_PX,
  );
  const left = clamp(
    input.screenLeft + column * cellWidth,
    PANE_INSET_PX,
    maxLeft,
  );
  const maxWidth = Math.max(0, input.paneWidth - PANE_INSET_PX - left);

  if (lineTop - ANCHOR_GAP_PX >= MIN_ROOM_ABOVE_PX) {
    return { top: lineTop - ANCHOR_GAP_PX, left, maxWidth, placement: "above" };
  }
  return {
    top: lineTop + cellHeight + ANCHOR_GAP_PX,
    left,
    maxWidth,
    placement: "below",
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
