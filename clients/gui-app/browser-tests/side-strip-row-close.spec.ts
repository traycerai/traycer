import { expect, test, type Locator, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// The vertical strip's row trailing edge in real Chrome: what jsdom cannot
// decide is what hovering and keyboard focus DO to the layout and the paint.
// The status priority and the structure (which cell holds what) are in
// `side-tab-strip.test.tsx`; here the claims are the ones only a browser
// answers - the title starts on the row's padding, an idle row's close takes
// a cell the title already leaves, a glyph fades out where the close fades in,
// and a chip stays while the close joins it.

test.use({ viewport: { width: 900, height: 700 } });

const STRIP = `${fixture("side-tab-strip")}?edge=left`;

async function openStrip(page: Page): Promise<void> {
  await page.goto(STRIP);
  await page.waitForFunction("window.__sideTabStripProbe?.ready === true");
  await nextFrames(page, 4);
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`no layout box for ${locator.toString()}`);
  return box;
}

const row = (page: Page, id: string): Locator =>
  page.getByTestId(`tab-epic-fixture-${id}`);

/** The wrapper that fades the close in and out (the button is fully opaque itself). */
const closeWrapper = (page: Page, id: string): Locator =>
  row(page, id).getByTestId(`tab-close-epic-fixture-${id}`).locator("..");

test("an idle row's title starts on the row's padding and does not move when the close appears", async ({
  page,
}) => {
  await openStrip(page);
  const zeta = row(page, "zeta");
  const title = zeta.locator(".header-tab-title-text");
  const close = closeWrapper(page, "zeta");
  const rowBox = await boxOf(zeta);
  const before = await boxOf(title);
  expect(before.x - rowBox.x).toBeCloseTo(8, 0);
  await expect(close).toHaveCSS("opacity", "0");

  await zeta.hover();

  await expect(close).toHaveCSS("opacity", "1");
  const after = await boxOf(title);
  expect(after.x).toBeCloseTo(before.x, 1);
  expect(after.width).toBeCloseTo(before.width, 1);
});

test("a chip stays when the row is hovered, and the close joins after it", async ({
  page,
}) => {
  await openStrip(page);
  const delta = row(page, "delta");
  const chip = delta.getByTestId("side-tab-failed-chip");
  const close = closeWrapper(page, "delta");
  const title = delta.locator(".header-tab-title-text");
  await expect(close).toHaveCSS("opacity", "0");
  const chipAtRest = await boxOf(chip);
  const titleAtRest = await boxOf(title);

  await delta.hover();

  await expect(close).toHaveCSS("opacity", "1");
  await expect(chip).toHaveCSS("opacity", "1");
  const chipHovered = await boxOf(chip);
  const closeBox = await boxOf(
    delta.getByTestId("tab-close-epic-fixture-delta"),
  );
  // The close takes the chip's place at the edge, the chip steps aside for it,
  // and the title gives up the same room.
  expect(closeBox.x).toBeGreaterThanOrEqual(chipHovered.x + chipHovered.width);
  expect(chipAtRest.x - chipHovered.x).toBeCloseTo(20, 0);
  expect((await boxOf(title)).width).toBeCloseTo(titleAtRest.width - 20, 0);
});

test("a glyph crossfades with the close on one axis, and the title does not move", async ({
  page,
}) => {
  await openStrip(page);
  await page.evaluate(
    'window.__sideTabStripProbe.markTitlePending("fixture-zeta", "Zeta spike")',
  );
  const zeta = row(page, "zeta");
  const spinner = zeta.getByTestId("header-tab-title-generating-fixture-zeta");
  const close = closeWrapper(page, "zeta");
  const title = zeta.locator(".header-tab-title-text");
  await expect(spinner).toBeVisible();
  const spinnerBox = await boxOf(spinner);
  const titleAtRest = await boxOf(title);

  await zeta.hover();

  await expect(close).toHaveCSS("opacity", "1");
  const glyphCell = close.locator("xpath=preceding-sibling::*[1]");
  await expect(glyphCell).toHaveCSS("opacity", "0");
  await expect(glyphCell).toHaveCSS("transition-duration", "0.1s");
  await expect(close).toHaveCSS("transition-duration", "0.1s");
  const closeBox = await boxOf(zeta.getByTestId("tab-close-epic-fixture-zeta"));
  expect(closeBox.x + closeBox.width / 2).toBeCloseTo(
    spinnerBox.x + spinnerBox.width / 2,
    0,
  );
  const titleHovered = await boxOf(title);
  expect(titleHovered.x).toBeCloseTo(titleAtRest.x, 1);
  expect(titleHovered.width).toBeCloseTo(titleAtRest.width, 1);
});

test("keyboard focus reveals the close at once, with no fade", async ({
  page,
}) => {
  await openStrip(page);
  const zeta = row(page, "zeta");
  for (let tabs = 0; tabs < 20; tabs += 1) {
    await page.keyboard.press("Tab");
    if (await zeta.evaluate((node) => node === document.activeElement)) break;
  }
  await expect(zeta).toBeFocused();

  // One frame after the focus lands, read once: a 100ms fade would still be
  // well short of 1.
  await nextFrames(page, 1);
  expect(
    await closeWrapper(page, "zeta").evaluate(
      (node) => getComputedStyle(node).opacity,
    ),
  ).toBe("1");
});
