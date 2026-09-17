/**
 * HOW SOLID A SEAT'S ART IS, for every view that dims one.
 *
 * A painter owns its art and the scene owns the clock; what neither owned was
 * the handful of numbers that say the same thing on every floor - this desk has
 * nobody at it, this screen is on but unattended, this record is archived. They
 * were written per painter, and two of them (Floor and Mission control) had
 * byte-identical copies of the same `monitorAlphaFor` sitting in both files.
 * Feedback round 1 turned one of those numbers into a visible bug on one view
 * only ("these transparent desks look weird" on Building), which is what
 * duplicated constants buy: a fix that lands on the view somebody screenshotted
 * and nowhere else.
 *
 * NOT EVERY VIEW DIMS, and that is deliberate rather than an omission this
 * module should paper over. The two isometric views say the same things through
 * art instead: an unlit monitor sprite for a screen nobody is at, and a
 * building's storey count for how much an agent has been doing. The oblique
 * views say "archived" with a dust sheet over the desk. Alpha is one channel of
 * several, and a view that already has a channel does not need this one - what
 * matters is that the views which DO reach for alpha reach for the same number.
 */
import type { OfficeDeskState } from "@/lib/comm-graph/office/views/office-view";

/**
 * An idle screen: LIT, merely unattended.
 *
 * Idle is not off. The agent's monitor is still on and its desk is still
 * theirs; what has stopped is the typing. Dimming rather than switching the
 * sprite is what keeps that distinction drawable at a zoom where the screen is
 * six pixels across.
 */
export const OFFICE_IDLE_MONITOR_ALPHA = 0.6;

/**
 * An archived record: the only seat art that actually powers down.
 *
 * Low enough to read as "this is history" against the live desks around it.
 * Archived art carries a second channel on most views - an off sprite, a dust
 * sheet - so unlike {@link OFFICE_UNCLAIMED_FURNITURE_ALPHA} it can afford to
 * be faint without the furniture ceasing to read as furniture.
 */
export const OFFICE_ARCHIVED_ALPHA = 0.45;

/**
 * FURNITURE NOBODY HAS CLAIMED: dimmed, but still furniture.
 *
 * Below about 0.7 a sprite's near-black OUTLINE stops reading as a line over a
 * dark floor, and the piece goes from dimmed to translucent - an empty desk
 * became a brown bar painted onto the floor, and an empty console became a grey
 * smear. Feedback round 1 named it on Building ("these transparent desks look
 * weird"); Mission control's empty consoles were the same decision at a
 * different number (`0.55`) and the same complaint waiting to be filed.
 *
 * The dimming itself stays - it is what says the seat is unclaimed on a floor
 * whose occupied seats look otherwise identical. What this number buys is that
 * the furniture survives it.
 */
export const OFFICE_UNCLAIMED_FURNITURE_ALPHA = 0.72;

/**
 * The alpha a seat's MONITOR is drawn at, or `undefined` for full strength.
 *
 * `undefined` rather than `1` because that is what the drawable takes: a seat
 * prop with no alpha is solid, and passing an explicit `1` would put a
 * `globalAlpha` write in the hot path for every working desk on the floor.
 */
export function officeMonitorAlphaFor(
  state: OfficeDeskState,
): number | undefined {
  if (state.status === "archived") return OFFICE_ARCHIVED_ALPHA;
  if (state.status === "idle") return OFFICE_IDLE_MONITOR_ALPHA;
  return undefined;
}
