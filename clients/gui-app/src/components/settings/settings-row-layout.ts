/**
 * The narrow-width half of a settings row's geometry, shared by every row that
 * pairs a label block with a control.
 *
 * A settings row is two columns: the label block owns the flexible width and
 * the control keeps the trailing edge. That only works while the row is wide
 * enough to hold both. A control keeps its intrinsic width, so a row with no
 * floor under its label gives the label whatever is left over - which on a
 * phone is a sliver, and a two-word label then breaks one word per line with
 * its description at a few characters per line.
 *
 * The floor is what prevents that, and flex line-breaking is what acts on it:
 * an item's hypothetical main size is its basis clamped by its own min-width,
 * so a `70%` floor below `md` means any control wider than the remaining third
 * of the row is pushed onto a line of its own before any shrinking happens.
 * Wide controls - selects, inputs, chip rows, action clusters - therefore stack
 * under the label at phone width, while a switch or an icon button stays beside
 * it, which is where a settings toggle belongs.
 *
 * Every class here carries the `max-md:` variant (bar the `flex-wrap` the
 * mechanism depends on, which these rows already declare), so this is a set of
 * overrides layered onto the row that uses it rather than a layout of its own -
 * that row keeps its own padding, borders and typography, and at `md` and above
 * nothing here applies.
 *
 * Viewport-driven, not shell-driven: a narrow desktop window is narrow for the
 * same reason a phone is, and gets the same behaviour.
 */
export const SETTINGS_ROW_STACK = {
  /**
   * Row container: the wrapping the floor acts through, plus room between the
   * two lines once a control has taken one of its own.
   */
  container: "flex-wrap max-md:gap-y-3",
  /**
   * Label block: the width floor that sends a wide control to the next line
   * instead of letting it take the label's.
   */
  label: "max-md:min-w-[70%]",
  /** Control: holds its intrinsic width rather than shrink into the label's. */
  control: "max-md:shrink-0",
} as const;
