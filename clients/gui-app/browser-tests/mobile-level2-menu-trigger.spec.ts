import { expect, test, type Locator } from "@playwright/test";

import { fixture } from "./support/fixtures.ts";

// A long name in the bots picker trigger truncates inside the trigger. The
// trigger is a Button, whose own `shrink-0` left it at its intrinsic width, so
// the row's other controls were pushed off screen. Whether a flex item shrinks
// is layout, which jsdom does not compute: this renders the production bot
// title with a very long name in a narrow container.

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

test("a long bot name truncates in the picker and leaves its chevron and the settings button after it inside the row", async ({
  page,
}) => {
  await page.goto(`${fixture("mobile-level2-menu-trigger")}?width=444`);
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
