import { expect, test, type Locator, type Page } from "@playwright/test";

import { fixture } from "./support/fixtures.ts";

// An HTML artifact filling its tile floats a controls chip over the page's
// top-right corner. The page opens with a top inset equal to the chip's bottom
// edge, as padding on the page's own root, so the title is never under the
// chip at rest and the gap scrolls away with the page. Boxes and scroll
// offsets are layout, which jsdom cannot decide; the wiring from the measured
// chip to the page's theme variables stays in Vitest next to the components.
//
// The page lives in a sandboxed frame with an opaque origin, which the test
// cannot reach through `contentDocument`. Playwright's frame locators read it
// over the browser's debugging channel instead, so every in-frame read below
// goes through them.

test.use({ viewport: { width: 900, height: 700 }, actionTimeout: 10_000 });

const FRAME_TITLE = "Inset page";
const SCROLL_DISTANCE_PX = 200;

interface InsetProbe {
  readonly serve: (url: string) => Promise<{
    readonly status: number;
    readonly mediaType: string;
    readonly base64: string;
  }>;
}
interface ProbeWindow extends Window {
  __insetProbe?: InsetProbe;
}

function frameElement(page: Page) {
  return page.locator(`iframe[title="${FRAME_TITLE}"]`);
}

function pageFrame(page: Page) {
  return page.frameLocator(`iframe[title="${FRAME_TITLE}"]`);
}

function pageTitle(page: Page) {
  return pageFrame(page).locator("h1");
}

function controlsChip(page: Page) {
  return page.getByRole("toolbar", { name: "HTML artifact controls" });
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("no layout box");
  return box;
}

/** Where the page's artifact address is served from: no network answers it. */
async function serveArtifactFromPage(page: Page): Promise<void> {
  await page.route(
    /^https:\/\/artifact-[^/]+\.traycer-artifact\.invalid\//,
    async (route) => {
      const served = await page.evaluate(
        (url) => (window as ProbeWindow).__insetProbe?.serve(url),
        route.request().url(),
      );
      if (served === undefined) {
        await route.abort();
        return;
      }
      await route.fulfill({
        status: served.status,
        contentType: served.mediaType,
        body: Buffer.from(served.base64, "base64"),
      });
    },
  );
}

async function open(
  page: Page,
  layout: "document" | "full-height",
): Promise<void> {
  await serveArtifactFromPage(page);
  await page.goto(
    layout === "document"
      ? fixture("html-artifact-page-inset")
      : `${fixture("html-artifact-page-inset")}?layout=full-height`,
  );
  // The positive events: the page is drawn and the chip floats over it.
  await expect(pageTitle(page)).toBeVisible();
  await expect(controlsChip(page)).toBeVisible();
}

/** The title's top edge in page coordinates: the frame's box plus its rect inside. */
async function titleTopInPage(page: Page): Promise<number> {
  const frameBox = await boxOf(frameElement(page));
  const titleTopInFrame = await pageTitle(page).evaluate(
    (title) => title.getBoundingClientRect().top,
  );
  return frameBox.y + titleTopInFrame;
}

async function chipBottomInPage(page: Page): Promise<number> {
  const chipBox = await boxOf(controlsChip(page));
  return chipBox.y + chipBox.height;
}

test("the page title opens below the controls chip", async ({ page }) => {
  await open(page, "document");

  // The premise: the title is wide enough to run under the chip, so a missing
  // inset would put it there.
  const titleBox = await boxOf(pageTitle(page));
  const chipBox = await boxOf(controlsChip(page));
  expect(titleBox.x + titleBox.width).toBeGreaterThan(chipBox.x);

  const chipBottom = await chipBottomInPage(page);
  await expect
    .poll(() => titleTopInPage(page))
    .toBeGreaterThanOrEqual(chipBottom);
});

// The fixture's page resets `html { padding: 0 }`, and the room must hold
// through it.
test("the room for the controls is padding on the page root that outlasts the page's own reset", async ({
  page,
}) => {
  await open(page, "document");
  const frameBox = await boxOf(frameElement(page));
  const chipBottomInFrame = (await chipBottomInPage(page)) - frameBox.y;

  await expect
    .poll(() =>
      pageFrame(page)
        .locator("html")
        .evaluate(
          (root) =>
            Number.parseFloat(window.getComputedStyle(root).paddingTop) || 0,
        ),
    )
    .toBeGreaterThanOrEqual(chipBottomInFrame);
});

test("scrolling the page carries the title past the controls chip", async ({
  page,
}) => {
  await open(page, "document");
  const chipBottom = await chipBottomInPage(page);
  await expect
    .poll(() => titleTopInPage(page))
    .toBeGreaterThanOrEqual(chipBottom);

  // One script reads before and after, so a late change of the inset cannot
  // fall between the two readings.
  const scrolled = await pageTitle(page).evaluate((title, distance) => {
    const before = title.getBoundingClientRect().top;
    window.scrollTo({ top: distance, behavior: "instant" });
    return {
      before,
      after: title.getBoundingClientRect().top,
      scrollY: window.scrollY,
    };
  }, SCROLL_DISTANCE_PX);
  expect(scrolled.scrollY).toBe(SCROLL_DISTANCE_PX);
  expect(scrolled.before - scrolled.after).toBe(SCROLL_DISTANCE_PX);

  const frameBox = await boxOf(frameElement(page));
  expect(frameBox.y + scrolled.after).toBeLessThan(chipBottom);
});

test("a page that fills the window keeps its bottom edge in view, under the room for the controls", async ({
  page,
}) => {
  await open(page, "full-height");
  const frameBox = await boxOf(frameElement(page));
  const chipBottom = await chipBottomInPage(page);

  // The title still opens below the chip.
  await expect
    .poll(() => titleTopInPage(page))
    .toBeGreaterThanOrEqual(chipBottom);
  // And the footer on the page's bottom edge is still inside the frame: the
  // room is taken out of the page's height, not added below it, where a page
  // that does not scroll could never reach it.
  const footerBottomInFrame = await pageFrame(page)
    .locator("#footer")
    .evaluate((footer) => footer.getBoundingClientRect().bottom);
  expect(footerBottomInFrame).toBeLessThanOrEqual(frameBox.height);
});
