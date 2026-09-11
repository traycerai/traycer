import { cn } from "@/lib/utils";
import type { HomeDensity } from "@/stores/settings/layout-store";

/**
 * The class language every Home row shares, and the one preference that bends
 * it.
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

/**
 * What `compact` actually changes, and what it deliberately does not.
 *
 * It tightens the row on a PRECISE pointer only. Every tightened utility is
 * restored under `pointer-coarse:`, so a phone keeps the `p-3` hit area H3
 * sized for a thumb - and `touch-chrome` rides the base class, so it is never
 * at stake either way. A density preference is about how much of a big screen
 * a list is allowed to use; shrinking a touch target is a different decision,
 * and not one this control was given.
 */
const COMPACT_ROW_CLASS = "gap-2 p-2 pointer-coarse:gap-3 pointer-coarse:p-3";

export function homeRowClass(density: HomeDensity): string {
  return density === "compact" ? cn(ROW_CLASS, COMPACT_ROW_CLASS) : ROW_CLASS;
}

/** The row's edge-to-edge open control. Stretched over the whole card by the
 * absolute overlay so a click anywhere that is not another control opens the
 * row, while the button itself stays an ordinary inline flex child for layout
 * and for the accessible name.
 *
 * The overlay's containing block is the ROW (the nearest positioned ancestor,
 * via `homeRowClass`'s `relative`), not this button - so it covers siblings on
 * both sides of it. A control BEFORE this button in tree order therefore needs
 * `z-10`, not merely `relative`; see `RowActions` in `home-focus-rows.tsx`. */
export const ROW_BODY_CLASS =
  "flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none before:absolute before:inset-0 before:rounded-md before:content-[''] focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset";

export const TASK_TITLE_CLASS = "shrink-0 truncate font-medium text-foreground";

const CHIP_ROW_CLASS =
  "flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1";

const COMPACT_CHIP_ROW_CLASS = "gap-x-1.5 pointer-coarse:gap-x-2";

/** The task row's wrap-around cluster of agent chips. Tightened with the row,
 * and restored with it under a coarse pointer. */
export function homeChipRowClass(density: HomeDensity): string {
  return density === "compact"
    ? cn(CHIP_ROW_CLASS, COMPACT_CHIP_ROW_CLASS)
    : CHIP_ROW_CLASS;
}
