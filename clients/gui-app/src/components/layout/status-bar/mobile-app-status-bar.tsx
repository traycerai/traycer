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
 * That cuts the other way too, and both of the strip's chords are shaped by
 * it. Unmounting here is not a quiet no-op: an unregister clears the slot, so
 * anything this subtree had claimed goes away with it and its rival's effect
 * does not re-run to take it back. Which is exactly why, on this viewport,
 * the strip claims `app.rate-limits.open` never (`ScopedAppStatusBar`) and
 * `app.resources.open` only when the mobile header is drawing no resource
 * monitor of its own - so what this component takes away is a surface, never
 * a keyboard shortcut the header is still offering.
 */
export function MobileAppStatusBar(): ReactNode {
  const keyboardOpen = useSoftwareKeyboardOpen();
  const drawerOpen = useMobileNavStore((state) => state.open);
  if (keyboardOpen || drawerOpen) return null;
  return <AppStatusBar />;
}
