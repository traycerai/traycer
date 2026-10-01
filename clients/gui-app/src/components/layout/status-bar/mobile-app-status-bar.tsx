import { type ReactNode } from "react";
import { AppStatusBar } from "@/components/layout/status-bar/app-status-bar";
import { useSoftwareKeyboardOpen } from "@/hooks/ui/use-software-keyboard-open";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";

/**
 * The footer strip on a mobile viewport, and the two things that take it away
 * again while it is switched on.
 *
 * Separate from `AppShell` so the two subscriptions below stay out of the root
 * of the app: the drawer opens and the keyboard flips often, and neither is a
 * fact the shell itself has any use for. Mounted only where the strip is
 * already wanted, so a desktop window subscribes to neither.
 *
 * - **The software keyboard.** It covers the bottom of the viewport, so the
 *   strip would either sit behind it or ride above it as a second toolbar over
 *   whatever the user is typing into. `useSoftwareKeyboardOpen` is the union of
 *   the browser's measurement and the installed app's plugin events, because
 *   which of those two is live depends on the shell rather than on this
 *   surface.
 * - **The nav drawer.** Its own state, read from `mobile-nav-store` — the
 *   drawer's single source of truth, which both drawer surfaces already write.
 *   The drawer is `pb-safe-bottom` down to the bottom edge, so an open drawer
 *   and the strip are competing for the same band of screen.
 *
 * A React gate, never CSS hiding, for the reason `AppShell` states about the
 * desktop gate: the dynamic-action registry is single-handler, and a hidden
 * mount would still hold whichever chords it claimed while the surface that
 * is actually on screen has none.
 *
 * Unmounting here takes the strip's two chords with it, and that is safe
 * because nothing else is offering them: the mobile header draws neither
 * reading while the footer is switched on, and it follows the SETTING rather
 * than this transient hide, so the readings never hop up into the header for
 * the length of a keystroke. The chords come back with the strip.
 */
export function MobileAppStatusBar(): ReactNode {
  const keyboardOpen = useSoftwareKeyboardOpen();
  const drawerOpen = useMobileNavStore((state) => state.open);
  if (keyboardOpen || drawerOpen) return null;
  return <AppStatusBar />;
}
