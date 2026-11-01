import { expect, test, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// A bot thread's post is the first item of the replies' list (`ChatTimelineHeaderContext`),
// and it can be far taller than the pane. This renders the real chat list
// with real rows under a header that tall, in a pane 300 high, with a stand-in
// for the reply box below the list, and reads the boxes back: the list stays
// bounded by the pane, opens on its last row, reaches the start of the header,
// and the header never overlaps the first row, also when it grows after mount.

declare global {
  interface Window {
    /** The fixture's handle on the header's height, in px. */
    __setHeaderHeight?: (height: number) => void;
  }
}

const SCROLL = '[data-testid="chat-messages-scroll"]';
const HEADER = '[data-testid="tall-header"]';
const PANE = '[data-testid="chat-pane"]';
const STANDIN = '[data-testid="composer-standin"]';
const FIRST_ROW = '[data-message-id="message-0"]';
const LAST_ROW = '[data-message-id="message-47"]';
const PANE_PX = 300;
const HEADER_PX = 1_500;

test.use({ viewport: { width: 874, height: 402 } });

async function openList(page: Page): Promise<void> {
  await page.goto(
    `${fixture("chat-scroll-model")}?header=${String(HEADER_PX)}&pane=${String(PANE_PX)}`,
  );
  await expect(page.locator(SCROLL)).toBeVisible();
  await expect(page.locator(HEADER)).toBeAttached();
  // Opened on its end: a scroll before the list has settled there is undone.
  await expect(page.locator(LAST_ROW)).toBeInViewport();
  await expect(page.locator(SCROLL)).toHaveAttribute(
    "data-scroll-mode",
    "following-end",
  );
  await settled(page);
}

/**
 * Resolves once the list's geometry has not moved for a run of frames: the
 * rows it measures on opening re-flow its height and its place at the end, and
 * a scroll made before that is undone.
 */
async function settled(page: Page): Promise<void> {
  await page.locator(SCROLL).evaluate(async (node) => {
    const STABLE_FRAMES = 20;
    let last = "";
    let stable = 0;
    while (stable < STABLE_FRAMES) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
      const now = `${String(node.scrollHeight)}:${String(node.scrollTop)}`;
      stable = now === last ? stable + 1 : 0;
      last = now;
    }
  });
}

async function scrollTo(page: Page, where: "top" | "end"): Promise<void> {
  await page.locator(SCROLL).evaluate((node, target: "top" | "end") => {
    node.scrollTop = target === "top" ? 0 : node.scrollHeight;
  }, where);
  await expect(page.locator(SCROLL)).toHaveAttribute(
    "data-scroll-mode",
    where === "top" ? "free-scrolling" : "following-end",
  );
  await nextFrames(page, 3);
}

/**
 * Brings the header's bottom edge into the middle of the list, where the first
 * row (not mounted while it is far below the viewport) comes up beside it.
 */
async function scrollToHeaderBottom(page: Page): Promise<void> {
  await page.evaluate(
    (selectors: { readonly scroll: string; readonly header: string }) => {
      const scroll = document.querySelector(selectors.scroll);
      const header = document.querySelector(selectors.header);
      if (scroll === null || header === null) throw new Error("no list");
      const bottomInContent =
        header.getBoundingClientRect().bottom -
        scroll.getBoundingClientRect().top +
        scroll.scrollTop;
      scroll.scrollTop = bottomInContent - scroll.clientHeight / 2;
    },
    { scroll: SCROLL, header: HEADER },
  );
  await expect(page.locator(SCROLL)).toHaveAttribute(
    "data-scroll-mode",
    "free-scrolling",
  );
  await nextFrames(page, 3);
}

/** The header's bottom, minus the first row's top, when that row is mounted. */
async function headerOverlap(page: Page): Promise<number | null> {
  return page.evaluate(
    (selectors: { readonly header: string; readonly row: string }) => {
      const header = document.querySelector(selectors.header);
      const row = document.querySelector(selectors.row);
      if (header === null || row === null) return null;
      return (
        header.getBoundingClientRect().bottom - row.getBoundingClientRect().top
      );
    },
    { header: HEADER, row: FIRST_ROW },
  );
}

test("the header is inside the list's scroller, and the list stays bounded by the pane", async ({
  page,
}) => {
  await openList(page);
  await expect(page.locator(SCROLL).locator(HEADER)).toBeAttached();
  const boxes = await page.evaluate(
    (selectors: {
      readonly pane: string;
      readonly scroll: string;
      readonly standin: string;
    }) => {
      const box = (selector: string): DOMRect => {
        const found = document.querySelector(selector);
        if (found === null) throw new Error(`no ${selector}`);
        return found.getBoundingClientRect();
      };
      return {
        paneBottom: box(selectors.pane).bottom,
        scrollBottom: box(selectors.scroll).bottom,
        standinTop: box(selectors.standin).top,
        standinBottom: box(selectors.standin).bottom,
      };
    },
    { pane: PANE, scroll: SCROLL, standin: STANDIN },
  );
  expect(boxes.scrollBottom).toBeLessThanOrEqual(boxes.standinTop + 1);
  expect(boxes.standinBottom).toBeLessThanOrEqual(boxes.paneBottom + 1);
  const geometry = await page.locator(SCROLL).evaluate((node) => ({
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
  }));
  expect(geometry.clientHeight).toBeLessThan(PANE_PX);
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
});

test("the list opens at its end, showing the last row", async ({ page }) => {
  await openList(page);
  await expect(page.locator(LAST_ROW)).toBeInViewport();
  await expect(page.locator(HEADER)).not.toBeInViewport();
});

test("scrolling to the top reaches the start of the header, and back down the header clears the first row", async ({
  page,
}) => {
  await openList(page);
  await scrollTo(page, "top");
  await expect
    .poll(async () =>
      page.evaluate(
        (selectors: { readonly scroll: string; readonly header: string }) => {
          const scroll = document.querySelector(selectors.scroll);
          const header = document.querySelector(selectors.header);
          if (scroll === null || header === null) return null;
          return (
            header.getBoundingClientRect().top -
            scroll.getBoundingClientRect().top
          );
        },
        { scroll: SCROLL, header: HEADER },
      ),
    )
    .toBeGreaterThanOrEqual(-1);

  await scrollToHeaderBottom(page);
  await expect(page.locator(FIRST_ROW).first()).toBeAttached();
  expect(await headerOverlap(page)).toBeLessThanOrEqual(1);
});

test("a header that grows after mount does not overlap the first row", async ({
  page,
}) => {
  await openList(page);
  await scrollToHeaderBottom(page);
  await expect(page.locator(FIRST_ROW).first()).toBeAttached();
  expect(await headerOverlap(page)).toBeLessThanOrEqual(1);
  await page.evaluate((height: number) => {
    if (window.__setHeaderHeight === undefined) throw new Error("no setter");
    window.__setHeaderHeight(height);
  }, HEADER_PX * 2);
  await expect
    .poll(() =>
      page.locator(HEADER).evaluate((h) => h.getBoundingClientRect().height),
    )
    .toBe(HEADER_PX * 2);
  await nextFrames(page, 4);

  await scrollToHeaderBottom(page);
  await expect(page.locator(FIRST_ROW).first()).toBeAttached();
  expect(await headerOverlap(page)).toBeLessThanOrEqual(1);
});
