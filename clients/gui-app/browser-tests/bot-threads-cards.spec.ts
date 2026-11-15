import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { fixture } from "./support/fixtures.ts";

// Threads shows each followed thread in full as a card (Tracy Bots T137). A
// card grows to its thread and the page is the one scroller; a card mounts
// its thread once it is within a screen of the page's view; the unread pill
// scrolls the page to the next card with new replies; on a phone the cards
// sit in one column. Each is layout or a real IntersectionObserver, which
// jsdom does not compute: this renders the production view over a scripted
// host. `?hold=` withholds the observer's reports for a card, so it keeps
// its new replies and stays a summary.

const SCROLL = '[data-testid="bot-threads-scroll"]';
const PILL = '[data-testid="bot-threads-unread-pill"]';
const BANNER = '[data-testid="bot-unread-banner"]';

function card(threadId: string): string {
  return `[data-testid="bot-thread-card"][data-thread-id="${threadId}"]`;
}

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`${fixture("bot-threads-cards")}?${query}`);
  await expect(page.locator(card("thread-release"))).toHaveAttribute(
    "data-full",
    "true",
  );
  await expect(
    page.getByText("Approve the release once ML8 is pinned?", { exact: true }),
  ).toBeVisible();
}

/**
 * Where the unread banner stands against the page's scroller and the first
 * card, and what a click at the cross's centre reaches. The banner keeps its
 * own row above the scroller; `overlapsPaintedCard` is whether it covers any
 * of the first card that is painted (the card's box clipped to the scroller,
 * since a card scrolled out of the scroller's top edge is not painted there),
 * and `clearOfCardBox` compares the unclipped box, which is only the claim at
 * rest, when the card's header is on screen.
 */
async function bannerGeometry(page: Page): Promise<{
  readonly aboveScroller: boolean;
  readonly clearOfCardBox: boolean;
  readonly overlapsPaintedCard: boolean;
  readonly crossHit: boolean;
  readonly top: number;
}> {
  return page.evaluate(
    ({ banner, scroll }) => {
      const bar = document.querySelector(banner);
      const scroller = document.querySelector(scroll);
      const cross = bar?.querySelector('[aria-label="Mark all read"]');
      const first = document.querySelector('[data-testid="bot-thread-card"]');
      if (!bar || !scroller || !cross || !first) throw new Error("no banner");
      const barBox = bar.getBoundingClientRect();
      const scrollBox = scroller.getBoundingClientRect();
      const firstBox = first.getBoundingClientRect();
      const crossBox = cross.getBoundingClientRect();
      const paintedTop = Math.max(firstBox.top, scrollBox.top);
      const paintedBottom = Math.min(firstBox.bottom, scrollBox.bottom);
      const overlapHeight =
        Math.min(barBox.bottom, paintedBottom) -
        Math.max(barBox.top, paintedTop);
      const overlapWidth =
        Math.min(barBox.right, firstBox.right, scrollBox.right) -
        Math.max(barBox.left, firstBox.left, scrollBox.left);
      const hit = document.elementFromPoint(
        crossBox.left + crossBox.width / 2,
        crossBox.top + crossBox.height / 2,
      );
      return {
        aboveScroller: barBox.bottom <= scrollBox.top + 1,
        clearOfCardBox:
          barBox.bottom <= firstBox.top + 1 ||
          barBox.top >= firstBox.bottom - 1,
        overlapsPaintedCard:
          paintedBottom > paintedTop && overlapHeight > 1 && overlapWidth > 1,
        crossHit: hit !== null && cross.contains(hit),
        top: Math.round(barBox.top),
      };
    },
    { banner: BANNER, scroll: SCROLL },
  );
}

/**
 * The banner's slot with no height of its own while the banner still paints:
 * what the page would look like had the banner not reserved its row. The
 * production DOM is used as it is; only the slot's inline style changes, and
 * `restore` puts it back.
 */
async function collapseBannerSlot(page: Page): Promise<() => Promise<void>> {
  await page.locator(BANNER).evaluate((bar) => {
    const slot = bar.parentElement;
    if (!(slot instanceof HTMLElement)) throw new Error("no banner slot");
    slot.style.height = "0px";
    slot.style.overflow = "visible";
  });
  return async () => {
    await page.locator(BANNER).evaluate((bar) => {
      const slot = bar.parentElement;
      if (!(slot instanceof HTMLElement)) throw new Error("no banner slot");
      slot.style.removeProperty("height");
      slot.style.removeProperty("overflow");
    });
  };
}

async function expectBannerClearAtRestAndScrolled(
  page: Page,
  testInfo: TestInfo,
): Promise<void> {
  const atRest = await bannerGeometry(page);
  await page.screenshot({ path: testInfo.outputPath("banner-at-rest.png") });
  expect(atRest).toMatchObject({
    aboveScroller: true,
    clearOfCardBox: true,
    overlapsPaintedCard: false,
    crossHit: true,
  });

  // The check discriminates: with the slot's row taken away the same banner
  // lies over the card, and the geometry says so.
  const restore = await collapseBannerSlot(page);
  expect(await bannerGeometry(page)).toMatchObject({
    aboveScroller: false,
    overlapsPaintedCard: true,
  });
  await restore();
  expect(await bannerGeometry(page)).toMatchObject({
    aboveScroller: true,
    overlapsPaintedCard: false,
  });

  await page.locator(SCROLL).evaluate((el) => {
    el.scrollTop = 300;
  });
  await expect
    .poll(() => page.locator(SCROLL).evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  const scrolled = await bannerGeometry(page);
  await page.screenshot({ path: testInfo.outputPath("banner-scrolled.png") });
  expect(scrolled).toMatchObject({
    aboveScroller: true,
    overlapsPaintedCard: false,
    crossHit: true,
  });
  // The banner is not part of what scrolls.
  expect(scrolled.top).toBe(atRest.top);

  await page.getByRole("button", { name: "Mark all read" }).click();
  await expect(page.locator(BANNER)).toHaveCount(0);
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 900, height: 1000 } });

  test("the page is the only scroller, and each card grows to its whole thread", async ({
    page,
  }) => {
    await open(page, "hold=thread-policy");

    const layout = await page.evaluate((scrollSelector) => {
      const view = document.querySelector('[data-testid="bot-threads-view"]');
      const scrollers = [...(view?.querySelectorAll("*") ?? [])]
        .filter((element) => {
          const { overflowY } = getComputedStyle(element);
          return (
            (overflowY === "auto" || overflowY === "scroll") &&
            element.scrollHeight > element.clientHeight + 1
          );
        })
        .map((element) => element.getAttribute("data-testid"));
      const clipped = [
        ...document.querySelectorAll('[data-testid="bot-thread-card"]'),
      ]
        .filter((element) => element.scrollHeight > element.clientHeight + 1)
        .map((element) => element.getAttribute("data-thread-id"));
      const scroller = document.querySelector(scrollSelector);
      return {
        scrollers,
        clipped,
        pageScrolls:
          scroller !== null && scroller.scrollHeight > scroller.clientHeight,
      };
    }, SCROLL);

    expect(layout).toEqual({
      scrollers: ["bot-threads-scroll"],
      clipped: [],
      pageScrolls: true,
    });
  });

  test("the unread pill scrolls the page to the next card with new replies", async ({
    page,
  }) => {
    await open(page, "hold=thread-policy");
    const pill = page.locator(PILL);
    await expect(pill).toHaveText("1 unread thread");
    const before = await page.locator(SCROLL).evaluate((el) => el.scrollTop);

    await pill.click();

    // The card comes to the page's top, or as near it as the page scrolls.
    await expect
      .poll(() =>
        page.evaluate(
          ({ scrollSelector, cardSelector }) => {
            const scroller = document.querySelector(scrollSelector);
            const target = document.querySelector(cardSelector);
            if (scroller === null || target === null) return false;
            const offset =
              target.getBoundingClientRect().top -
              scroller.getBoundingClientRect().top;
            const atEnd =
              scroller.scrollTop >=
              scroller.scrollHeight - scroller.clientHeight - 1;
            return Math.abs(offset) <= 2 || (atEnd && offset >= 0);
          },
          { scrollSelector: SCROLL, cardSelector: card("thread-policy") },
        ),
      )
      .toBe(true);
    expect(
      await page.locator(SCROLL).evaluate((el) => el.scrollTop),
    ).toBeGreaterThan(before);
  });
});

test.describe("desktop banner", () => {
  test.use({ viewport: { width: 900, height: 1000 } });

  test("the unread banner keeps its own row above the cards, at rest and while the page scrolls, and its cross can be pressed", async ({
    page,
  }, testInfo) => {
    await open(page, "hold=thread-policy");
    await expectBannerClearAtRestAndScrolled(page, testInfo);
  });
});

test.describe("a short page", () => {
  test.use({ viewport: { width: 900, height: 420 } });

  test("a card more than a screen below the view is a summary until the page scrolls near it, then its whole thread, and stays so", async ({
    page,
  }) => {
    // Every card starts as a short summary, so the far card is put beyond a
    // screen of the view by enough threads above it, whatever their height.
    await page.goto(`${fixture("bot-threads-cards")}?filler=12`);
    const far = page.locator(card("thread-lonely"));
    await expect(far).toHaveAttribute("data-full", "false");
    // Premise: the card starts more than a screen below the page's view.
    const gap = await page.evaluate(
      ({ scrollSelector, cardSelector }) => {
        const scroller = document.querySelector(scrollSelector);
        const target = document.querySelector(cardSelector);
        if (scroller === null || target === null) return null;
        const view = scroller.getBoundingClientRect();
        return target.getBoundingClientRect().top - view.bottom - view.height;
      },
      { scrollSelector: SCROLL, cardSelector: card("thread-lonely") },
    );
    expect(gap).toBeGreaterThan(0);

    await page.locator(SCROLL).evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(far).toHaveAttribute("data-full", "true");

    await page.locator(SCROLL).evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect
      .poll(() => page.locator(SCROLL).evaluate((el) => el.scrollTop))
      .toBe(0);
    await expect(far).toHaveAttribute("data-full", "true");
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the cards sit in one column inside the screen", async ({ page }) => {
    await open(page, "hold=thread-policy&phone=true");

    const columns = await page.evaluate(() => {
      const cards = [
        ...document.querySelectorAll('[data-testid="bot-thread-card"]'),
      ].map((element) => element.getBoundingClientRect());
      return {
        overflow:
          document.documentElement.scrollWidth > window.innerWidth ||
          cards.some((rect) => rect.left < 0 || rect.right > window.innerWidth),
        lefts: [...new Set(cards.map((rect) => Math.round(rect.left)))].length,
      };
    });

    expect(columns).toEqual({ overflow: false, lefts: 1 });
  });

  test("the unread banner keeps its own row above the cards, at rest and while the page scrolls, and its cross can be pressed", async ({
    page,
  }, testInfo) => {
    await open(page, "hold=thread-policy&phone=true");
    await expectBannerClearAtRestAndScrolled(page, testInfo);
  });
});
