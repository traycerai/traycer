import {
  SIDE_STRIP_DEFAULT_WIDTH_PX,
  SIDE_STRIP_RAIL_WIDTH_PX,
} from "@/components/layout/tabs/side-strip/side-strip-tokens";

/**
 * The one width rule of the phone shell: what level 1 (the tasks and Tracy)
 * draws, what level 2 (what lives inside the current level-1 item) draws, and
 * how many content tiles fit.
 *
 * Pure, and keyed on the width alone: nothing here knows what device it runs
 * on, so a window the OS hands the app in Split View gets the form its width
 * earns. `useMobileLayoutForm` is the measured read; every surface asks that
 * rather than deciding from a width of its own.
 */

/** Chosen: the narrowest a content tile gets before it stops being readable. */
export const MOBILE_PANE_MIN_WIDTH_PX = 384;

/** Measured: the bots sidebar's width where the bot tab had room for it. */
export const MOBILE_COLUMN_WIDTH_PX = 256;

/**
 * Chosen: the tight end of the level-2 column, the narrowest that still shows
 * a row's name. Between this and {@link MOBILE_COLUMN_WIDTH_PX} the column
 * takes its minimum so the pane keeps its own.
 */
export const MOBILE_COLUMN_MIN_WIDTH_PX = 220;

/** The desktop strip's rail, which is what draws here. */
export const MOBILE_RAIL_WIDTH_PX = SIDE_STRIP_RAIL_WIDTH_PX;

/** The desktop strip expanded, at its default width. */
export const MOBILE_EXPANDED_STRIP_WIDTH_PX = SIDE_STRIP_DEFAULT_WIDTH_PX;

/**
 * Measured: the widest phone viewport in portrait is 466, and the next panel
 * up in portrait is 669, so this sits just above the first. It is a limit on
 * the VIEWPORT, not on the content box: a phone's status column can take 84 of
 * that 466.
 */
export const MOBILE_PHONE_PORTRAIT_WIDTH_LIMIT_PX = 467;

/** The person's own choice between the two strips, where both fit. */
export type MobileStripPreference = "expanded" | "rail";

export type MobileLevel1Form = "drawer" | "rail" | "expanded";

export type MobileLevel2Form =
  | "bar"
  | "menu"
  | {
      readonly column:
        | typeof MOBILE_COLUMN_MIN_WIDTH_PX
        | typeof MOBILE_COLUMN_WIDTH_PX;
    };

export type MobileTileCount = 1 | 2;

export interface MobileLayoutFormInput {
  /** The shell's box after the safe-area insets. */
  readonly contentWidth: number;
  readonly phonePortrait: boolean;
  readonly stripPreference: MobileStripPreference;
  /** How many tiles the person has open; `tiles` answers how many of them show. */
  readonly openTiles: MobileTileCount;
}

export interface MobileLayoutForm {
  readonly level1: MobileLevel1Form;
  readonly level2: MobileLevel2Form;
  readonly tiles: MobileTileCount;
}

/** Level 2 beside one tile: the widest column that leaves the pane its minimum. */
function level2BesideOneTile(contentWidth: number): MobileLevel2Form {
  const besidePane = MOBILE_RAIL_WIDTH_PX + MOBILE_PANE_MIN_WIDTH_PX;
  if (contentWidth >= besidePane + MOBILE_COLUMN_WIDTH_PX) {
    return { column: MOBILE_COLUMN_WIDTH_PX };
  }
  if (contentWidth >= besidePane + MOBILE_COLUMN_MIN_WIDTH_PX) {
    return { column: MOBILE_COLUMN_MIN_WIDTH_PX };
  }
  return "menu";
}

/**
 * The expanded strip takes the row only where it leaves a column and a pane
 * beside it. A second tile needs two panes beside whichever strip draws, and
 * the column makes way for it at every width: while two tiles show, level 2 is
 * the menu. Below the rail and one pane nothing fits beside the content, which
 * is phone portrait's form whatever the orientation.
 */
export function resolveMobileLayoutForm(
  input: MobileLayoutFormInput,
): MobileLayoutForm {
  const { contentWidth, phonePortrait, stripPreference, openTiles } = input;
  if (
    phonePortrait ||
    contentWidth < MOBILE_RAIL_WIDTH_PX + MOBILE_PANE_MIN_WIDTH_PX
  ) {
    return { level1: "drawer", level2: "bar", tiles: 1 };
  }
  const expandedFits =
    contentWidth >=
    MOBILE_EXPANDED_STRIP_WIDTH_PX +
      MOBILE_COLUMN_WIDTH_PX +
      MOBILE_PANE_MIN_WIDTH_PX;
  const level1 =
    stripPreference === "expanded" && expandedFits ? "expanded" : "rail";
  const level1Width =
    level1 === "expanded"
      ? MOBILE_EXPANDED_STRIP_WIDTH_PX
      : MOBILE_RAIL_WIDTH_PX;
  if (
    openTiles === 2 &&
    contentWidth >= level1Width + 2 * MOBILE_PANE_MIN_WIDTH_PX
  ) {
    return { level1, level2: "menu", tiles: 2 };
  }
  return { level1, level2: level2BesideOneTile(contentWidth), tiles: 1 };
}
