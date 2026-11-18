import { expect, test, type Page } from "@playwright/test";

import { fixture } from "./support/fixtures.ts";
import { followSurface, type SurfaceEntry } from "./support/follow-surface.ts";
import { setInsets, type Insets } from "./support/viewport-insets.ts";

// The installed app draws the channel picker as a modal sheet over everything
// the safe-area insets leave, and a second tile (the rail beside the channel)
// does not change that: the sheet is portalled and fixed, so it covers both
// panes. This spec measures it in the REAL two-tile menu form. The page opens
// the memory rail through the real store, and the width decides the form: the
// two-tile menu begins at 828 on the collapsed strip (60 + 2 x 384) and at
// 1008 on the expanded one (240 + 2 x 384). A width of 768 alone cannot reach
// it (the one-tile column form shows there), so the cases are the two sides of
// a 1024 by 768 device, with and without side insets, and the 828 / 827
// boundary. The expanded strip's boundary is held from below, at 1007, and the
// insets that move a width across the 828 boundary have a case of their own. The
// form is read back from the page: the title picker's trigger exists in the menu
// form and the column's pane exists in the column form.

test.use({
  hasTouch: true,
  isMobile: true,
  // Animations must run: a reduced-motion setting would skip the entry and
  // leave nothing to follow.
  reducedMotion: "no-preference",
});

const PICKER = '[data-testid="bot-channel-picker"]';
const TRIGGER = '[data-testid="bot-channel-picker-trigger"]';
const COLUMN = '[data-testid="bot-channel-sidebar-pane"]';
const RAIL = '[data-testid="bot-memory-panel"]';
const CHANNEL = '[data-testid="bot-channel"]';

interface Size {
  readonly width: number;
  readonly height: number;
}

async function openPage(
  page: Page,
  size: Size,
  strip: "collapsed" | "expanded",
): Promise<void> {
  await page.setViewportSize(size);
  await page.goto(`${fixture("bot-picker-two-tile")}?strip=${strip}`);
}

/**
 * The two-tile menu form: the title is the picker, there is no column, and
 * both panes (the channel and the rail beside it) are drawn.
 */
async function expectTwoTileMenu(page: Page): Promise<void> {
  await expect(page.locator(TRIGGER)).toBeVisible();
  await expect(page.locator(CHANNEL)).toBeVisible();
  await expect(page.locator(RAIL)).toBeVisible();
  await expect(page.locator(COLUMN)).toHaveCount(0);
}

/**
 * The one-tile form with the rail open: the rail takes the pane on its own, the
 * channel stays mounted but hidden, the column draws, and there is no picker
 * trigger.
 */
async function expectOneTileColumn(page: Page): Promise<void> {
  await expect(page.locator(RAIL)).toBeVisible();
  await expect(page.locator(CHANNEL)).toHaveCount(1);
  await expect(page.locator(CHANNEL)).toBeHidden();
  await expect(page.locator(COLUMN)).toBeVisible();
  await expect(page.locator(TRIGGER)).toHaveCount(0);
}

function openAndFollow(page: Page): Promise<SurfaceEntry> {
  return followSurface(page, { surface: PICKER, trigger: TRIGGER });
}

/**
 * What the picker rests across, whichever panes sit beneath it: every edge in
 * one comparison, so a failure prints them all.
 */
function expectRestsAcross(
  entry: SurfaceEntry,
  size: Size,
  insets: Insets,
  bottom: number,
): void {
  expect({
    top: Math.round(entry.settled.top),
    left: Math.round(entry.settled.left),
    right: Math.round(entry.settled.right),
    bottom: Math.round(entry.settled.bottom),
  }).toEqual({
    top: insets.top,
    left: insets.left,
    right: size.width - insets.right,
    bottom,
  });
}

const NO_INSETS: Insets = { top: 0, left: 0, right: 0 };

for (const device of [
  { name: "at the 828 boundary", size: { width: 828, height: 600 } },
  { name: "on a 1024 by 768 device", size: { width: 1024, height: 768 } },
]) {
  test(`${device.name}, the picker rests across the full width over both panes`, async ({
    page,
  }) => {
    await openPage(page, device.size, "collapsed");
    await expectTwoTileMenu(page);

    const entry = await openAndFollow(page);

    expectRestsAcross(entry, device.size, NO_INSETS, device.size.height);
  });
}

test("on a 1024 by 768 device the picker's bottom edge rises with the keyboard", async ({
  page,
}) => {
  const size = { width: 1024, height: 768 };
  const keyboardInset = 300;
  await openPage(page, size, "collapsed");
  await expectTwoTileMenu(page);
  await page.evaluate((inset: number) => {
    document.documentElement.style.setProperty(
      "--keyboard-inset",
      `${String(inset)}px`,
    );
  }, keyboardInset);

  const entry = await openAndFollow(page);

  expectRestsAcross(entry, size, NO_INSETS, size.height - keyboardInset);
});

test("on a 1024 by 768 device with side insets the picker rests across everything they leave", async ({
  page,
}) => {
  const size = { width: 1024, height: 768 };
  const insets: Insets = { top: 24, left: 59, right: 34 };
  await openPage(page, size, "collapsed");
  await setInsets(page, insets);
  // The insets reach the shell by a resize. With them off the width (931) the
  // form is still the two-tile menu; the case below is the one they change.
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await expect
    .poll(() =>
      page
        .locator("#root")
        .evaluate((root) => getComputedStyle(root).paddingLeft),
    )
    .toBe(`${String(insets.left)}px`);
  await expectTwoTileMenu(page);

  const entry = await openAndFollow(page);

  expectRestsAcross(entry, size, insets, size.height);
});

// The fixture draws no strip, so the expanded preference shows only in the width
// rule: the expanded strip is 240, so two tiles need 1008. At 1007 the expanded
// strip gives one tile, where the collapsed strip (828) gives two. A page that
// ignored `?strip=expanded` would show the two-tile menu here.
test("with the expanded strip one pixel under 1008 is the one-tile form", async ({
  page,
}) => {
  await openPage(page, { width: 1007, height: 768 }, "expanded");

  await expectOneTileColumn(page);
});

// 860 is two tiles on the collapsed strip. Insets of 20 and 13 leave 827, which
// is not, but only once the shell has asked for them again: it reads them once
// and again on a resize. The page is two-tile first, so the form changing is
// what the case shows.
test("insets that bring the content width to 827 change the form to one tile", async ({
  page,
}) => {
  await openPage(page, { width: 860, height: 600 }, "collapsed");
  await expectTwoTileMenu(page);

  const insets: Insets = { top: 0, left: 20, right: 13 };
  await setInsets(page, insets);
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));

  await expectOneTileColumn(page);
});

// One pixel under the boundary the same page, with the same rail open, is the
// one-tile form. The channel is hidden by `channelBesideRailClass` answering
// "hidden" for one tile, which needs a tile count from the installed app's
// placement (the container-query branch would hide it at this width as well, so
// the column drawing, which only the installed form does, is what shows the
// count is not null). The rail being drawn is what shows it was set, so the case
// cannot pass on a page where the rail never opened.
test("one pixel under the boundary the rail does not make the form two-tile", async ({
  page,
}) => {
  await openPage(page, { width: 827, height: 600 }, "collapsed");

  await expectOneTileColumn(page);
});
