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
// boundary. The form is read back from the page: the title picker's trigger
// exists in the menu form and the column's pane exists in the column form.

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

/** The two-tile menu form: the title is the picker, there is no column, and the rail is drawn. */
async function expectTwoTileMenu(page: Page): Promise<void> {
  await expect(page.locator(TRIGGER)).toBeVisible();
  await expect(page.locator(RAIL)).toBeVisible();
  await expect(page.locator(COLUMN)).toHaveCount(0);
}

function openAndFollow(page: Page): Promise<SurfaceEntry> {
  return followSurface(page, { surface: PICKER, trigger: TRIGGER });
}

/** What the picker rests across, whichever panes sit beneath it. */
function expectRestsAcross(
  entry: SurfaceEntry,
  size: Size,
  insets: Insets,
  bottom: number,
): void {
  expect(entry.settled.left).toBeCloseTo(insets.left, 0);
  expect(entry.settled.right).toBeCloseTo(size.width - insets.right, 0);
  expect(entry.settled.width).toBeCloseTo(
    size.width - insets.left - insets.right,
    0,
  );
  expect(entry.settled.bottom).toBeCloseTo(bottom, 0);
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
  // The form is the two-tile menu only with the insets taken off the width
  // (931 here), so it is read again after the shell asks for them.
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

test("on a 1024 by 768 device with the expanded strip the picker rests across the full width", async ({
  page,
}) => {
  const size = { width: 1024, height: 768 };
  await openPage(page, size, "expanded");
  await expectTwoTileMenu(page);

  const entry = await openAndFollow(page);

  expectRestsAcross(entry, size, NO_INSETS, size.height);
});

// One pixel under the boundary the same page, with the same rail open, is the
// one-tile column form: there is no picker to measure, and the column draws.
test("one pixel under the boundary the rail does not make the form two-tile", async ({
  page,
}) => {
  await openPage(page, { width: 827, height: 600 }, "collapsed");

  await expect(page.locator(COLUMN)).toBeVisible();
  await expect(page.locator(TRIGGER)).toHaveCount(0);
});
