// BT-503 · Pack B — reserved-chord keyboard routing (R6).
// Self-skips unless TRAYCER_E2E=1 AND TRAYCER_E2E_EXECUTABLE are set.

import { test, expect } from "./fixtures/desktop-app";

test.describe("reserved chords with focused browser tile", () => {
  test("mod+k opens the command palette while the guest has focus", async ({
    desktopApp,
  }) => {
    const { firstWindow } = desktopApp;

    // Click into a browser tile so the guest owns keyboard focus.
    await firstWindow.getByTestId("browser-tile-surface").click();

    await firstWindow.keyboard.press("ControlOrMeta+k");

    const palette = firstWindow.getByRole("dialog", {
      name: /command palette/i,
    });
    await expect(palette).toBeVisible({ timeout: 5_000 });
  });

  test("unreserved keystrokes still reach the page (no palette)", async ({
    desktopApp,
  }) => {
    const { firstWindow } = desktopApp;

    await firstWindow.getByTestId("browser-tile-surface").click();
    await firstWindow.keyboard.press("ControlOrMeta+t");

    const palette = firstWindow.getByRole("dialog", {
      name: /command palette/i,
    });
    await expect(palette).toBeHidden();
  });
});
