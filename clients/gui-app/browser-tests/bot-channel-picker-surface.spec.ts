import { expect, test, type Page } from "@playwright/test";

import { fixture } from "./support/fixtures.ts";
import { followSurface, type SurfaceEntry } from "./support/follow-surface.ts";

// The installed app's bot picker is a full-width surface that enters from the
// right edge. Its width, where it rests and the movement that brings it there
// are painted geometry, which jsdom does not compute. The page is the
// production surface and header over a fake host. The entry is followed
// through the drawer's own animation: geometry is sampled on every frame the
// browser reports an animation running on the surface, and the entry is over
// when the animation says so, not after a count of frames.

const PHONE = { width: 390, height: 844 };

test.use({
  viewport: PHONE,
  hasTouch: true,
  isMobile: true,
  // Animations must run: a reduced-motion setting would skip the entry and
  // leave nothing to follow.
  reducedMotion: "no-preference",
});

const PICKER = '[data-testid="bot-channel-picker"]';
const TRIGGER = '[data-testid="bot-channel-picker-trigger"]';

/** Clicks the trigger, then follows the picker's entry to where it rests. */
function openAndFollow(page: Page): Promise<SurfaceEntry> {
  return followSurface(page, { surface: PICKER, trigger: TRIGGER });
}

interface Insets {
  readonly top: number;
  readonly left: number;
  readonly right: number;
}

/** The property `index.css` reads each inset by, set on the root as the notch would. */
async function setInsets(page: Page, insets: Insets): Promise<void> {
  await page.evaluate((value: Insets) => {
    const style = document.documentElement.style;
    style.setProperty("--safe-area-inset-top", `${String(value.top)}px`);
    style.setProperty("--safe-area-inset-left", `${String(value.left)}px`);
    style.setProperty("--safe-area-inset-right", `${String(value.right)}px`);
  }, insets);
}

test("the picker enters from the right edge and rests across the full width", async ({
  page,
}) => {
  await page.goto(fixture("bot-compact-actions-menu"));
  await expect(page.locator(TRIGGER)).toBeVisible();

  const entry = await openAndFollow(page);

  // Full width: the 3/4 default and the small-screen cap both leave it short.
  expect(entry.settled.left).toBeCloseTo(0, 0);
  expect(entry.settled.width).toBeCloseTo(PHONE.width, 0);
  // Full height: it rests on the bottom edge when no keyboard is up.
  expect(entry.settled.bottom).toBeCloseTo(PHONE.height, 0);
  // From the right: while it moved, it was right of where it rests, it moved
  // only leftward, and it began with most of its width still off screen.
  expect(entry.inFlight.length).toBeGreaterThan(0);
  const lefts = entry.inFlight.map((box) => box.left);
  expect(Math.max(...lefts)).toBeGreaterThan(PHONE.width / 2);
  for (let index = 1; index < lefts.length; index += 1) {
    expect(lefts[index]).toBeLessThanOrEqual(lefts[index - 1] + 0.5);
  }
  // Not from the bottom: it never sat lower than where it rests.
  for (const box of entry.inFlight) {
    expect(box.top).toBeCloseTo(entry.settled.top, 0);
  }
});

test("the picker's bottom edge rises with the keyboard", async ({ page }) => {
  const keyboardInset = 300;
  await page.goto(fixture("bot-compact-actions-menu"));
  await expect(page.locator(TRIGGER)).toBeVisible();
  await page.evaluate((inset: number) => {
    document.documentElement.style.setProperty(
      "--keyboard-inset",
      `${String(inset)}px`,
    );
  }, keyboardInset);

  const entry = await openAndFollow(page);

  expect(entry.settled.bottom).toBeCloseTo(PHONE.height - keyboardInset, 0);
});

for (const insets of [
  { top: 47, left: 59, right: 0 },
  { top: 47, left: 0, right: 59 },
  { top: 47, left: 59, right: 34 },
] satisfies ReadonlyArray<Insets>) {
  test(`the picker keeps clear of the insets ${JSON.stringify(insets)}, and Escape removes it`, async ({
    page,
  }) => {
    await page.goto(fixture("bot-compact-actions-menu"));
    await expect(page.locator(TRIGGER)).toBeVisible();
    await setInsets(page, insets);
    // The inset took effect before anything is measured against it: the app's
    // own root reserves it as padding, which only a live property does.
    await expect
      .poll(() =>
        page
          .locator("#root")
          .evaluate((root) => getComputedStyle(root).paddingLeft),
      )
      .toBe(`${String(insets.left)}px`);

    const entry = await openAndFollow(page);

    expect(entry.settled.left).toBeGreaterThanOrEqual(insets.left - 0.5);
    expect(entry.settled.right).toBeLessThanOrEqual(
      PHONE.width - insets.right + 0.5,
    );
    expect(entry.settled.top).toBeGreaterThanOrEqual(insets.top - 0.5);
    // It still spans everything the insets leave, so a cap that is too small
    // fails as well as one that is too large.
    expect(entry.settled.width).toBeCloseTo(
      PHONE.width - insets.left - insets.right,
      0,
    );

    await page.keyboard.press("Escape");
    await expect(page.locator(PICKER)).toHaveCount(0);
  });
}

// A narrow tablet still shows the compact header, and the picker there is as
// wide as the screen leaves it, not the drawer's own 24rem side-panel cap.
for (const wide of [
  { width: 641, height: 900, insets: { top: 0, left: 0, right: 0 } },
  { width: 663, height: 900, insets: { top: 24, left: 0, right: 0 } },
  { width: 700, height: 900, insets: { top: 24, left: 20, right: 59 } },
  { width: 720, height: 900, insets: { top: 24, left: 59, right: 34 } },
  { width: 767, height: 900, insets: { top: 24, left: 59, right: 59 } },
] satisfies ReadonlyArray<{
  readonly width: number;
  readonly height: number;
  readonly insets: Insets;
}>) {
  test(`at ${String(wide.width)}px the picker rests across everything the insets leave ${JSON.stringify(wide.insets)}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: wide.width, height: wide.height });
    await page.goto(fixture("bot-compact-actions-menu"));
    await setInsets(page, wide.insets);
    // The shell reads its insets once and asks again on a resize, as a
    // rotation delivers them. The menu form, and so its trigger, is the answer
    // only with the insets taken off the width.
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await expect(page.locator(TRIGGER)).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator("#root")
          .evaluate((root) => getComputedStyle(root).paddingLeft),
      )
      .toBe(`${String(wide.insets.left)}px`);

    const entry = await openAndFollow(page);

    expect(entry.settled.left).toBeCloseTo(wide.insets.left, 0);
    expect(entry.settled.right).toBeCloseTo(wide.width - wide.insets.right, 0);
    expect(entry.settled.width).toBeCloseTo(
      wide.width - wide.insets.left - wide.insets.right,
      0,
    );
  });
}
