import { expect, test, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// The level-2 menu with the installed iOS app's keyboard up. The app overlays
// the keyboard on a window that keeps its height, so the menu's 70dvh plate ran
// under it: on the Pro Max in landscape (440 tall, keyboard 208) the plate was
// 308 tall and its lower 151px sat under the keyboard. The plate's height is
// layout, which jsdom does not compute: this opens the production menu in the
// fixture and raises the keyboard the way the native bridge does.

declare global {
  interface Window {
    __level2Keyboard?: { readonly raise: (inset: number) => void };
  }
}

const TRIGGER = '[data-testid="mobile-tile-menu-trigger"]';
const MENU = '[data-testid="mobile-tile-menu"]';
const WINDOW_HEIGHT = 440;

test.use({ viewport: { width: 956, height: WINDOW_HEIGHT } });

async function openMenu(page: Page): Promise<void> {
  await page.goto(`${fixture("mobile-level2-menu-trigger")}?width=444`);
  await page.locator(TRIGGER).click();
  await expect(page.locator(MENU)).toBeVisible();
  // The plate zooms and slides in; its box is its own once that settles.
  await page.waitForFunction("document.getAnimations().length === 0");
}

async function raiseKeyboard(page: Page, inset: number): Promise<void> {
  await page.evaluate((value) => {
    window.__level2Keyboard?.raise(value);
  }, inset);
}

async function menuBox(page: Page) {
  const box = await page.locator(MENU).boundingBox();
  if (box === null) throw new Error("menu has no box");
  return box;
}

test("ends at the keyboard's top when the keyboard rises into it", async ({
  page,
}) => {
  await openMenu(page);
  const before = await menuBox(page);
  const keyboardTop = WINDOW_HEIGHT - 208;
  expect(before.y + before.height).toBeGreaterThan(keyboardTop);

  await raiseKeyboard(page, 208);
  await expect
    .poll(async () => {
      const box = await menuBox(page);
      return box.y + box.height;
    })
    .toBeLessThanOrEqual(keyboardTop + 0.5);
  // It shortens under its trigger; it does not flip or slide over it.
  expect((await menuBox(page)).y).toBeCloseTo(before.y, 0);
});

test("keeps its 70dvh where the keyboard leaves room for it", async ({
  page,
}) => {
  await openMenu(page);
  await raiseKeyboard(page, 60);
  await nextFrames(page, 2);
  expect((await menuBox(page)).height).toBeCloseTo(WINDOW_HEIGHT * 0.7, 0);
});
