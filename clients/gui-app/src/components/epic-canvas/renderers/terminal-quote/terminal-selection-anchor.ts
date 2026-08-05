/**
 * Where the quote control sits over a terminal pane.
 *
 * Vertical only, by design: the control tracks the first selected LINE and
 * stays on the pane's left text rail. A selection routinely starts mid-line and
 * gets re-dragged, so following the start column too would make the control
 * skate sideways while the user is still choosing what to select - and could
 * push it off the right edge. Line-level tracking is what makes it read as
 * attached to the selection; column-level tracking is only noise.
 */
export interface TerminalSelectionAnchorInput {
  /** Absolute buffer row the selection starts on (`IBufferRange.start.y`). */
  readonly selectionStartRow: number;
  /** Buffer row currently at the top of the viewport (`buffer.active.viewportY`). */
  readonly viewportY: number;
  /** Visible rows in the grid (`term.rows`). */
  readonly rows: number;
  /** Top of the xterm screen element, in px within the pane's own box. */
  readonly screenTop: number;
  /** Height of the xterm screen element in px (all `rows` of it). */
  readonly screenHeight: number;
}

export interface TerminalSelectionAnchor {
  /** Offset for the control's `top`, in px within the pane's box. */
  readonly top: number;
  /**
   * `"above"` means `top` is the line's top edge and the control must be
   * shifted up by its own height (`-translate-y-full`) to sit over it - which
   * is how the control avoids ever having to measure itself.
   */
  readonly placement: "above" | "below";
}

/**
 * DOM marker on the quote control's root. Named here, next to the other
 * geometry constants, so the control and the click-away rule that must ignore
 * it cannot drift apart.
 */
export const QUOTE_CONTROL_SLOT = "terminal-quote-control";

/** Gap between the control and the line it points at. */
const ANCHOR_GAP_PX = 4;

/**
 * Smallest room above the line worth placing the control in. Compared against
 * px rather than a row count because a terminal row is 12px at one font size
 * and 30px at another, while the control's own height barely moves.
 */
const MIN_ROOM_ABOVE_PX = 28;

export function terminalSelectionAnchor(
  input: TerminalSelectionAnchorInput,
): TerminalSelectionAnchor {
  const cellHeight = input.rows > 0 ? input.screenHeight / input.rows : 0;
  // A selection that starts above the viewport (the user scrolled down after
  // selecting) anchors to the top visible line rather than off-screen.
  const viewportRow = clamp(
    input.selectionStartRow - input.viewportY,
    0,
    Math.max(input.rows - 1, 0),
  );
  const lineTop = input.screenTop + viewportRow * cellHeight;

  if (lineTop - ANCHOR_GAP_PX >= MIN_ROOM_ABOVE_PX) {
    return { top: lineTop - ANCHOR_GAP_PX, placement: "above" };
  }
  return { top: lineTop + cellHeight + ANCHOR_GAP_PX, placement: "below" };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
