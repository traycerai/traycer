import { expect, test, type Page } from "@playwright/test";
import { fixture } from "./support/fixtures.ts";

declare global {
  interface Window {
    __mobileHistoryPath?: () => string;
    __primarySwitcherOpen?: () => boolean;
  }
}

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

async function swipe(
  page: Page,
  fromX: number,
  toX: number,
  y: number,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: fromX, y }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: toX, y }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await cdp.detach();
}

test("panel default and history alternative respect the canvas", async ({
  page,
}, testInfo) => {
  await page.goto(fixture("mobile-swipe-navigation"));
  const drawer = page.getByTestId("mobile-nav-drawer");
  await expect(drawer).toBeAttached();
  await swipe(page, 8, 100, 300);
  await expect(drawer).toHaveAttribute("data-overlay-surface", "open");
  const width = await drawer.evaluate(
    (node) => node.getBoundingClientRect().width,
  );
  expect(width).toBeLessThan(390);
  await page.screenshot({ path: testInfo.outputPath("task-panel.png") });
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveAttribute("data-overlay-surface", "closed");
  const canvas = page.getByTestId("canvas");
  const bounds = await canvas.boundingBox();
  if (bounds === null) throw new Error("canvas missing");
  await swipe(page, 8, 100, bounds.y + bounds.height / 2);
  await expect(drawer).toHaveAttribute("data-overlay-surface", "closed");
  await page.getByLabel("Swipe for back and forward").check();
  await page.screenshot({
    path: testInfo.outputPath("history-preference.png"),
  });
  await swipe(page, 8, 100, 300);
  await expect
    .poll(() => page.evaluate(() => window.__mobileHistoryPath?.()))
    .toBe("/first");
  await swipe(page, 382, 290, 300);
  await expect
    .poll(() => page.evaluate(() => window.__mobileHistoryPath?.()))
    .toBe("/second");
  await expect(drawer).toHaveAttribute("data-overlay-surface", "closed");
});

test("the selector swipe preserves the pane engaged before edge contact", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 900, height: 400 });
  await page.goto(fixture("mobile-swipe-split"));
  const primary = page.getByTestId("mobile-epic-tile-view");
  const secondary = page.getByTestId("mobile-epic-second-tile");
  await expect(primary).toBeVisible();
  await expect(secondary).toBeVisible();
  await primary.click({ position: { x: 80, y: 15 } });
  await swipe(page, 892, 790, 15);
  await expect(page.getByTestId("mobile-tab-switcher-sheet")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__primarySwitcherOpen?.()))
    .toBe(true);
  const panel = page.getByTestId("mobile-tab-switcher-sheet");
  const panelBox = await panel.boundingBox();
  if (panelBox === null) throw new Error("selector has no box");
  const maxWidth = await page.evaluate(
    () =>
      24 *
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
  expect(panelBox.width).toBeLessThanOrEqual(maxWidth);
  await page.screenshot({ path: testInfo.outputPath("split-selector.png") });
});
