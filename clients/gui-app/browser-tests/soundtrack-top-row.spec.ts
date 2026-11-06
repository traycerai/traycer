import { expect, test, type Locator, type Page } from "@playwright/test";

import { fixture } from "./support/fixtures.ts";

declare global {
  interface Window {
    __soundtrackTopRowErrors?: string[];
    __soundtrackTopRowProbe?: {
      readonly fillTabs: (width: number) => void;
      readonly openTabs: (count: number) => void;
    };
  }
}

// Where the soundtrack's toggle lands is real layout: in the window's top row,
// whatever draws that row, and a drag region around it only where the window
// has no title bar of its own.

test.use({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 1 });

// Drawn because this fixture is a development build, which has a soundtrack.
const soundtrack = (page: Page): Locator =>
  page.getByRole("button", { name: "Soundtrack" });

async function open(page: Page, query: string): Promise<void> {
  await page.addInitScript(() => {
    window.__soundtrackTopRowErrors = [];
    window.addEventListener("error", (event) => {
      window.__soundtrackTopRowErrors?.push(event.message);
    });
  });
  await page.goto(`${fixture("soundtrack-top-row")}?${query}`);
  await page.waitForFunction(
    () => window.__soundtrackTopRowProbe !== undefined,
  );
  await page.locator("main").waitFor();
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
  const box = await boxOf(locator);
  return box.x + box.width / 2;
}

async function expectTakesThePointer(control: Locator): Promise<void> {
  const box = await boxOf(control);
  const hit = await control.evaluate(
    (node, [x, y]) => node.contains(document.elementFromPoint(x, y)),
    [box.x + box.width / 2, box.y + box.height / 2],
  );
  expect(hit).toBe(true);
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
  await expectTakesThePointer(newTab);
}

/** The OS drag region a node computes to: `drag`, `no-drag` or `none`. */
function appRegionOf(locator: Locator): Promise<string> {
  return locator.evaluate((node) =>
    getComputedStyle(node).getPropertyValue("-webkit-app-region"),
  );
}

/** The nearest ancestor of the toggle that states a region of its own. */
function appRegionAround(locator: Locator): Promise<string> {
  return locator.evaluate((node) => {
    for (
      let ancestor = node.parentElement;
      ancestor !== null;
      ancestor = ancestor.parentElement
    ) {
      const region =
        getComputedStyle(ancestor).getPropertyValue("-webkit-app-region");
      if (region !== "none" && region !== "") return region;
    }
    return "none";
  });
}

test("the toggle is on the middle of the header with the tabs at the top", async ({
  page,
}) => {
  await open(page, "placement=top");
  const main = await middleOf(page.locator("main"));
  const toggle = await boxOf(soundtrack(page));
  const header = await boxOf(page.getByTestId("app-header"));
  // Right of the middle, inside the header's height.
  expect(toggle.x).toBeGreaterThanOrEqual(main);
  expect(toggle.y).toBeGreaterThanOrEqual(header.y);
  expect(toggle.y + toggle.height).toBeLessThanOrEqual(
    header.y + header.height,
  );
  await expectTakesThePointer(soundtrack(page));
});

test("long tabs push the toggle right and give up only the room it needs", async ({
  page,
}) => {
  await open(page, "placement=top");
  await page.evaluate(() => window.__soundtrackTopRowProbe?.fillTabs(900));
  const tabs = page.locator("[data-fixture-tabs]");
  await expect
    .poll(async () => (await boxOf(soundtrack(page))).x)
    .toBeGreaterThan(900);
  await expect.poll(async () => (await boxOf(tabs)).width).toBe(900);
  const header = await boxOf(page.getByTestId("app-header"));
  const zone = await boxOf(page.getByTestId("app-header-centre-zone"));
  expect(rightOf(zone)).toBeLessThanOrEqual(rightOf(header));
});

test("the toggle rises into the title band, adding no height", async ({
  page,
}) => {
  await open(page, "placement=right&wco=mac");
  const row = page.getByTestId("soundtrack-top-row");
  await expect(row).toHaveAttribute("data-title-band", "band");
  await expect(soundtrack(page)).toBeVisible();
  const band = await boxOf(page.getByTestId("app-title-band"));
  const main = await boxOf(page.locator("main"));
  expect(main.y).toBe(band.y + band.height);
  expect((await boxOf(soundtrack(page))).y).toBeLessThan(band.height);
});

test("with no band a row as tall as the band carries the toggle, beside the strip of tabs", async ({
  page,
}) => {
  await open(page, "placement=left&wco=mac");
  const row = page.getByTestId("soundtrack-top-row");
  await expect(row).toHaveAttribute("data-title-band", "none");
  const rowBox = await boxOf(row);
  expect(rowBox.y).toBe(0);
  expect(rowBox.height).toBe(40);
  expect((await boxOf(page.locator("main"))).y).toBe(40);
  expect((await boxOf(page.locator("[data-fixture-strip]"))).y).toBe(0);
  expect(await middleOf(row)).toBeCloseTo(
    await middleOf(page.locator("main")),
    0,
  );
  await expectTakesThePointer(soundtrack(page));
});

test("with no band the row drags the window of a frameless desktop, outside the toggle", async ({
  page,
}) => {
  await open(page, "placement=left&wco=mac");
  expect(await appRegionOf(page.getByTestId("soundtrack-top-row"))).toBe(
    "drag",
  );
  expect(await appRegionAround(soundtrack(page))).toBe("no-drag");
});

test("with no band the row of a window with a title bar of its own is no drag region", async ({
  page,
}) => {
  await open(page, "placement=left");
  await expect(page.getByTestId("soundtrack-top-row")).toHaveAttribute(
    "data-title-band",
    "none",
  );
  expect(await appRegionOf(page.getByTestId("soundtrack-top-row"))).toBe(
    "none",
  );
});

test("in the header the toggle is outside the drag region of a frameless desktop", async ({
  page,
}) => {
  await open(page, "placement=top&wco=mac");
  expect(await appRegionAround(soundtrack(page))).toBe("no-drag");
});

for (const width of [1400, 1100, 900, 800, 768]) {
  test(`with 12 real tabs at ${String(width)}px the window does not scroll sideways and the toggle takes the pointer`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await open(page, "placement=top&account=1");
    await page.evaluate(() => window.__soundtrackTopRowProbe?.openTabs(12));
    await page.getByTestId("header-tab-strip-scroll").waitFor();
    await expectHeaderControlsInWindow(page, width);
    await expectFixedTabControlsClearOfZone(page);
    await expect
      .poll(async () => rightOf(await boxOf(soundtrack(page))))
      .toBeLessThanOrEqual(width);
    await expectTakesThePointer(soundtrack(page));
    // The tabs stop before the zone and the header's own controls fit after it.
    const zone = await boxOf(page.getByTestId("app-header-centre-zone"));
    const scroller = await boxOf(page.getByTestId("header-tab-strip-scroll"));
    expect(rightOf(scroller)).toBeLessThanOrEqual(zone.x);
    const actions = await boxOf(
      page.getByTestId("app-header").locator("> :last-child"),
    );
    expect(actions.x).toBeGreaterThanOrEqual(rightOf(zone));
    expect(await page.evaluate(() => window.__soundtrackTopRowErrors)).toEqual(
      [],
    );
  });
}

// Windows and Linux keep the desktop header in a zoomed window, below the width
// where every other platform changes to the phone header, and at this one the
// row has no room for everything. The toggle and the header's own controls
// stay; the window does not scroll.
test("in a zoomed Windows window with no room left the window does not scroll sideways and the toggle stays clear of the header's controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 560, height: 800 });
  await open(page, "placement=top&wco=win&account=1");
  await page.evaluate(() => window.__soundtrackTopRowProbe?.openTabs(12));
  // The scroller has given up all its room: present, not visible.
  await page
    .getByTestId("header-tab-strip-scroll")
    .waitFor({ state: "attached" });
  await expectHeaderControlsInWindow(page, 560);
  const toggle = await boxOf(soundtrack(page));
  expect(rightOf(toggle)).toBeLessThanOrEqual(
    rightOf(await boxOf(page.getByTestId("app-header-centre-zone"))),
  );
  await expectTakesThePointer(soundtrack(page));
});
