import { expect, test, type Locator, type Page } from "@playwright/test";

import { fixture } from "./support/fixtures.ts";

// Two real Word viewers side by side (real `docx-preview`, real Chrome).
//
// The viewers render into shadow roots, fit their pages to the tile's width,
// scroll to a page by pixel arithmetic, and paint find-in-document matches
// through the CSS Custom Highlight registry - a single page-wide namespace two
// viewers can collide in. Fit-to-width, a 16px page gutter, where a select-all
// range is allowed to reach and whose highlights survive whose search are all
// layout, selection and painting behaviours jsdom has none of. Claims, each on
// its own page load:
//
//   - fit-to-width follows each tile's resize, narrow and wide;
//   - zooming in scales the wide document up;
//   - going to the next page after a zoom keeps the 16px page gutter;
//   - select-all stays inside the active viewer's own shadow root;
//   - two viewers' search highlights do not share a name or clear each other;
//   - closing one viewer's search leaves the other's highlights registered.

type TileId = "alpha" | "beta";

// Wide enough for the inline search button, while keeping beta's toolbar
// inside the viewport for a real pointer click.
const SEARCH_TILE_WIDTH = 700;
const NARROW_TILE_WIDTH = 280;
const WIDE_TILE_WIDTH = 1400;
// The gutter above a page that "go to page" must leave, and what the
// measurement may be off by.
const PAGE_GUTTER_PX = 16;
const MEASUREMENT_TOLERANCE_PX = 2;

test.use({ viewport: { width: 2200, height: 900 } });

function tile(page: Page, id: TileId): Locator {
  return page.locator(`[data-word-tile="${id}"]`);
}

function docxHost(page: Page, id: TileId): Locator {
  return tile(page, id).locator('[data-testid="docx-preview-host"]');
}

function pagesOf(page: Page, id: TileId): Locator {
  return docxHost(page, id).locator("section.docx");
}

function wrapperOf(page: Page, id: TileId): Locator {
  return docxHost(page, id).locator(".docx-wrapper");
}

async function openViewers(page: Page): Promise<void> {
  await page.goto(fixture("docx-preview-browser-regression"));
  await expect(
    page.locator('[data-word-tile] [data-testid="docx-preview-container"]'),
    "both real docx-preview documents",
  ).toHaveCount(2);
  for (const id of ["alpha", "beta"] as const) {
    await expect(
      pagesOf(page, id),
      `the ${id} document's three pages`,
    ).toHaveCount(3);
  }
}

async function resizeTile(
  page: Page,
  id: TileId,
  width: number,
): Promise<void> {
  await tile(page, id).evaluate((element, pixels) => {
    if (element instanceof HTMLElement) element.style.width = `${pixels}px`;
  }, width);
}

interface FitReading {
  readonly clientWidth: number;
  readonly scrollWidth: number;
  readonly wrapperWidth: number;
}

async function fitOf(page: Page, id: TileId): Promise<FitReading> {
  return page.evaluate((tileId) => {
    const scope = document.querySelector(`[data-word-tile="${tileId}"]`);
    const container = scope?.querySelector(
      '[data-testid="docx-preview-container"]',
    );
    const wrapper = scope
      ?.querySelector('[data-testid="docx-preview-host"]')
      ?.shadowRoot?.querySelector(".docx-wrapper");
    if (
      !(container instanceof HTMLElement) ||
      !(wrapper instanceof HTMLElement)
    ) {
      throw new Error(`the ${tileId} viewer has no container or wrapper`);
    }
    return {
      clientWidth: container.clientWidth,
      scrollWidth: container.scrollWidth,
      wrapperWidth: wrapper.getBoundingClientRect().width,
    };
  }, id);
}

function fits(reading: FitReading): boolean {
  return (
    reading.scrollWidth <= reading.clientWidth + MEASUREMENT_TOLERANCE_PX &&
    reading.wrapperWidth <=
      reading.clientWidth - PAGE_GUTTER_PX * 2 + MEASUREMENT_TOLERANCE_PX
  );
}

/** The narrow alpha and the wide beta, each with its document fitted to it. */
async function resizeAndFit(page: Page): Promise<void> {
  await resizeTile(page, "alpha", NARROW_TILE_WIDTH);
  await resizeTile(page, "beta", WIDE_TILE_WIDTH);
  await expect
    .poll(
      async () =>
        fits(await fitOf(page, "alpha")) && fits(await fitOf(page, "beta")),
      { message: "fit-to-width after narrow and wide tile resize" },
    )
    .toBe(true);
}

async function zoomOf(page: Page, id: TileId): Promise<number> {
  return Number(
    await wrapperOf(page, id).evaluate((element) => element.style.zoom),
  );
}

async function searchAndType(
  page: Page,
  id: TileId,
  query: string,
): Promise<void> {
  await tile(page, id).locator('[aria-label="Search document"]').click();
  await expect(
    tile(page, id).locator('input[aria-label="Find in document"]'),
    `${id} search input`,
  ).toBeVisible();
  await page.keyboard.insertText(query);
  await expect(
    tile(page, id).locator('[aria-live="polite"]').first(),
    `${id} search result`,
  ).toHaveText("1 / 1");
}

/** The highlight registry names that hold a range inside this viewer's shadow root. */
async function highlightNames(page: Page, id: TileId): Promise<string[]> {
  return page.evaluate((tileId) => {
    const shadow = document.querySelector(
      `[data-word-tile="${tileId}"] [data-testid="docx-preview-host"]`,
    )?.shadowRoot;
    if (shadow === null || shadow === undefined) return [];
    const names: string[] = [];
    for (const [name, highlight] of CSS.highlights) {
      if (
        [...highlight].some(
          (range) => range.startContainer.getRootNode() === shadow,
        )
      ) {
        names.push(name);
      }
    }
    return names;
  }, id);
}

async function stillRegistered(page: Page, names: string[]): Promise<boolean> {
  return page.evaluate(
    (registered) => registered.every((name) => CSS.highlights.has(name)),
    names,
  );
}

async function openBothSearches(page: Page): Promise<{
  readonly alpha: string[];
  readonly beta: string[];
}> {
  await openViewers(page);
  await resizeTile(page, "alpha", SEARCH_TILE_WIDTH);
  await resizeTile(page, "beta", SEARCH_TILE_WIDTH);
  await expect(
    page.locator('[data-word-tile] [aria-label="Search document"]'),
    "wide toolbars for independent searches",
  ).toHaveCount(2);
  await searchAndType(page, "alpha", "ALPHA-SEARCH");
  const alpha = await highlightNames(page, "alpha");
  expect(
    alpha.length,
    "alpha search painted no CSS highlights",
  ).toBeGreaterThan(0);
  await searchAndType(page, "beta", "BETA-SEARCH");
  const beta = await highlightNames(page, "beta");
  expect(beta.length, "beta search painted no CSS highlights").toBeGreaterThan(
    0,
  );
  return { alpha, beta };
}

test("fit-to-width follows each tile's resize, narrow and wide", async ({
  page,
}) => {
  await openViewers(page);
  await resizeAndFit(page);

  const alpha = await fitOf(page, "alpha");
  const beta = await fitOf(page, "beta");
  const readings = JSON.stringify({ alpha, beta });
  expect(
    alpha.clientWidth,
    `narrow tile was not narrower: ${readings}`,
  ).toBeLessThan(beta.clientWidth);
  expect(
    alpha.scrollWidth,
    `narrow tile overflows horizontally: ${JSON.stringify(alpha)}`,
  ).toBeLessThanOrEqual(alpha.clientWidth + MEASUREMENT_TOLERANCE_PX);
  expect(
    beta.scrollWidth,
    `wide tile overflows horizontally: ${JSON.stringify(beta)}`,
  ).toBeLessThanOrEqual(beta.clientWidth + MEASUREMENT_TOLERANCE_PX);
});

test("zooming in scales the wide document up", async ({ page }) => {
  await openViewers(page);
  await resizeAndFit(page);

  const before = await zoomOf(page, "beta");
  expect(
    Number.isFinite(before) && before > 0,
    `wide document has no measurable pre-zoom scale: ${String(before)}`,
  ).toBe(true);
  await tile(page, "beta").locator('[aria-label="Zoom in"]').click();
  await expect
    .poll(() => zoomOf(page, "beta"), {
      message: "manual zoom on the wide document",
    })
    .toBeGreaterThan(before);
});

test("going to the next page after a zoom keeps the 16px page gutter", async ({
  page,
}) => {
  await openViewers(page);
  await resizeAndFit(page);

  const before = await zoomOf(page, "beta");
  await tile(page, "beta").locator('[aria-label="Zoom in"]').click();
  await expect
    .poll(() => zoomOf(page, "beta"), {
      message: "manual zoom on the wide document",
    })
    .toBeGreaterThan(before);

  await tile(page, "beta").locator('[aria-label="Next page"]').click();
  await expect(
    tile(page, "beta").locator('[aria-label="Page number"]'),
    "the second page after zoom",
  ).toHaveValue("2");
  const alignment = await page.evaluate(() => {
    const scope = document.querySelector('[data-word-tile="beta"]');
    const container = scope?.querySelector(
      '[data-testid="docx-preview-container"]',
    );
    const secondPage = scope
      ?.querySelector('[data-testid="docx-preview-host"]')
      ?.shadowRoot?.querySelectorAll("section.docx")[1];
    if (
      !(container instanceof HTMLElement) ||
      !(secondPage instanceof HTMLElement)
    ) {
      throw new Error("could not measure the zoomed page alignment");
    }
    const pageTop = secondPage.getBoundingClientRect().top;
    const containerTop = container.getBoundingClientRect().top;
    return { pageTop, containerTop, gutter: pageTop - containerTop };
  });
  expect(
    Math.abs(alignment.gutter - PAGE_GUTTER_PX),
    `goToPage lost the 16px gutter after zoom: ${JSON.stringify(alignment)}`,
  ).toBeLessThanOrEqual(MEASUREMENT_TOLERANCE_PX);
});

test("select-all stays inside the active viewer's own shadow root", async ({
  page,
}) => {
  await openViewers(page);
  await resizeAndFit(page);

  const alphaPage = await pagesOf(page, "alpha").first().boundingBox();
  if (alphaPage === null) throw new Error("the alpha page has no layout box");
  await page.mouse.click(alphaPage.x + 24, alphaPage.y + 48);
  await page.keyboard.press("ControlOrMeta+a");

  const readSelection = async (): Promise<{
    readonly collapsed: boolean;
    readonly text: string;
    readonly rangeRoot: boolean;
    readonly includesBeta: boolean;
    readonly includesAlpha: boolean;
  }> =>
    page.evaluate(() => {
      const selection = window.getSelection();
      const range =
        selection !== null && selection.rangeCount === 1
          ? selection.getRangeAt(0)
          : null;
      const alpha = document.querySelector(
        '[data-word-tile="alpha"] [data-testid="docx-preview-host"]',
      );
      const text = selection?.toString() ?? "";
      return {
        collapsed: selection === null || selection.isCollapsed,
        text,
        rangeRoot:
          range?.commonAncestorContainer.getRootNode() === alpha?.shadowRoot,
        includesBeta: text.includes("BETA-SEARCH"),
        includesAlpha: text.includes("ALPHA-SEARCH"),
      };
    });

  // The key has landed once the click's caret has become a range; the claims
  // below are only meaningful after that.
  await expect
    .poll(async () => (await readSelection()).collapsed, {
      message: "select-all never selected anything",
    })
    .toBe(false);
  const selection = await readSelection();
  expect(
    selection.rangeRoot,
    `select-all range escaped the alpha shadow root: ${JSON.stringify(selection)}`,
  ).toBe(true);
  expect(
    selection.includesAlpha,
    "select-all did not include the active document text",
  ).toBe(true);
  expect(
    selection.includesBeta,
    "select-all included the inactive document text",
  ).toBe(false);
});

test("two viewers' search highlights do not share a name or clear each other", async ({
  page,
}) => {
  const { alpha, beta } = await openBothSearches(page);

  expect(
    alpha.filter((name) => beta.includes(name)),
    "two Word viewers shared a CSS highlight name",
  ).toEqual([]);
  expect(
    await stillRegistered(page, alpha),
    "beta search cleared alpha's highlights",
  ).toBe(true);
});

test("closing one viewer's search leaves the other's highlights registered", async ({
  page,
}) => {
  const { alpha } = await openBothSearches(page);

  await tile(page, "beta").locator('[aria-label="Close search"]').click();
  await expect(
    tile(page, "beta").locator('input[aria-label="Find in document"]'),
    "beta search to close",
  ).toHaveCount(0);
  expect(
    await stillRegistered(page, alpha),
    "closing beta search cleared alpha's highlights",
  ).toBe(true);
});
