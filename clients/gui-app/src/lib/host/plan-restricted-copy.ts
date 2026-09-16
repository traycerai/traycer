/**
 * What the app says about a plan-restricted host when it is the INSTALLED
 * mobile app.
 *
 * App Store review guideline 3.1.1 forbids an app from presenting or linking
 * to a subscription that cannot be bought through Apple, and Traycer's is
 * bought on the web. Every plan-restricted surface has the same two halves:
 * the FACT (this machine is fine, this app cannot attach to it) and the
 * REMEDY (upgrade). The fact is honest and stays on every shell; the remedy
 * is the part that reads as a purchase, so on the phone it is replaced by a
 * pointer to the shell that may carry it.
 *
 * Collected here rather than branched per call site so the phone gives one
 * answer everywhere - the settings scope gate, the resource monitor, the
 * window narration card, the dead tiles, the worktrees panel and the share
 * refusal toast all reached this state independently, and three different
 * apologies would read as three different bugs. The DESKTOP strings stay at
 * their call sites, untouched: they are specific to the surface, and this
 * change must be invisible there.
 *
 * Plain strings in `lib/` (not the action component) so a toast builder can
 * import them without pulling React in.
 */

/**
 * The heading when the surface has no ONE host to name - the window narration
 * card, whose plan-restricted state is a statement about every host on the
 * account rather than about a machine the reader picked.
 */
export const PLAN_RESTRICTED_MOBILE_TITLE =
  "This computer is not available to the mobile app on the current plan";

/**
 * The heading a plan-restricted notice carries on the phone, for a surface
 * that names one host.
 *
 * Naming the host is the whole value of these notices: the reader picked a
 * machine, and the name tells them which one. The desktop titles all name it,
 * so the phone does too - dropping the name to satisfy 3.1.1 would have traded
 * away clarity the guideline never asked for. The one surface with no single
 * host to name (the window narration card) uses `PLAN_RESTRICTED_MOBILE_TITLE`
 * directly instead.
 */
export function planRestrictedMobileTitle(hostName: string): string {
  return `${hostName} is not available to the mobile app on the current plan`;
}

/** The body beneath it: the fact, then where the setting lives. */
export const PLAN_RESTRICTED_MOBILE_DETAIL =
  "It keeps working on its own machine. Manage this from the Traycer desktop app.";

/**
 * The remedy sentence on its own, for copy that already states the fact in
 * its own words and only needs the "upgrade" clause swapped out.
 */
export const PLAN_RESTRICTED_MOBILE_REMEDY =
  "Manage this from the Traycer desktop app.";
