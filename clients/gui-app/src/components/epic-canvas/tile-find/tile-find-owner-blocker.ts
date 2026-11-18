import type { TileFindOwnerBlocker } from "@/stores/tile-find/types";

/**
 * Routes whose body actually paints OVER `TopLevelTabHost`.
 *
 * This is deliberately NOT "is the pathname an epic canvas path". For a
 * signed-in user every ordinary route body renders `null` - `/`
 * (`RootLandingPage`), `/draft/$draftId`, `/epics` and `/epics/$epicId/$tabId`
 * (once the tab record exists) - because the visible surface is mounted by
 * `TopLevelTabHost` from the tabs store, not by the router. The router only
 * lags along: it is navigated when a tab is ACTIVATED, so a restored window
 * legitimately sits at `/` with a focused Epic surface showing a file tile.
 * Gating ownership on an epic-path match therefore blocked find and select-all
 * in the app's normal startup state (traycerai/traycer#592).
 *
 * Which surface is frontmost is already answered, route-independently, by pane
 * activity: `TileFindScope` registers `isEligible: isActive && paneFocused`,
 * and `paneFocused` derives from the tabs store's active item. That is the
 * signal that decides ownership. This list only has to name the routes that
 * take the viewport away from the tab host entirely.
 *
 * Adding a route that renders its own full-screen body? Add it here too.
 */
function routeOwnsViewport(pathname: string): boolean {
  return (
    pathname === "/onboarding" ||
    pathname.startsWith("/onboarding/") ||
    pathname === "/settings" ||
    pathname.startsWith("/settings/")
  );
}

export function resolveTileFindOwnerBlocker(args: {
  readonly pathname: string;
  readonly commandPaletteOpen: boolean;
  readonly systemOverlayActive: boolean;
  readonly appDialogActive: boolean;
  readonly desktopDialogActive: boolean;
  readonly migrationDialogActive: boolean;
  readonly notificationPopoverOpen: boolean;
  readonly domDialogActive: boolean;
}): TileFindOwnerBlocker | null {
  if (routeOwnsViewport(args.pathname)) {
    return { reason: "non-canvas-route", ownerId: args.pathname };
  }
  if (args.commandPaletteOpen) {
    return { reason: "command-palette", ownerId: "command-palette" };
  }
  if (args.systemOverlayActive) {
    return { reason: "system-overlay", ownerId: "system-overlay" };
  }
  if (args.appDialogActive) {
    return { reason: "app-dialog", ownerId: "app-dialog" };
  }
  if (args.desktopDialogActive) {
    return { reason: "desktop-dialog", ownerId: "desktop-dialog" };
  }
  if (args.migrationDialogActive) {
    return { reason: "migration-dialog", ownerId: "migration-dialog" };
  }
  if (args.notificationPopoverOpen) {
    return { reason: "notification-popover", ownerId: "notifications" };
  }
  if (args.domDialogActive) {
    return { reason: "dom-dialog", ownerId: "dom-dialog" };
  }
  return null;
}
