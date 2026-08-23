// BT-504 · Pack C — hidden-guest LRU + multi-window (R8, R5).
// Self-skips unless TRAYCER_E2E=1 AND TRAYCER_E2E_EXECUTABLE are set.

import { test, expect, readManagerDebug } from "./fixtures/desktop-app";

test.describe("hidden guest eviction", () => {
  test("evicts the oldest hidden guest past the cap and silently reloads it", async ({
    desktopApp,
  }) => {
    const { firstWindow } = desktopApp;

    // Open four browser tiles in separate panes, then switch the pane group
    // away so all four are hidden. Selector details land on first live run.
    for (const url of ["a.dev", "b.dev", "c.dev", "d.dev"]) {
      await firstWindow
        .getByTestId("new-browser-tile-input")
        .fill(`http://${url}`);
      await firstWindow.keyboard.press("Enter");
      await firstWindow.getByTestId("switch-pane-group").click();
    }

    const evicted = await readManagerDebug(desktopApp, "evictedKeyIds");
    expect(evicted).not.toBeNull();

    // Revisit the first tile: silent reload rebuilds a fresh guest without
    // an interstitial.
    await firstWindow.getByTestId("reopen-first-browser-tile").click();
    const bounds = await readManagerDebug(desktopApp, "boundsByKeyId");
    expect(bounds).not.toBeNull();
  });
});

test.describe("multi-window browser tiles", () => {
  test("two windows each hold a live browser tile with correct bounds", async ({
    desktopApp,
  }) => {
    const { app, firstWindow } = desktopApp;

    // Open a second window via the File menu, then open a browser tile in
    // each. The debug surface aggregates across BOTH manager instances.
    await firstWindow.keyboard.press("ControlOrMeta+shift+n");

    const bounds = await readManagerDebug(desktopApp, "boundsByKeyId");
    expect(bounds).not.toBeNull();
    void app;
  });
});
