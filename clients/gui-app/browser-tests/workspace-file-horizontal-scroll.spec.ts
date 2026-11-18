import { expect, test, type Locator, type Page } from "@playwright/test";

import { centreOf, fixture } from "./support/fixtures.ts";

declare global {
  interface Window {
    __workspaceFileHorizontalScrollProbe: {
      setWordWrap: (wordWrap: boolean) => void;
    };
  }
}

// The workspace file tile's source view, on the real Pierre renderer in Chrome.
//
// Unwrapped, Diffs gives its code area (`[data-code]`, inside a shadow root) its
// own horizontal scroll box, nested in the tile's `overflow-auto` scroller, and
// stops horizontal overscroll there. That box only exists if the renderer's grid
// cell can be narrower than its content: a cell that grows to the widest line
// leaves the code area exactly as wide as its text, so a trusted horizontal
// wheel over the code has nothing to scroll and nowhere to chain. Layout and
// native wheel scrolling are what jsdom cannot decide.

test.use({ viewport: { width: 1000, height: 800 } });

const WHEEL_DISTANCE = 400;

function scroller(page: Page): Locator {
  return page.getByTestId("workspace-file-scroller");
}

function codeArea(page: Page): Locator {
  return page.locator("diffs-container [data-code]");
}

async function openLongFile(page: Page): Promise<void> {
  await page.goto(fixture("workspace-file-horizontal-scroll"));
  await expect(
    codeArea(page).locator("[data-line]").first(),
    "the painted file",
  ).toBeAttached();
}

async function wheelOverCode(
  page: Page,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  const { x, y } = await centreOf(scroller(page));
  await page.mouse.move(x, y);
  await page.mouse.wheel(deltaX, deltaY);
}

test("a horizontal wheel over the code scrolls the code, not the tile", async ({
  page,
}) => {
  await openLongFile(page);
  await expect
    .poll(
      () =>
        codeArea(page).evaluate((node) => node.scrollWidth - node.clientWidth),
      { message: "the code area's horizontal range" },
    )
    .toBeGreaterThan(0);

  await wheelOverCode(page, WHEEL_DISTANCE, 0);

  await expect
    .poll(() => codeArea(page).evaluate((node) => node.scrollLeft))
    .toBeGreaterThan(0);
  expect(
    await scroller(page).evaluate((node) => node.scrollLeft),
    "the tile's own scroller stays put, so the gutter stays pinned",
  ).toBe(0);
});

test("a vertical wheel over long lines scrolls the tile and leaves the code in place", async ({
  page,
}) => {
  await openLongFile(page);

  await wheelOverCode(page, 0, WHEEL_DISTANCE);

  await expect
    .poll(() => scroller(page).evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  expect(await codeArea(page).evaluate((node) => node.scrollLeft)).toBe(0);
});

test("wrapped long lines leave nothing to scroll sideways", async ({
  page,
}) => {
  await openLongFile(page);

  await page.evaluate(() =>
    window.__workspaceFileHorizontalScrollProbe.setWordWrap(true),
  );

  await expect
    .poll(
      () =>
        codeArea(page).evaluate((node) => node.scrollWidth - node.clientWidth),
      { message: "the code area's horizontal range once lines wrap" },
    )
    .toBe(0);
  expect(
    await scroller(page).evaluate(
      (node) => node.scrollWidth - node.clientWidth,
    ),
    "the tile's horizontal range once lines wrap",
  ).toBe(0);
});
