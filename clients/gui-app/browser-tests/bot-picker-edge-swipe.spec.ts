import { expect, test, type Page } from "@playwright/test";

import { swipeHorizontally } from "./support/touch.ts";
import { fixture, nextFrames } from "./support/fixtures.ts";

// The Tracy channel picker opens on a swipe from the trailing edge, through the
// shell's one edge recognizer, and stays put under further edge swipes. Touch
// input, the recognizer and the modal barrier an open drawer raises are what
// jsdom cannot stand in for: the barrier is the library's own, set on `body`
// while the drawer is open, and only a real drawer in a real browser shows
// that the recognizer reads it.

declare global {
  interface Window {
    __pickerSwipeOpens?: number;
    __mobileNavOpen?: () => boolean;
  }
}

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  reducedMotion: "no-preference",
});

const PICKER = '[data-testid="bot-channel-picker"]';
const TRIGGER = '[data-testid="bot-channel-picker-trigger"]';

test("a swipe from the trailing edge opens the picker", async ({ page }) => {
  await page.goto(fixture("bot-picker-edge-swipe"));
  await expect(page.locator(TRIGGER)).toBeVisible();
  await expect(page.locator(PICKER)).toHaveCount(0);

  await swipeHorizontally(page, 382, 290, 300);

  await expect(page.locator(PICKER)).toBeVisible();
  expect(await page.evaluate(() => window.__pickerSwipeOpens)).toBe(1);
});

/** Opens the picker with its trigger and waits for the barrier the recognizer reads. */
async function openPicker(page: Page): Promise<void> {
  await page.goto(fixture("bot-picker-edge-swipe"));
  await page.locator(TRIGGER).click();
  await expect(page.locator(PICKER)).toBeVisible();
  // The barrier the recognizer reads: the library's own, on the document.
  await expect
    .poll(() => page.evaluate(() => document.body.style.pointerEvents))
    .toBe("none");
}

test.describe("a real touch over the open picker", () => {
  // INWARD only. For a right drawer, vaul's release treats a drag whose
  // `pointerStart - pageX` is positive (leftward, here 382 - 290 = +92) as a
  // drag back toward open: it takes the "Moved upwards, don't do anything"
  // branch and calls `resetDrawer()`, never `closeDrawer()`, whatever the
  // distance or speed (vaul 1.1.2, `onRelease`). The margin is the sign of the
  // drag, so no threshold is involved. A rightward drag is the dismiss
  // direction and is not asserted on here.
  test("an inward swipe from the trailing edge leaves it open and reaches neither action", async ({
    page,
  }) => {
    await openPicker(page);

    await swipeHorizontally(page, 382, 290, 300);
    await nextFrames(page, 2);

    await expect(page.locator(PICKER)).toBeVisible();
    expect(await page.evaluate(() => window.__pickerSwipeOpens)).toBe(0);
    expect(await page.evaluate(() => window.__mobileNavOpen?.())).toBe(false);
  });

  // A rightward drag over a right drawer is vaul's own dismiss gesture and may
  // close the picker, so this case asserts only that the shell does not open
  // the task drawer. It does not assert whether the picker stays open.
  test("a rightward swipe from the leading edge does not open the task drawer", async ({
    page,
  }) => {
    await openPicker(page);

    await swipeHorizontally(page, 8, 100, 300);
    await nextFrames(page, 2);

    expect(await page.evaluate(() => window.__mobileNavOpen?.())).toBe(false);
  });
});
