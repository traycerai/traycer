import type { TileFindOwnerBlocker } from "@/stores/tile-find/types";

/**
 * The router only lags along: it is navigated when a tab is ACTIVATED, so a restored window legitimately sits at `/` with a focused Epic surface showing a file tile.
 * This list only has to name the routes that take the viewport away from the tab host entirely.
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
