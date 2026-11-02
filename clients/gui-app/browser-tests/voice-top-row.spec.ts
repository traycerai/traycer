import { expect, test, type Locator, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

declare global {
  interface Window {
    __voiceTopRowErrors?: string[];
    __voiceTopRowProbe?: {
      readonly fillTabs: (width: number) => void;
      readonly offerVoice: () => void;
      readonly goLive: () => void;
      readonly openTabs: (count: number) => void;
    };
  }
}

// Where Talk and the session strip land is real layout: the middle of the
// content column, in the window's top row, whatever draws that row.

test.use({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 1 });

const talk = (page: Page): Locator =>
  page.getByRole("button", { name: "Talk" });

async function open(page: Page, query: string): Promise<void> {
  await page.addInitScript(() => {
    window.__voiceTopRowErrors = [];
    window.addEventListener("error", (event) => {
      window.__voiceTopRowErrors?.push(event.message);
    });
  });
  await page.goto(`${fixture("voice-top-row")}?${query}`);
  await page.waitForFunction(() => window.__voiceTopRowProbe !== undefined);
  await page.locator("main").waitFor();
  await page.evaluate(() => window.__voiceTopRowProbe?.offerVoice());
  await talk(page).waitFor();
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

test("Talk is on the middle of the header with the tabs at the top", async ({
  page,
}) => {
  await open(page, "placement=top");
  await expect
    .poll(() => middleOf(talk(page)))
    .toBeCloseTo(await middleOf(page.locator("main")), 0);
  const talkBox = await talk(page).boundingBox();
  const headerBox = await page.getByTestId("app-header").boundingBox();
  expect(talkBox?.y).toBeGreaterThanOrEqual(headerBox?.y ?? Infinity);
  expect((talkBox?.y ?? 0) + (talkBox?.height ?? 0)).toBeLessThanOrEqual(
    (headerBox?.y ?? 0) + (headerBox?.height ?? 0),
  );
});

test("long tabs push Talk right and give up only the room it needs", async ({
  page,
}) => {
  await open(page, "placement=top");
  await page.evaluate(() => window.__voiceTopRowProbe?.fillTabs(900));
  const tabs = page.locator("[data-fixture-tabs]");
  await expect
    .poll(async () => (await talk(page).boundingBox())?.x ?? 0)
    .toBeGreaterThan(900);
  await expect.poll(async () => (await boxOf(tabs)).width).toBe(900);
  const header = await page.getByTestId("app-header").boundingBox();
  const zone = await page.getByTestId("app-header-centre-zone").boundingBox();
  expect((zone?.x ?? 0) + (zone?.width ?? 0)).toBeLessThanOrEqual(
    (header?.x ?? 0) + (header?.width ?? 0),
  );
});

test("Talk rises into the title band, on the column's middle, adding no height", async ({
  page,
}) => {
  await open(page, "placement=right&wco=mac");
  const row = page.getByTestId("voice-top-row");
  await expect(row).toHaveAttribute("data-title-band", "band");
  expect(await middleOf(talk(page))).toBeCloseTo(
    await middleOf(page.locator("main")),
    0,
  );
  const band = await page.getByTestId("app-title-band").boundingBox();
  const main = await page.locator("main").boundingBox();
  expect(main?.y).toBe((band?.y ?? 0) + (band?.height ?? 0));
  expect((await talk(page).boundingBox())?.y).toBeLessThan(band?.height ?? 0);
});

test("with no band a row carries Talk, as tall as the band, beside the strip", async ({
  page,
}) => {
  await open(page, "placement=left&wco=mac");
  const row = page.getByTestId("voice-top-row");
  await expect(row).toHaveAttribute("data-title-band", "none");
  expect(await middleOf(talk(page))).toBeCloseTo(
    await middleOf(page.locator("main")),
    0,
  );
  const rowBox = await row.boundingBox();
  expect(rowBox?.y).toBe(0);
  expect(rowBox?.height).toBe(40);
  expect((await page.locator("main").boundingBox())?.y).toBe(40);
  expect((await page.locator("[data-fixture-strip]").boundingBox())?.y).toBe(0);
});

test("the strip takes Talk's place, and captions hang over the content", async ({
  page,
}) => {
  await open(page, "placement=left");
  const before = await page.locator("main").boundingBox();
  await page.evaluate(() => window.__voiceTopRowProbe?.goLive());
  const strip = page.getByTestId("voice-session-strip");
  await strip.waitFor();
  await expect(talk(page)).toHaveCount(0);
  expect(await middleOf(strip)).toBeCloseTo(
    await middleOf(page.locator("main")),
    0,
  );
  expect(await page.locator("main").boundingBox()).toEqual(before);
  const captions = await page
    .getByTestId("voice-strip-captions-lines")
    .boundingBox();
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
  test(`with 12 real tabs at ${String(width)}px every control of a live session is on screen`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await open(page, "placement=top&account=1");
    await page.evaluate(() => window.__voiceTopRowProbe?.openTabs(12));
    await page.getByTestId("header-tab-strip-scroll").waitFor();
    await page.evaluate(() => window.__voiceTopRowProbe?.goLive());
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
    // Tabs fill the row, so Waiting is its glyph: the name is gone, not cut.
    const waiting = await boxOf(page.getByTestId("voice-strip-waiting"));
    expect(rightOf(waiting)).toBeLessThanOrEqual(width);
    const nameBox = await boxOf(page.getByTestId("voice-strip-waiting-box"));
    const name = await boxOf(page.getByTestId("voice-strip-waiting-name"));
    expect(name.y).toBeGreaterThanOrEqual(nameBox.y + nameBox.height);
    // Each control takes the pointer: nothing lies over it.
    for (const control of [page.getByTestId("voice-strip-mute"), end]) {
      const box = await boxOf(control);
      const hit = await control.evaluate(
        (node, [x, y]) => node.contains(document.elementFromPoint(x, y)),
        [box.x + box.width / 2, box.y + box.height / 2],
      );
      expect(hit).toBe(true);
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
    // The focus line is gone, so the state word's tooltip names the destination.
    await page.getByTestId("voice-strip-state").hover();
    await expect(page.getByRole("tooltip")).toHaveCount(1);
  });
}

for (const width of [1400, 1100, 900, 800, 768]) {
  test(`with 12 real tabs at ${String(width)}px and no session the window does not scroll sideways`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await open(page, "placement=top&account=1");
    await page.evaluate(() => window.__voiceTopRowProbe?.openTabs(12));
    await page.getByTestId("header-tab-strip-scroll").waitFor();
    await expectHeaderControlsInWindow(page, width);
    await expectFixedTabControlsClearOfZone(page);
    await expect
      .poll(async () => rightOf(await boxOf(talk(page))))
      .toBeLessThanOrEqual(width);
  });
}

// Windows and Linux keep the desktop header in a zoomed window, below the width
// where every other platform changes to the phone header, and at this one the
// row has no room for everything. Talk and the header's own controls stay; the
// window does not scroll.
test("in a zoomed Windows window with no room left the window does not scroll sideways", async ({
  page,
}) => {
  await page.setViewportSize({ width: 560, height: 800 });
  await open(page, "placement=top&wco=win&account=1");
  await page.evaluate(() => window.__voiceTopRowProbe?.openTabs(12));
  // The scroller has given up all its room: present, not visible.
  await page
    .getByTestId("header-tab-strip-scroll")
    .waitFor({ state: "attached" });
  await expectHeaderControlsInWindow(page, 560);
  const box = await boxOf(talk(page));
  const hit = await talk(page).evaluate(
    (node, [x, y]) => node.contains(document.elementFromPoint(x, y)),
    [box.x + box.width / 2, box.y + box.height / 2],
  );
  expect(hit).toBe(true);
});

test("with room to spare Waiting keeps its name", async ({ page }) => {
  await open(page, "placement=top");
  await page.evaluate(() => window.__voiceTopRowProbe?.goLive());
  const nameBox = await boxOf(page.getByTestId("voice-strip-waiting-box"));
  const name = await boxOf(page.getByTestId("voice-strip-waiting-name"));
  expect(name.y).toBe(nameBox.y);
  expect(rightOf(name)).toBeLessThanOrEqual(rightOf(nameBox));
  // The whole strip fits, and it is centred once the gap has settled.
  const main = await middleOf(page.locator("main"));
  await expect
    .poll(async () => {
      const zone = await boxOf(page.getByTestId("app-header-centre-zone"));
      return Math.abs(zone.x + zone.width / 2 - main);
    })
    .toBeLessThan(1);
  // The focus line shows the destination, so the state word opens no tooltip.
  // Waiting's tooltip shows tooltips open here; right after it, the state word's
  // would open at once, so its absence is not a matter of timing.
  await page.getByTestId("voice-strip-waiting").hover();
  await expect(page.getByRole("tooltip")).toHaveCount(1);
  await page.locator("main").hover();
  await page.locator("main").hover({ position: { x: 8, y: 8 } });
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  const state = page.getByTestId("voice-strip-state");
  await state.hover();
  await expect
    .poll(() => state.evaluate((node) => node.matches(":hover")))
    .toBe(true);
  await nextFrames(page, 3);
  await expect.poll(() => page.getByRole("tooltip").count()).toBe(0);
});
