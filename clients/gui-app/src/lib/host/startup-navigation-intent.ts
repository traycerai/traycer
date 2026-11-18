import type { HistoryState } from "@tanstack/react-router";

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

/**
 * The second marker, written only by the desktop's own "Settings…" (native
 * menu, tray, jump list) when it arrives while a boot surface is still up.
 *
 * It rides beside the escape-hatch marker, never instead of it: an admitted
 * launch reads the escape-hatch marker exactly as before and opens Settings ▸
 * Host. What it adds is for a launch that settles SIGNED OUT, where
 * `/settings` renders the sign-in page. There the command's request means the
 * one setting a signed-out desktop can reach, so `SettingsLayout` sends it to
 * `/when-you-quit`. The boot card's own buttons do not carry it and keep
 * landing on sign-in.
 */
export const STARTUP_MENU_SETTINGS_INTENT_KEY =
  "__traycerStartupMenuSettingsIntent";

/** Whether a history entry's state carries the escape-hatch marker. */
export function isStartupNavigationIntent(state: unknown): boolean {
  return isRecord(state) && state[STARTUP_NAVIGATION_INTENT_KEY] === true;
}

/** Whether a history entry's state carries the desktop menu's marker. */
export function isStartupMenuSettingsIntent(state: unknown): boolean {
  return isRecord(state) && state[STARTUP_MENU_SETTINGS_INTENT_KEY] === true;
}

/**
 * The history state a boot-surface navigation writes: the previous state with
 * the escape-hatch marker, plus the menu marker when the desktop's "Settings…"
 * asked. One builder for every boot navigation, so the escape hatches cannot
 * drift apart in what they declare. The markers are not part of the router's
 * `HistoryState`, hence the open record alongside it.
 */
export function withStartupNavigationIntent(
  previous: HistoryState,
  source: "boot-card" | "desktop-menu",
): HistoryState & Readonly<Record<string, unknown>> {
  if (source === "boot-card") {
    return { ...previous, [STARTUP_NAVIGATION_INTENT_KEY]: true };
  }
  return {
    ...previous,
    [STARTUP_NAVIGATION_INTENT_KEY]: true,
    [STARTUP_MENU_SETTINGS_INTENT_KEY]: true,
  };
}
