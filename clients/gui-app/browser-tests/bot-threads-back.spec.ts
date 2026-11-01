import { expect, test } from "@playwright/test";

import { fixture } from "./support/fixtures.ts";

// Threads takes the place of a bot's channel, and the column's channel row is
// the way back. Below the width at which the tab draws that column, the
// view's header carries its own back control, which gives the pane back to
// the channel; at that width and above it draws none. Whether a container
// query hides the control is layout, which jsdom does not compute: this
// renders the production view in a container as the bot tab's is, at a width
// on each side of the column's.

const VIEW = '[data-testid="bot-threads-view"]';
const BACK = '[data-testid="bot-threads-back"]';
const CHANNEL = '[data-testid="channel"]';

test.use({ viewport: { width: 1400, height: 900 } });

test("a tab too narrow for the column goes back to its channel from the view's own control", async ({
  page,
}) => {
  await page.goto(`${fixture("bot-threads-back")}?width=560`);
  await expect(page.locator(VIEW)).toBeVisible();
  const back = page.getByRole("button", { name: "Back to Tracy" });
  await expect(back).toBeVisible();

  await back.click();

  await expect(page.locator(VIEW)).toHaveCount(0);
  await expect(page.locator(CHANNEL)).toBeVisible();
});

test("a tab wide enough for the column draws no back control", async ({
  page,
}) => {
  await page.goto(`${fixture("bot-threads-back")}?width=1100`);
  await expect(page.locator(VIEW)).toBeVisible();
  await expect(page.locator(BACK)).toHaveCount(1);
  await expect(page.locator(BACK)).toBeHidden();
});
