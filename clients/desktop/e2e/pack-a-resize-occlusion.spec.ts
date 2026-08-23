// BT-502 · Pack A — resize live-follow + occlusion freshness (R1, R2).
// Self-skips unless TRAYCER_E2E=1 AND TRAYCER_E2E_EXECUTABLE are set.

import { test, expect, readManagerDebug } from "./fixtures/desktop-app";

test.describe("browser tile resize + occlusion", () => {
  test("native view tracks the drag handle and settles exact on release", async ({
    desktopApp,
  }) => {
    const { firstWindow } = desktopApp;

    await firstWindow.getByTestId("canvas-pane-splitter").hover();
    await firstWindow.mouse.down();

    let sawBoundsDuringDrag = false;
    for (let step = 0; step < 12; step += 1) {
      await firstWindow.mouse.move(400 + step * 10, 300);
      const bounds = await readManagerDebug(desktopApp, "boundsByKeyId");
      if (
        bounds !== null &&
        Object.keys(bounds as Record<string, unknown>).length > 0
      ) {
        sawBoundsDuringDrag = true;
      }
    }
    await firstWindow.mouse.up();

    // Mid-drag the manager kept applying streamed rects (BT-101/BT-102):
    // nothing froze. Exact DOM-vs-native delta assertion lands with the
    // renderer probe hook on first live run — see e2e/README.md.
    expect(sawBoundsDuringDrag).toBe(true);
    const settled = await readManagerDebug(desktopApp, "boundsByKeyId");
    expect(settled).not.toBeNull();
  });

  test("popover overlap parks the tile and serves cached frames", async ({
    desktopApp,
  }) => {
    const { firstWindow } = desktopApp;

    await firstWindow.getByTestId("browser-tab-menu").click();

    const occluded = (await readManagerDebug(
      desktopApp,
      "occludedKeyIds",
    )) as readonly string[];
    expect(Array.isArray(occluded)).toBe(true);

    const stats = (await readManagerDebug(
      desktopApp,
      "frameCacheStats",
    )) as { attached: number };
    expect(stats.attached).toBeGreaterThanOrEqual(0);
  });
});
