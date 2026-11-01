import { expect, test, type Locator } from "@playwright/test";

import { fixture } from "./support/fixtures.ts";

// A long name in the level-2 menu trigger truncates inside the trigger. The
// trigger is a Button, whose own `shrink-0` left it at its intrinsic width, so
// the row's other controls were pushed off screen. Whether a flex item shrinks
// is layout, which jsdom does not compute: this renders the production bar and
// the production bot title with a very long name in a narrow container.

const ROW = '[data-testid="mobile-tile-pane-header"]';
const TRIGGER = '[data-testid="mobile-tile-menu-trigger"]';
const TITLE = '[data-testid="mobile-current-tile-title"]';
const MINIMAP = '[data-testid="content-minimap-button"]';

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function box(locator: Locator): Promise<Box> {
  const found = await locator.boundingBox();
  if (found === null) throw new Error("element has no box");
  return found;
}

function right(b: Box): number {
  return b.x + b.width;
}

test.use({ viewport: { width: 1000, height: 400 } });

for (const width of [620, 444]) {
  test(`a long tile name truncates in the trigger and leaves the minimap button inside the row at ${String(width)} wide`, async ({
    page,
  }) => {
    await page.goto(
      `${fixture("mobile-level2-menu-trigger")}?width=${String(width)}`,
    );
    await expect(page.locator(MINIMAP)).toBeVisible();

    const row = await box(page.locator(ROW));
    const trigger = await box(page.locator(TRIGGER));
    const minimap = await box(page.locator(MINIMAP));
    expect(right(trigger)).toBeLessThanOrEqual(right(row));
    expect(minimap.x).toBeGreaterThanOrEqual(row.x);
    expect(right(minimap)).toBeLessThanOrEqual(right(row));
    expect(right(trigger)).toBeLessThanOrEqual(minimap.x);
    const truncated = await page
      .locator(TITLE)
      .evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(truncated).toBe(true);
  });
}

test("a long bot name truncates in the picker and leaves its chevron and the settings button after it inside the row", async ({
  page,
}) => {
  await page.goto(
    `${fixture("mobile-level2-menu-trigger")}?surface=bot&width=444`,
  );
  const trigger = page.getByTestId("bot-channel-picker-trigger");
  await expect(trigger).toBeVisible();

  const header = await box(page.getByTestId("bot-header"));
  const h1 = await box(page.getByTestId("bot-tab-title"));
  const neighbour = await box(page.getByTestId("bot-header-neighbour"));
  const chevron = await box(trigger.locator("svg"));
  expect(chevron.x).toBeGreaterThanOrEqual(h1.x);
  expect(right(chevron)).toBeLessThanOrEqual(right(h1));
  expect(right(h1)).toBeLessThanOrEqual(right(header));
  expect(right(h1)).toBeLessThanOrEqual(neighbour.x);
  expect(right(neighbour)).toBeLessThanOrEqual(right(header));
});
