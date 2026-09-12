/**
 * The class language every Home row shares.
 *
 * Kept out of the row components' own module so the Tasks view's nested rows
 * can speak it too without that module having to export a string beside its
 * components.
 */

// `active:press-scrim pointer-coarse:touch-chrome` for the same reason the
// History row card carries them: the row is a plain container, not a `Button`,
// so it opts into the shared press scrim itself. Without it a tap on touch -
// where `hover:` never fires - leaves the row inert for the whole open round
// trip, and Home is a phone surface too.
export const ROW_CLASS =
  "group/focus-row relative flex min-w-0 items-center gap-3 rounded-md p-3 text-ui-sm transition-colors hover:bg-accent/40 has-[:focus-visible]:bg-accent/40 active:press-scrim pointer-coarse:touch-chrome";

/** The row's edge-to-edge open control. Stretched over the whole card by the
 * absolute overlay so a click anywhere that is not another control opens the
 * row, while the button itself stays an ordinary inline flex child for layout
 * and for the accessible name.
 *
 * The overlay's containing block is the ROW (the nearest positioned ancestor,
 * via `ROW_CLASS`'s `relative`), not this button - so it covers siblings on
 * both sides of it. A control BEFORE this button in tree order therefore needs
 * `z-10`, not merely `relative`; see `RowActions` in `home-focus-rows.tsx`. */
export const ROW_BODY_CLASS =
  "flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none before:absolute before:inset-0 before:rounded-md before:content-[''] focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset";

export const TASK_TITLE_CLASS = "shrink-0 truncate font-medium text-foreground";

/**
 * The two right-hand TRACKS every row in a section reserves, whether or not it
 * has anything to put in them.
 *
 * This is what makes the status a COLUMN rather than three separately
 * right-aligned cells. Without fixed tracks the status floats left by whatever
 * the row's own trailing control happens to measure - `Stop all` is wider than
 * `Stop`, which is wider than nothing - so a section of mixed rows staircases
 * exactly where it is supposed to be scannable. Reserving both widths puts
 * every status's left edge at `row - actions - status`, identical for every row
 * of every shape, including the nested ones: a nested list is indented on its
 * LEFT only, so its right edge is the parent's and its tracks line up with the
 * parent's.
 *
 * These are fixed widths, which the fluid-sizing rule otherwise forbids, and
 * the argument is the same one the status-bar preview's `w-[480px]` makes: a
 * column track is not a layout surface that should adapt to its content - its
 * whole job is to NOT adapt, so that the rows either side of it agree. `w-32
 * sm:w-36` fits `needs you · 30m`; `w-24` fits a `Stop all` ghost button with
 * its glyph. A label that outgrows either track truncates rather than shifting
 * the column, which is the failure this trades for.
 */
export const ROW_STATUS_CELL_CLASS = "w-32 shrink-0 sm:w-36";

export const ROW_ACTIONS_CELL_CLASS = "w-24 shrink-0";

/** The task row's wrap-around cluster of agent chips. */
export const CHIP_ROW_CLASS =
  "flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1";
