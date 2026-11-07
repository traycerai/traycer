import { expect, test, type Locator, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

declare global {
  interface Window {
    __playbackRowProbe?: {
      readonly setColumnWidth: (pixels: number) => void;
    };
  }
}

// What the task's status row does with the playback buttons is real layout. At
// a wide row they sit with their neighbours. Below 34rem of the row's content
// (the pill's longest label and every other item beside them) Previous, Next and
// Pause leave, so that nothing else is pushed out, wrapped or cut. Play stays
// while paused, being the way back to the music, and below that the pill's label
// is what gives way. The row is hidden under 768px, so the window stays wide and
// the row's parent is the thing narrowed. The row's container is its content
// box, inside 0.75rem of padding either side.

test.use({ viewport: { width: 1280, height: 600 }, deviceScaleFactor: 1 });

const BUTTONS = [
  "epic-playback-previous",
  "epic-playback-toggle",
  "epic-playback-next",
];
const NEIGHBOURS = [
  "stand-in-pill",
  "stand-in-write-commands",
  "stand-in-usage",
  "stand-in-export",
  "stand-in-sweep",
];

async function open(page: Page): Promise<void> {
  await page.goto(fixture("playback-status-row"));
  await page.waitForFunction(() => window.__playbackRowProbe !== undefined);
  await page.getByTestId("epic-shell-status-row").waitFor();
}

/** Sets the row's content box (the width its container query reads), in rem. */
async function setContentRem(
  page: Page,
  rem: number,
  extraPx: number,
): Promise<void> {
  await page.evaluate(
    ([remCount, extra]) => {
      const row = document.querySelector<HTMLElement>(
        '[data-testid="epic-shell-status-row"]',
      );
      if (row === null) throw new Error("no row");
      const style = getComputedStyle(row);
      const chrome =
        Number.parseFloat(style.paddingLeft) +
        Number.parseFloat(style.paddingRight);
      const fontSize = Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
      window.__playbackRowProbe?.setColumnWidth(
        remCount * fontSize + extra + chrome,
      );
    },
    [rem, extraPx] as const,
  );
  await nextFrames(page, 2);
}

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`no box for ${locator.toString()}`);
  return {
    left: box.x,
    right: box.x + box.width,
    top: box.y,
    bottom: box.y + box.height,
    width: box.width,
    height: box.height,
  };
}

/** The row's content box: where nothing may stick out past, either side. */
async function contentBox(
  page: Page,
): Promise<{ left: number; right: number }> {
  return page.getByTestId("epic-shell-status-row").evaluate((row) => {
    const style = getComputedStyle(row);
    const box = row.getBoundingClientRect();
    return {
      left: box.left + Number.parseFloat(style.paddingLeft),
      right: box.right - Number.parseFloat(style.paddingRight),
    };
  });
}

async function expectWhole(page: Page, ids: readonly string[]): Promise<void> {
  const content = await contentBox(page);
  for (const id of ids) {
    const box = await boxOf(page.getByTestId(id));
    expect(box.left, `${id} left`).toBeGreaterThanOrEqual(content.left - 0.5);
    expect(box.right, `${id} right`).toBeLessThanOrEqual(content.right + 0.5);
  }
  const noOverflow = await page
    .getByTestId("epic-shell-status-row")
    .evaluate((row) => row.scrollWidth <= row.clientWidth);
  expect(noOverflow).toBe(true);
}

/** Each item's height, to tell a wrapped label from one on a line. */
async function heights(page: Page, ids: readonly string[]): Promise<number[]> {
  const out: number[] = [];
  for (const id of ids) out.push((await boxOf(page.getByTestId(id))).height);
  return out;
}

test("a wide row shows Previous, Pause and Next in order, at their neighbours' height, inside the row", async ({
  page,
}) => {
  await open(page);

  for (const id of BUTTONS) await expect(page.getByTestId(id)).toBeVisible();
  const lefts: number[] = [];
  for (const id of BUTTONS)
    lefts.push((await boxOf(page.getByTestId(id))).left);
  expect(lefts).toEqual([...lefts].sort((a, b) => a - b));
  expect(new Set(lefts).size).toBe(3);

  const usage = await boxOf(page.getByTestId("stand-in-usage"));
  for (const id of BUTTONS) {
    const box = await boxOf(page.getByTestId(id));
    expect(box.height, id).toBeCloseTo(usage.height, 1);
    expect(box.width, id).toBeCloseTo(usage.width, 1);
  }
  await expectWhole(page, [...BUTTONS, ...NEIGHBOURS]);
});

test("below 34rem the buttons are gone and everything else is whole", async ({
  page,
}) => {
  await open(page);
  const wide = await heights(page, NEIGHBOURS);

  // The hide is a container query of `width < 34rem`: one pixel under it.
  await setContentRem(page, 34, -1);

  for (const id of BUTTONS) await expect(page.getByTestId(id)).toBeHidden();
  await expectWhole(page, NEIGHBOURS);
  expect(await heights(page, NEIGHBOURS)).toEqual(wide);
});

test("at 34rem the buttons are still shown and nothing overflows or wraps", async ({
  page,
}) => {
  await open(page);
  const wide = await heights(page, [...BUTTONS, ...NEIGHBOURS]);

  await setContentRem(page, 34, 0);

  for (const id of BUTTONS) await expect(page.getByTestId(id)).toBeVisible();
  await expectWhole(page, [...BUTTONS, ...NEIGHBOURS]);
  expect(await heights(page, [...BUTTONS, ...NEIGHBOURS])).toEqual(wide);
});

/** Pauses with the real button, at the wide width. */
async function pause(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
}

test("paused, below 34rem Play stays with everything whole, Previous and Next leave, and Play leaves once pressed", async ({
  page,
}) => {
  await open(page);
  await pause(page);
  const wide = await heights(page, ["epic-playback-toggle", ...NEIGHBOURS]);

  await setContentRem(page, 34, -1);

  await expect(page.getByTestId("epic-playback-toggle")).toBeVisible();
  await expect(page.getByTestId("epic-playback-previous")).toBeHidden();
  await expect(page.getByTestId("epic-playback-next")).toBeHidden();
  await expectWhole(page, ["epic-playback-toggle", ...NEIGHBOURS]);
  expect(await heights(page, ["epic-playback-toggle", ...NEIGHBOURS])).toEqual(
    wide,
  );

  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByTestId("epic-playback-toggle")).toBeHidden();
});

test("paused in a 360px row Play and everything else are whole, and the pill's label is what is cut", async ({
  page,
}) => {
  await open(page);
  await pause(page);
  const wide = await heights(page, ["epic-playback-toggle", ...NEIGHBOURS]);

  // The desktop's 960px minimum window less the sidebar's 600px maximum.
  await page.evaluate(() => window.__playbackRowProbe?.setColumnWidth(360));
  await nextFrames(page, 2);

  await expect(page.getByTestId("epic-playback-toggle")).toBeVisible();
  await expectWhole(page, ["epic-playback-toggle", ...NEIGHBOURS]);
  expect(await heights(page, ["epic-playback-toggle", ...NEIGHBOURS])).toEqual(
    wide,
  );
  const cut = await page
    .getByTestId("stand-in-pill-label")
    .evaluate((label) => label.scrollWidth > label.clientWidth);
  expect(cut).toBe(true);
});
