import { expect, test, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// A channel with unread posts draws a "New" divider above the first one, and
// the unread banner lands on that divider without painting a highlight on any
// post. Where the divider sits against the transcript's scroller is layout,
// which jsdom does not compute: this renders the production channel over the
// scripted host of the Threads fixture (`?surface=channel`), whose read cursor
// stands behind two posts by another member. `?filler=` lengthens the channel
// so the unread posts start well below the top.

const BANNER = '[data-testid="bot-unread-banner"]';
const DIVIDER = "[data-unread-divider]";
const HIGHLIGHTED = "[data-navigation-highlighted]";

async function open(page: Page): Promise<void> {
  await page.goto(`${fixture("bot-threads-cards")}?surface=channel&filler=40`);
  await expect(page.locator(BANNER)).toBeVisible();
  await expect(page.locator(DIVIDER)).toHaveCount(1);
}

/** Whether the divider's box lies inside its nearest scrolling ancestor. */
async function dividerInScroller(page: Page): Promise<boolean> {
  return page.locator(DIVIDER).evaluate((divider) => {
    let scroller: HTMLElement | null = divider.parentElement;
    while (
      scroller !== null &&
      !(
        scroller.scrollHeight > scroller.clientHeight &&
        /(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
      )
    ) {
      scroller = scroller.parentElement;
    }
    if (scroller === null) throw new Error("no scroller above the divider");
    const box = divider.getBoundingClientRect();
    const frame = scroller.getBoundingClientRect();
    return box.top >= frame.top && box.bottom <= frame.bottom;
  });
}

test("the unread banner lands on the New divider and paints no highlight", async ({
  page,
}) => {
  await open(page);

  await page.locator(BANNER).getByRole("button").first().click();
  await nextFrames(page, 3);

  await expect.poll(() => dividerInScroller(page)).toBe(true);
  await expect(page.locator(HIGHLIGHTED)).toHaveCount(0);
});
