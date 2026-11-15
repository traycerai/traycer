import { expect, test, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

declare global {
  interface Window {
    __soundtrackControlsProbe?: {
      readonly setTrack: (name: string, title: string) => void;
      readonly setPaused: (paused: boolean) => void;
      readonly setSettingsOverlay: (open: boolean) => void;
    };
  }
}

// The title beside the music buttons is real layout and real CSS animation: a
// title too long for its window moves inside it, one that fits stands still,
// and the buttons never move for either. The controls are the real component
// over the real stores (see `src/__tests__/browser/soundtrack-playback-controls.tsx`);
// the sounding track is the one input the page sets.

test.use({ viewport: { width: 1280, height: 600 }, deviceScaleFactor: 1 });

const TRACK = "epic-playback-track";
const BUTTONS = [
  "epic-playback-previous",
  "epic-playback-toggle",
  "epic-playback-next",
];
const SHORT = "Slow Tide";
const LONG =
  "A very long track title that cannot fit the window beside the buttons";
const OTHER_LONG =
  "Another extremely long track title that also cannot fit its window";

async function open(page: Page): Promise<void> {
  await page.goto(fixture("soundtrack-playback-controls"));
  await page.waitForFunction(
    () => window.__soundtrackControlsProbe !== undefined,
  );
}

async function setTrack(
  page: Page,
  name: string,
  title: string,
): Promise<void> {
  await page.evaluate(
    ([n, t]) => window.__soundtrackControlsProbe?.setTrack(n, t),
    [name, title] as const,
  );
  await nextFrames(page, 2);
}

/** The element that carries the title's animation state. */
function marquee(page: Page) {
  return page.getByTestId(TRACK).locator(".soundtrack-title");
}

async function transformX(page: Page): Promise<number> {
  return marquee(page).evaluate((element) => {
    return new DOMMatrixReadOnly(getComputedStyle(element).transform).m41;
  });
}

async function buttonLefts(page: Page): Promise<number[]> {
  const lefts: number[] = [];
  for (const id of BUTTONS) {
    const box = await page.getByTestId(id).boundingBox();
    if (box === null) throw new Error(`no box for ${id}`);
    lefts.push(box.x);
  }
  return lefts;
}

test("a title too long for its window scrolls, and its whole text stays readable and in one place", async ({
  page,
}) => {
  await open(page);
  await setTrack(page, "long", LONG);

  await expect(marquee(page)).toHaveAttribute("data-scrolling", "true");
  const clipped = await page
    .getByTestId(TRACK)
    .locator(":scope > span:not(.sr-only)")
    .first()
    .evaluate((viewport) => viewport.scrollWidth > viewport.clientWidth);
  expect(clipped).toBe(true);
  // One copy of the title, so a screen reader reads it once.
  await expect(page.getByText(LONG)).toHaveCount(1);
  await expect(page.getByTestId(TRACK)).toContainText(LONG);

  // It moves: the animation leaves its resting hold within a few seconds.
  await expect
    .poll(() => transformX(page), { timeout: 10_000 })
    .toBeLessThan(-1);
});

test("a title that fits stands still and is shown whole", async ({ page }) => {
  await open(page);
  await setTrack(page, "short", SHORT);

  await expect(marquee(page)).toHaveAttribute("data-scrolling", "false");
  expect(await transformX(page)).toBe(0);
  const fits = await marquee(page).evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  );
  expect(fits).toBe(true);
  await expect(page.getByTestId(TRACK)).toContainText(SHORT);
});

test("the buttons stand in the same place for a short title, a long one and a change between them", async ({
  page,
}) => {
  await open(page);
  await setTrack(page, "short", SHORT);
  const label = await page.getByTestId(TRACK).boundingBox();
  const lefts = await buttonLefts(page);

  await setTrack(page, "long", LONG);
  expect(await buttonLefts(page)).toEqual(lefts);
  expect((await page.getByTestId(TRACK).boundingBox())?.width).toBeCloseTo(
    label?.width ?? 0,
    1,
  );

  await setTrack(page, "other", OTHER_LONG);
  expect(await buttonLefts(page)).toEqual(lefts);
});

test("a change of title keeps focus on the pressed button", async ({
  page,
}) => {
  await open(page);
  await setTrack(page, "long", LONG);

  await page.getByRole("button", { name: "Next track" }).focus();
  await setTrack(page, "short", SHORT);

  await expect(page.getByRole("button", { name: "Next track" })).toBeFocused();
});

test("a new track starts its title from the beginning", async ({ page }) => {
  await open(page);
  await setTrack(page, "long", LONG);
  await expect
    .poll(() => transformX(page), { timeout: 10_000 })
    .toBeLessThan(-1);

  await setTrack(page, "other", OTHER_LONG);

  await expect(marquee(page)).toHaveAttribute("data-scrolling", "true");
  // The label is a new run: it is back in the hold at its start.
  expect(Math.abs(await transformX(page))).toBeLessThan(1);
});

test("Pause holds the title where it is, and Play lets it go on", async ({
  page,
}) => {
  await open(page);
  await setTrack(page, "long", LONG);
  await expect
    .poll(() => transformX(page), { timeout: 10_000 })
    .toBeLessThan(-1);

  await page.evaluate(() => window.__soundtrackControlsProbe?.setPaused(true));
  await nextFrames(page, 2);
  const held = await transformX(page);
  await page.waitForTimeout(500);
  expect(await transformX(page)).toBe(held);

  await page.evaluate(() => window.__soundtrackControlsProbe?.setPaused(false));
  await expect.poll(() => transformX(page)).not.toBe(held);
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("a long title is cut and still, with the whole text available", async ({
    page,
  }) => {
    await open(page);
    await setTrack(page, "long", LONG);

    await expect(marquee(page)).toHaveAttribute("data-scrolling", "false");
    expect(await transformX(page)).toBe(0);
    const cut = await marquee(page).evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    );
    expect(cut).toBe(true);
    await expect(page.getByTestId(TRACK)).toContainText(LONG);
    await page.getByRole("button", { name: "Pause" }).focus();
    await expect(page.getByRole("tooltip")).toContainText(LONG);
  });
});

test("the buttons' tooltip names the whole title however it is cut", async ({
  page,
}) => {
  await open(page);
  await setTrack(page, "long", LONG);

  await page.getByRole("button", { name: "Next track" }).focus();

  await expect(page.getByRole("tooltip")).toHaveText(
    `Next track · ${LONG} · Generative variant`,
  );
});

test("a Settings overlay takes the controls from the page behind it, and one group is drawn", async ({
  page,
}) => {
  await open(page);
  await setTrack(page, "short", SHORT);
  const groups = page.getByRole("group", { name: "Music playback" });
  await expect(groups).toHaveCount(1);
  await expect(page.getByTestId("overlay")).toHaveCount(0);

  await page.evaluate(() =>
    window.__soundtrackControlsProbe?.setSettingsOverlay(true),
  );

  await expect(groups).toHaveCount(1);
  await expect(page.getByTestId("overlay").getByRole("group")).toHaveCount(1);
  await expect(page.getByTestId("overlay")).toContainText(SHORT);

  await page.evaluate(() =>
    window.__soundtrackControlsProbe?.setSettingsOverlay(false),
  );
  await expect(groups).toHaveCount(1);
  await expect(page.getByTestId("overlay")).toHaveCount(0);
});

test("the controls' row keeps its 40px height for a short title, a long one and a change between them", async ({
  page,
}) => {
  await open(page);
  const group = page.getByRole("group", { name: "Music playback" });
  await setTrack(page, "short", SHORT);
  const height = (await group.boundingBox())?.height;
  expect(height).toBe(40);

  await setTrack(page, "long", LONG);
  expect((await group.boundingBox())?.height).toBe(height);
  expect(
    (await page.getByTestId(TRACK).boundingBox())?.height,
  ).toBeLessThanOrEqual(40);
});

test("under 768px the page's controls are not drawn", async ({ page }) => {
  await page.setViewportSize({ width: 767, height: 600 });
  await open(page);
  await setTrack(page, "short", SHORT);

  await expect(
    page.getByRole("group", { name: "Music playback" }),
  ).toBeHidden();
});
