import { expect, test, type Page } from "@playwright/test";

import { fixture } from "./support/fixtures.ts";

// The level-2 menu's plate with the installed iOS app's keyboard up. The app
// overlays the keyboard on a window that keeps its height, so the plate, sized
// to the room under its trigger, ran under the keyboard until the keyboard
// came off the bottom of that room. The plate's height is layout, which jsdom
// does not compute: this opens the production menu around a list taller than
// the window and raises the keyboard the way the native bridge does.

declare global {
  interface Window {
    __level2Keyboard?: { readonly raise: (inset: number) => void };
  }
}

const TRIGGER = '[data-testid="level2-trigger"]';
const MENU = '[data-testid="level2-menu"]';
const WINDOW_HEIGHT = 440;
const KEYBOARD_INSET = 208;

test.use({ viewport: { width: 956, height: WINDOW_HEIGHT } });

async function openMenu(page: Page): Promise<void> {
  await page.goto(fixture("mobile-level2-menu-content"));
  await page.locator(TRIGGER).click();
  await expect(page.locator(MENU)).toBeVisible();
  // The plate zooms and slides in; its box is its own once that settles.
  await page.waitForFunction("document.getAnimations().length === 0");
}

async function menuBox(page: Page) {
  const box = await page.locator(MENU).boundingBox();
  if (box === null) throw new Error("menu has no box");
  return box;
}

test("ends at the keyboard's top when the keyboard rises into it, under the same trigger", async ({
  page,
}) => {
  await openMenu(page);
  const before = await menuBox(page);
  const keyboardTop = WINDOW_HEIGHT - KEYBOARD_INSET;
  // Without the keyboard the plate runs past where the keyboard will be.
  expect(before.y + before.height).toBeGreaterThan(keyboardTop);

  await page.evaluate((inset) => {
    window.__level2Keyboard?.raise(inset);
  }, KEYBOARD_INSET);
  await expect
    .poll(async () => {
      const box = await menuBox(page);
      return box.y + box.height;
    })
    .toBeLessThanOrEqual(keyboardTop + 0.5);
  // It shortens under its trigger; it does not flip or slide over it.
  expect((await menuBox(page)).y).toBeCloseTo(before.y, 0);
});
