import { expect, test, type Locator, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

declare global {
  interface Window {
    __voiceTopRowErrors?: string[];
    __voiceTopRowProbe?: {
      readonly fillTabs: (width: number) => void;
      readonly startCall: () => void;
      readonly showCaptions: () => void;
      readonly openTabs: (count: number) => void;
    };
  }
}

// Where the call strip lands is real layout: the middle of the content column,
// in the window's top row, whatever draws that row.

test.use({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 1 });

const strip = (page: Page): Locator => page.getByTestId("voice-session-strip");

// Drawn because this fixture is a development build, which has a soundtrack.
const soundtrack = (page: Page): Locator =>
  page.getByRole("button", { name: "Soundtrack" });

async function open(
  page: Page,
  query: string,
  withCall: boolean,
): Promise<void> {
  await page.addInitScript(() => {
    window.__voiceTopRowErrors = [];
    window.addEventListener("error", (event) => {
      window.__voiceTopRowErrors?.push(event.message);
    });
  });
  await page.goto(`${fixture("voice-top-row")}?${query}`);
  await page.waitForFunction(() => window.__voiceTopRowProbe !== undefined);
  await page.locator("main").waitFor();
  if (!withCall) return;
  await page.evaluate(() => window.__voiceTopRowProbe?.startCall());
  await strip(page).waitFor();
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("no box");
  return box;
}

function rightOf(box: Box): number {
  return box.x + box.width;
}

async function middleOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("no box");
  return box.x + box.width / 2;
}

/**
 * Reads the controls, not the box around them: that box may shrink for its
 * readings, and whatever it cannot shrink spills out past its edge, so its own
 * right edge stays in the window when the controls in it do not.
 */
async function expectHeaderControlsInWindow(
  page: Page,
  width: number,
): Promise<void> {
  await expect(page.getByTestId("notifications-bell")).toBeVisible();
  await expect(page.getByTestId("user-menu-trigger")).toBeVisible();
  const controls = page
    .getByTestId("app-header")
    .locator("> :last-child")
    .locator("button, a");
  await expect
    .poll(() =>
      controls.evaluateAll((nodes) =>
        Math.max(...nodes.map((node) => node.getBoundingClientRect().right)),
      ),
    )
    .toBeLessThanOrEqual(width);
  const sideways = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(sideways).toBe(0);
}

/** New tab is the last of the strip's fixed controls: it ends where they end. */
async function expectFixedTabControlsClearOfZone(page: Page): Promise<void> {
  const newTab = page.getByTestId("tab-new");
  const zone = page.getByTestId("app-header-centre-zone");
  await expect
    .poll(async () => rightOf(await boxOf(newTab)) - (await boxOf(zone)).x)
    .toBeLessThanOrEqual(0);
  const box = await boxOf(newTab);
  const hit = await newTab.evaluate(
    (node, [x, y]) => node.contains(document.elementFromPoint(x, y)),
    [box.x + box.width / 2, box.y + box.height / 2],
  );
  expect(hit).toBe(true);
}

test("the strip is on the middle of the header with the tabs at the top", async ({
  page,
}) => {
  await open(page, "placement=top", true);
  const main = await middleOf(page.locator("main"));
  await expect
    .poll(async () => {
      const zone = await boxOf(page.getByTestId("app-header-centre-zone"));
      return Math.abs(zone.x + zone.width / 2 - main);
    })
    .toBeLessThan(1);
  const stripBox = await boxOf(strip(page));
  const headerBox = await boxOf(page.getByTestId("app-header"));
  expect(stripBox.y).toBeGreaterThanOrEqual(headerBox.y);
  expect(stripBox.y + stripBox.height).toBeLessThanOrEqual(
    headerBox.y + headerBox.height,
  );
});

test("long tabs push the strip right and give up only the room it needs", async ({
  page,
}) => {
  await open(page, "placement=top", true);
  await page.evaluate(() => window.__voiceTopRowProbe?.fillTabs(900));
  const tabs = page.locator("[data-fixture-tabs]");
  await expect
    .poll(async () => (await strip(page).boundingBox())?.x ?? 0)
    .toBeGreaterThan(900);
  await expect.poll(async () => (await boxOf(tabs)).width).toBe(900);
  const header = await page.getByTestId("app-header").boundingBox();
  const zone = await page.getByTestId("app-header-centre-zone").boundingBox();
  expect((zone?.x ?? 0) + (zone?.width ?? 0)).toBeLessThanOrEqual(
    (header?.x ?? 0) + (header?.width ?? 0),
  );
});

test("the strip rises into the title band, on the column's middle, adding no height", async ({
  page,
}) => {
  await open(page, "placement=right&wco=mac", true);
  const row = page.getByTestId("voice-top-row");
  await expect(row).toHaveAttribute("data-title-band", "band");
  expect(await middleOf(strip(page))).toBeCloseTo(
    await middleOf(page.locator("main")),
    0,
  );
  const band = await page.getByTestId("app-title-band").boundingBox();
  const main = await page.locator("main").boundingBox();
  expect(main?.y).toBe((band?.y ?? 0) + (band?.height ?? 0));
  expect((await strip(page).boundingBox())?.y).toBeLessThan(band?.height ?? 0);
});

test("with no band a row carries the strip, as tall as the band, beside the strip of tabs", async ({
  page,
}) => {
  await open(page, "placement=left&wco=mac", true);
  const row = page.getByTestId("voice-top-row");
  await expect(row).toHaveAttribute("data-title-band", "none");
  expect(await middleOf(strip(page))).toBeCloseTo(
    await middleOf(page.locator("main")),
    0,
  );
  const rowBox = await row.boundingBox();
  expect(rowBox?.y).toBe(0);
  expect(rowBox?.height).toBe(40);
  expect((await page.locator("main").boundingBox())?.y).toBe(40);
  expect((await page.locator("[data-fixture-strip]").boundingBox())?.y).toBe(0);
});

test("captions hang over the content without moving it", async ({ page }) => {
  await open(page, "placement=left", true);
  const before = await page.locator("main").boundingBox();
  expect(await middleOf(strip(page))).toBeCloseTo(
    await middleOf(page.locator("main")),
    0,
  );
  await page.evaluate(() => window.__voiceTopRowProbe?.showCaptions());
  const lines = page.getByTestId("voice-strip-captions-lines");
  await lines.waitFor();
  expect(await page.locator("main").boundingBox()).toEqual(before);
  const captions = await lines.boundingBox();
  if (captions === null || before === null) throw new Error("no box");
  expect(captions.y).toBe(before.y);
  // Outside the captions' own box the content below takes the pointer.
  const beside = await page.evaluate(
    ([x, y]) =>
      document.elementFromPoint(x, y)?.closest("[data-fixture-surface]") !==
      null,
    [captions.x - 8, captions.y + 8],
  );
  expect(beside).toBe(true);
});

for (const width of [1400, 1100, 900, 800, 768]) {
  test(`with 12 real tabs at ${String(width)}px every control of a live call is on screen`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await open(page, "placement=top&account=1", false);
    await page.evaluate(() => window.__voiceTopRowProbe?.openTabs(12));
    await page.getByTestId("header-tab-strip-scroll").waitFor();
    await page.evaluate(() => window.__voiceTopRowProbe?.startCall());
    const end = page.getByTestId("voice-strip-end");
    await end.waitFor();
    for (const control of [
      page.getByTestId("voice-strip-state"),
      page.getByTestId("voice-strip-mute"),
      page.getByTestId("voice-strip-captions"),
      end,
    ]) {
      await expect
        .poll(async () => rightOf(await boxOf(control)))
        .toBeLessThanOrEqual(width);
      expect((await boxOf(control)).x).toBeGreaterThanOrEqual(0);
    }
    // Each control takes the pointer: nothing lies over it.
    for (const control of [page.getByTestId("voice-strip-mute"), end]) {
      await expectTakesThePointer(control);
    }
    // The tabs stop before the zone and the header's own controls fit after it.
    const zone = await boxOf(page.getByTestId("app-header-centre-zone"));
    const scroller = await boxOf(page.getByTestId("header-tab-strip-scroll"));
    expect(rightOf(scroller)).toBeLessThanOrEqual(zone.x);
    const actions = await boxOf(
      page.getByTestId("app-header").locator("> :last-child"),
    );
    await expectHeaderControlsInWindow(page, width);
    await expectFixedTabControlsClearOfZone(page);
    expect(actions.x).toBeGreaterThanOrEqual(rightOf(zone));
    await nextFrames(page, 3);
    expect(await page.evaluate(() => window.__voiceTopRowErrors)).toEqual([]);
  });
}

for (const width of [1400, 1100, 900, 800, 768]) {
  test(`with 12 real tabs at ${String(width)}px and no call the window does not scroll sideways`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await open(page, "placement=top&account=1", false);
    await page.evaluate(() => window.__voiceTopRowProbe?.openTabs(12));
    await page.getByTestId("header-tab-strip-scroll").waitFor();
    await expect(strip(page)).toHaveCount(0);
    await expectHeaderControlsInWindow(page, width);
    await expectFixedTabControlsClearOfZone(page);
    await expect
      .poll(async () => rightOf(await boxOf(soundtrack(page))))
      .toBeLessThanOrEqual(width);
  });
}

// Windows and Linux keep the desktop header in a zoomed window, below the width
// where every other platform changes to the phone header, and at this one the
// row has no room for everything. With no call the toggle and the header's own
// controls stay; the window does not scroll. (A live call's strip does not fit
// here: its controls are wider than the room, and the header's own controls
// leave the window. The widths that matter for a call are the loop's above.)
test("in a zoomed Windows window with no room left and no call the window does not scroll sideways", async ({
  page,
}) => {
  await page.setViewportSize({ width: 560, height: 800 });
  await open(page, "placement=top&wco=win&account=1", false);
  await page.evaluate(() => window.__voiceTopRowProbe?.openTabs(12));
  // The scroller has given up all its room: present, not visible.
  await page
    .getByTestId("header-tab-strip-scroll")
    .waitFor({ state: "attached" });
  await expectHeaderControlsInWindow(page, 560);
  await expectTakesThePointer(soundtrack(page));
});

test("with room to spare the strip shows the bot's name whole, and is centred", async ({
  page,
}) => {
  await open(page, "placement=top", true);
  const bot = page.getByTestId("voice-strip-bot");
  await expect(bot).toHaveText("Fixture bot");
  // Whole, not cut with an ellipsis.
  expect(
    await bot.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  // The whole strip fits, and it is centred once the gap has settled.
  const main = await middleOf(page.locator("main"));
  await expect
    .poll(async () => {
      const zone = await boxOf(page.getByTestId("app-header-centre-zone"));
      return Math.abs(zone.x + zone.width / 2 - main);
    })
    .toBeLessThan(1);
});

async function expectTakesThePointer(control: Locator): Promise<void> {
  const box = await boxOf(control);
  const hit = await control.evaluate(
    (node, [x, y]) => node.contains(document.elementFromPoint(x, y)),
    [box.x + box.width / 2, box.y + box.height / 2],
  );
  expect(hit).toBe(true);
}

test("the soundtrack's toggle is beside the strip, on its line, and the strip keeps the middle", async ({
  page,
}) => {
  await open(page, "placement=left&wco=mac", true);
  await expect
    .poll(() => middleOf(strip(page)))
    .toBeCloseTo(await middleOf(page.locator("main")), 0);
  const stripBox = await boxOf(strip(page));
  const toggleBox = await boxOf(soundtrack(page));
  expect(toggleBox.x).toBeGreaterThanOrEqual(rightOf(stripBox));
  expect(toggleBox.x - rightOf(stripBox)).toBeLessThanOrEqual(8);
  expect(toggleBox.y + toggleBox.height / 2).toBeCloseTo(
    stripBox.y + stripBox.height / 2,
    0,
  );
  await expectTakesThePointer(soundtrack(page));
});

test("in a zoomed Windows window the toggle stays clear of the header's controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 560, height: 800 });
  await open(page, "placement=top&wco=win&account=1", false);
  await page.evaluate(() => window.__voiceTopRowProbe?.openTabs(12));
  await page
    .getByTestId("header-tab-strip-scroll")
    .waitFor({ state: "attached" });
  await expectHeaderControlsInWindow(page, 560);
  const toggleBox = await boxOf(soundtrack(page));
  expect(rightOf(toggleBox)).toBeLessThanOrEqual(
    rightOf(await boxOf(page.getByTestId("app-header-centre-zone"))),
  );
  await expectTakesThePointer(soundtrack(page));
});

test("the toggle stays beside the strip with 12 tabs, and every control takes the pointer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 800 });
  await open(page, "placement=top&account=1", false);
  await page.evaluate(() => window.__voiceTopRowProbe?.openTabs(12));
  await page.getByTestId("header-tab-strip-scroll").waitFor();
  await page.evaluate(() => window.__voiceTopRowProbe?.startCall());
  const end = page.getByTestId("voice-strip-end");
  await end.waitFor();
  await expect
    .poll(async () => (await boxOf(soundtrack(page))).x)
    .toBeGreaterThanOrEqual(rightOf(await boxOf(end)));
  await expectTakesThePointer(end);
  await expectTakesThePointer(soundtrack(page));
  await expectHeaderControlsInWindow(page, 768);
});
