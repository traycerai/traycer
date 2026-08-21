/**
 * Marks a navigation as an EXPLICIT user escape made from a boot surface, so
 * the desktop's restored-route replay can tell it apart from the routing
 * traffic a launch generates on its own.
 *
 * WHY A MARKER AND NOT "did we observe a commit before hydration". The route
 * bridge used to infer intent from that question, which was only safe while it
 * mounted late enough to miss startup traffic. It observes from app
 * construction now, and a cold launch REPLACES the restored route with `/`
 * all by itself: every protected route runs `requireSignedIn`, which does
 * `redirect({ to: "/" })` while the auth store is still `signed-out` (stored
 * tokens have not finished validating - see `bindAuthInvalidation` in
 * `router.tsx`). Treating that as user intent vetoes the restore and strands
 * the window on the landing page instead of the epic tab it was showing at
 * shutdown. `persistent-history.ts` already refuses to PERSIST that transient
 * `/` for exactly the same reason; this is the same fact, one layer up.
 *
 * So intent is DECLARED by the navigation that has it, never inferred from
 * history traffic. Today the only declarers are the boot card's two escape
 * hatches (`Open settings`, `Configure shell…`) in `TraycerApp` - the app is
 * not mounted yet on those surfaces, so nothing else can navigate.
 *
 * It rides in history state, which means it survives the gap between paint and
 * the bridge's subscription: the bridge can read it off the CURRENT location
 * at hydration time whether or not it saw the commit go by.
 */
export const STARTUP_NAVIGATION_INTENT_KEY = "__traycerStartupNavigationIntent";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Whether a history entry's state carries the escape-hatch marker. */
export function isStartupNavigationIntent(state: unknown): boolean {
  return isRecord(state) && state[STARTUP_NAVIGATION_INTENT_KEY] === true;
}
