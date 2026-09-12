/**
 * The class language every Home row shares.
 *
 * Kept out of the row components' own module so the Tasks view's nested rows
 * can speak it too without that module having to export a string beside its
 * components.
 *
 * ## The narrow layout, and the overlap it exists to fix
 *
 * Below `@max-[30rem]` every row folds into TWO lines. It is a CONTAINER query
 * on the section (`home-focus-view`'s `@container`), not a viewport one, so the
 * mobile drawer and a slim Home pane in a wide desktop window behave the same -
 * the row is answering a question about its own width.
 *
 * What the single line actually did on a phone, which is worth writing down
 * because the failure did not look like a width problem: the status and actions
 * tracks below are FIXED and `shrink-0` (8rem + 6rem = 14rem of a ~21rem row),
 * so the whole deficit landed on the two flexible items - the name and the chip
 * row. The chip row is `flex-1 min-w-0`, so its BOX collapsed toward zero,
 * while the badges inside it are `shrink-0` with no `overflow-hidden` anywhere
 * above them. `flex-wrap` cannot help once a single item is wider than the
 * line, so each badge kept its intrinsic width and spilled out of its parent's
 * collapsed box to the right, painting over the status cell that follows it -
 * `1 active` drawn under `● turn`, badges stacked vertically with the status on
 * top of them. That is the screenshot's overlap, and it is a sizing bug rather
 * than a clipping one: the fix is to stop asking one line to hold all five
 * cells, and to release the fixed tracks while it is folded.
 */

// `active:press-scrim pointer-coarse:touch-chrome` for the same reason the
// History row card carries them: the row is a plain container, not a `Button`,
// so it opts into the shared press scrim itself. Without it a tap on touch -
// where `hover:` never fires - leaves the row inert for the whole open round
// trip, and Home is a phone surface too.
//
// `@max-[30rem]:flex-wrap` is what lets the meta line below take a line of its
// own; the tighter gaps go with it, because `gap-3` between two LINES is a
// gutter rather than a separator.
export const ROW_CLASS =
  "group/focus-row relative flex min-w-0 items-center gap-3 rounded-md p-3 text-ui-sm transition-colors hover:bg-accent/40 has-[:focus-visible]:bg-accent/40 active:press-scrim pointer-coarse:touch-chrome @max-[30rem]:flex-wrap @max-[30rem]:gap-x-2 @max-[30rem]:gap-y-1";

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
 *
 * BOTH tracks release below `@max-[30rem]`, and that is the other half of the
 * narrow layout rather than a concession to it. A column only earns its width
 * while there IS a column: folded, the status sits at the end of the meta line
 * and the actions cell holds one icon, so 14rem of reserved track is 14rem
 * taken from the name for an alignment nothing can see. `w-auto` on both is
 * what leaves the deficit at zero, which is what stops the badges overflowing.
 *
 * Releasing a track means releasing its `shrink-0` too, and the status cell is
 * where forgetting that bites. `w-auto` alone makes the cell take its INTRINSIC
 * width, and `shrink-0` then forbids it giving any back - so a browser row's
 * `· driven by <agent>` sized itself to the whole sentence and ran off the row,
 * the same unshrinkable-item overflow as the badges one level up. The fixed
 * track had been doing the bounding, and `RowStatusNote`'s `truncate` needs a
 * bounded parent to truncate INSIDE. `min-w-0 max-w-full shrink` is that bound:
 * at most the meta line, shrinkable below its content, and the note clips.
 */
export const ROW_STATUS_CELL_CLASS =
  "w-32 shrink-0 sm:w-36 @max-[30rem]:w-auto @max-[30rem]:max-w-full @max-[30rem]:min-w-0 @max-[30rem]:shrink";

export const ROW_ACTIONS_CELL_CLASS = "w-24 shrink-0 @max-[30rem]:w-auto";

/**
 * The task row's wrap-around cluster of agent chips.
 *
 * `@max-[30rem]:contents` rather than a narrower flex box, deliberately: nested
 * inside the meta line the cluster would be a wrap container inside a wrap
 * container, and its own max-content width (every `shrink-0` badge, summed)
 * could still exceed the line and overflow exactly as it did before. Dissolved
 * into `display: contents` the badges become items of the meta line itself, so
 * they wrap against the row's real width and the status cell follows them.
 */
export const CHIP_ROW_CLASS =
  "flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 @max-[30rem]:contents";

/**
 * The row's second line at narrow widths, and nothing at all at wide ones.
 *
 * `display: contents` is the whole trick: at wide width this element generates
 * no box, so the badges and the status cell stay direct flex items of the row
 * and the desktop layout is byte-for-byte the one that existed before this
 * wrapper did. Below the fold it becomes a real wrapping row, `w-full` so it
 * claims a line of its own, and `order-last` so the Stop it is declared BEFORE
 * in the DOM stays up on line one with the name.
 *
 * `ps-7` is the glyph column: a task row spends 1.25rem on its twisty plus the
 * folded `gap-x-2`, and a child row spends its glyph plus `gap-2` - the two
 * land close enough that one indent reads as "under the name" on both, without
 * a second class for rows that have no twisty.
 */
export const ROW_META_CLASS =
  "contents @max-[30rem]:order-last @max-[30rem]:flex @max-[30rem]:w-full @max-[30rem]:min-w-0 @max-[30rem]:flex-wrap @max-[30rem]:items-center @max-[30rem]:gap-x-2 @max-[30rem]:gap-y-1 @max-[30rem]:ps-7";
