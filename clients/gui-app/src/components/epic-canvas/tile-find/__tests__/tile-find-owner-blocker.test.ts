import { describe, expect, it } from "vitest";
import { resolveTileFindOwnerBlocker } from "@/components/epic-canvas/tile-find/tile-find-owner-blocker";

const CLEAR = {
  commandPaletteOpen: false,
  systemOverlayActive: false,
  appDialogActive: false,
  desktopDialogActive: false,
  migrationDialogActive: false,
  notificationPopoverOpen: false,
  domDialogActive: false,
} as const;

describe("resolveTileFindOwnerBlocker", () => {
  // The regression from traycerai/traycer#592: `TopLevelTabHost` mounts the
  // restored Epic surface from the tabs store, and the router is only navigated
  // when a tab is ACTIVATED. A restored window therefore sits at `/` with a
  // focused Epic surface and an open file tile, and the old epic-path allow-list
  // blocked ownership there - killing select-all AND find in the app's normal
  // startup state.
  it("does not block the restored canvas at the root pathname", () => {
    expect(resolveTileFindOwnerBlocker({ ...CLEAR, pathname: "/" })).toBe(null);
  });

  it("does not block routes whose signed-in body renders nothing", () => {
    for (const pathname of [
      "/",
      "/epics",
      "/epics/epic-1/tab-1",
      "/draft/draft-1",
      "/draft/new",
    ]) {
      expect(resolveTileFindOwnerBlocker({ ...CLEAR, pathname })).toBe(null);
    }
  });

  it("blocks routes that paint their own body over the tab host", () => {
    for (const pathname of [
      "/onboarding",
      "/settings",
      "/settings/general",
      "/settings/keybindings",
    ]) {
      expect(resolveTileFindOwnerBlocker({ ...CLEAR, pathname })).toEqual({
        reason: "non-canvas-route",
        ownerId: pathname,
      });
    }
  });

  it("keeps every overlay blocker, including at the root pathname", () => {
    expect(
      resolveTileFindOwnerBlocker({
        ...CLEAR,
        pathname: "/",
        commandPaletteOpen: true,
      }),
    ).toEqual({ reason: "command-palette", ownerId: "command-palette" });

    expect(
      resolveTileFindOwnerBlocker({
        ...CLEAR,
        pathname: "/",
        systemOverlayActive: true,
      }),
    ).toEqual({ reason: "system-overlay", ownerId: "system-overlay" });

    expect(
      resolveTileFindOwnerBlocker({
        ...CLEAR,
        pathname: "/epics/epic-1/tab-1",
        notificationPopoverOpen: true,
      }),
    ).toEqual({ reason: "notification-popover", ownerId: "notifications" });

    expect(
      resolveTileFindOwnerBlocker({
        ...CLEAR,
        pathname: "/",
        domDialogActive: true,
      }),
    ).toEqual({ reason: "dom-dialog", ownerId: "dom-dialog" });
  });

  it("prefers the route body over an overlay when both apply", () => {
    expect(
      resolveTileFindOwnerBlocker({
        ...CLEAR,
        pathname: "/settings/general",
        appDialogActive: true,
      }),
    ).toEqual({ reason: "non-canvas-route", ownerId: "/settings/general" });
  });
});
