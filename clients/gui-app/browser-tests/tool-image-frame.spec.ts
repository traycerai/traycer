import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// The frame a chat image holds while it loads.
//
// A generic tool's image arrives in stages - the blob is still syncing, the
// browser has it but has not decoded it, an SVG waits on its sanitizer - and the
// transcript must not jump when the real image replaces the placeholder. jsdom
// has no layout, so only a real browser can say that the placeholder and the
// finished image occupy the same box, and that the box never outgrows the
// image's own recorded width (a 512px square is not stretched to the chat's
// edge cap).

test.use({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });

/** The chat image edge cap, `min(90vw, 42rem)`, at this viewport. */
const MAX_EDGE_PX = 672;
/** The frame's 1px border on each side, which the placeholder may not paint. */
const BORDER_SLACK_PX = 3;

const SVG_SOURCE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#c84"/></svg>';

interface Box {
  readonly width: number;
  readonly height: number;
}

function frameOf(page: Page, id: string): Locator {
  return page.locator(`[data-case="${id}"] > *`).first();
}

async function boxOf(page: Page, id: string): Promise<Box> {
  const box = await frameOf(page, id).boundingBox();
  if (box === null) throw new Error(`no layout box for ${id}`);
  return { width: box.width, height: box.height };
}

async function expectSameBox(page: Page, id: string, finalId: string) {
  const final = await boxOf(page, finalId);
  await expect
    .poll(async () => {
      const box = await boxOf(page, id);
      return Math.max(
        Math.abs(box.width - final.width),
        Math.abs(box.height - final.height),
      );
    })
    .toBeLessThanOrEqual(BORDER_SLACK_PX);
}

async function waitForDecoded(page: Page, id: string): Promise<void> {
  await page.waitForFunction((caseId: string) => {
    const image = document.querySelector<HTMLImageElement>(
      `[data-case="${caseId}"] img`,
    );
    return image !== null && image.complete && image.naturalWidth > 0;
  }, id);
  await expect(page.locator(`[data-case="${id}"] [role="status"]`)).toHaveCount(
    0,
  );
}

const held: Route[] = [];

test.beforeEach(async ({ page }) => {
  held.length = 0;
  await page.route("**/fixture-image/slow-*.png", (route) => {
    held.push(route);
  });
  await page.route("**/fixture-image/delayed.svg", (route) => {
    held.push(route);
  });
  await page.goto(fixture("tool-image-frame"));
  await page.waitForSelector("body[data-ready]");
  await nextFrames(page, 3);
  for (const id of ["loaded-512", "loaded-portrait", "loaded-large"]) {
    await waitForDecoded(page, id);
  }
});

for (const [family, finalId, maxWidth] of [
  ["512 square", "512", 512 + BORDER_SLACK_PX],
  ["portrait", "portrait", 256 + BORDER_SLACK_PX],
  ["large", "large", MAX_EDGE_PX + BORDER_SLACK_PX],
] as const) {
  test(`${family}: the blob-wait placeholder holds the finished image's box`, async ({
    page,
  }) => {
    await expectSameBox(page, `wait-${finalId}`, `loaded-${finalId}`);
    expect((await boxOf(page, `wait-${finalId}`)).width).toBeLessThanOrEqual(
      maxWidth,
    );
  });
}

for (const [family, finalId] of [
  ["512 square", "512"],
  ["portrait", "portrait"],
] as const) {
  test(`${family}: a blob the browser has not decoded holds the finished image's box`, async ({
    page,
  }) => {
    await expect(
      page.locator(`[data-case="undecoded-${finalId}"] [role="status"]`),
    ).toHaveText("Loading image");
    await expectSameBox(page, `undecoded-${finalId}`, `loaded-${finalId}`);
  });
}

test("a narrow container bounds the frame in every state", async ({ page }) => {
  await waitForDecoded(page, "loaded-narrow");
  expect((await boxOf(page, "wait-narrow")).width).toBeLessThanOrEqual(300);
  await expectSameBox(page, "wait-narrow", "loaded-narrow");
});

test("a delayed SVG sanitizer keeps its box before and after the markup arrives", async ({
  page,
}) => {
  const waiting = await boxOf(page, "svg-delayed");
  expect(waiting.width).toBeLessThanOrEqual(512 + BORDER_SLACK_PX);
  expect(waiting.height).toBeGreaterThan(0);

  await expect.poll(() => held.length).toBeGreaterThan(0);
  const svgRoute = held.find((route) =>
    route.request().url().endsWith("/delayed.svg"),
  );
  if (svgRoute === undefined) throw new Error("the SVG request was not held");
  await svgRoute.fulfill({
    status: 200,
    contentType: "image/svg+xml",
    body: SVG_SOURCE,
  });
  await waitForDecoded(page, "svg-delayed");

  const settled = await boxOf(page, "svg-delayed");
  expect(Math.abs(settled.width - waiting.width)).toBeLessThanOrEqual(
    BORDER_SLACK_PX,
  );
  expect(Math.abs(settled.height - waiting.height)).toBeLessThanOrEqual(
    BORDER_SLACK_PX,
  );
});

test("an image with no recorded size keeps its own size", async ({ page }) => {
  await waitForDecoded(page, "loaded-unrecorded");

  const box = await boxOf(page, "loaded-unrecorded");
  expect(Math.abs(box.width - 512)).toBeLessThanOrEqual(BORDER_SLACK_PX);
  expect(Math.abs(box.height - 300)).toBeLessThanOrEqual(BORDER_SLACK_PX);
});
