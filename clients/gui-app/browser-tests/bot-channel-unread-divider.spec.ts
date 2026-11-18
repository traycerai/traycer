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

/**
 * What the transcript's scroller shows of the divider: the scroller is the
 * divider's nearest ancestor that scrolls, and `inside` is whether the
 * divider's whole box lies within the scroller's box. With `scrollToTop`, the
 * scroller is first put at its top.
 */
async function dividerAgainstScroller(
  page: Page,
  scrollToTop: boolean,
): Promise<{ readonly inside: boolean }> {
  return page.locator(DIVIDER).evaluate((divider, toTop) => {
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
    if (toTop) scroller.scrollTop = 0;
    const box = divider.getBoundingClientRect();
    const frame = scroller.getBoundingClientRect();
    return { inside: box.top >= frame.top && box.bottom <= frame.bottom };
  }, scrollToTop);
}

test("the unread banner lands on the New divider and paints no highlight", async ({
  page,
}) => {
  await open(page);

  // The channel opens near its newest posts: put the scroller at its top, which
  // leaves the divider out of it, so the landing is the banner's and not the
  // page's opening position.
  await expect
    .poll(async () => (await dividerAgainstScroller(page, true)).inside)
    .toBe(false);

  await page.locator(BANNER).getByRole("button").first().click();
  await nextFrames(page, 3);

  await expect
    .poll(async () => (await dividerAgainstScroller(page, false)).inside)
    .toBe(true);
  await expect(page.locator(HIGHLIGHTED)).toHaveCount(0);
});
