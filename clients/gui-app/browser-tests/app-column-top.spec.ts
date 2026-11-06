import { expect, test, type Locator, type Page } from "@playwright/test";

import { fixture } from "./support/fixtures.ts";

declare global {
  interface Window {
    __appColumnTopErrors?: string[];
    __appColumnTopProbe?: {
      readonly openTabs: (count: number) => void;
    };
  }
}

// Where the app's content starts is real layout: prod's, with nothing reserved
// above it for a music or Talk row, and a drag region at the top edge only
// where the window has no title bar of its own.

test.use({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 1 });

async function open(page: Page, query: string): Promise<void> {
  await page.addInitScript(() => {
    window.__appColumnTopErrors = [];
    window.addEventListener("error", (event) => {
      window.__appColumnTopErrors?.push(event.message);
    });
  });
  await page.goto(`${fixture("app-column-top")}?${query}`);
  await page.waitForFunction(() => window.__appColumnTopProbe !== undefined);
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

async function expectTakesThePointer(control: Locator): Promise<void> {
  const box = await boxOf(control);
  const hit = await control.evaluate(
    (node, [x, y]) => node.contains(document.elementFromPoint(x, y)),
    [box.x + box.width / 2, box.y + box.height / 2],
  );
  expect(hit).toBe(true);
}

/** Reads the controls in the header's last cluster, not the box around them. */
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

/** The OS drag region a node computes to: `drag`, `no-drag` or `none`. */
function appRegionOf(locator: Locator): Promise<string> {
  return locator.evaluate((node) =>
    getComputedStyle(node).getPropertyValue("-webkit-app-region"),
  );
}

test("tabs at the top draw no soundtrack or music button, and the content starts under the header", async ({
  page,
}) => {
  // This fixture is a development build, which offers a soundtrack.
  await open(page, "placement=top");

  await expect(
    page.getByRole("button", { name: /soundtrack|music/i }),
  ).toHaveCount(0);
  const header = await boxOf(page.getByTestId("app-header"));
  expect((await boxOf(page.locator("main"))).y).toBe(header.y + header.height);
});

for (const width of [1400, 1100, 900, 800, 768]) {
  test(`with 12 real tabs at ${String(width)}px the window does not scroll sideways and New tab takes the pointer`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await open(page, "placement=top&account=1");
    await page.evaluate(() => window.__appColumnTopProbe?.openTabs(12));
    await page.getByTestId("header-tab-strip-scroll").waitFor();
    await expectHeaderControlsInWindow(page, width);
    await expectTakesThePointer(page.getByTestId("tab-new"));
    expect(await page.evaluate(() => window.__appColumnTopErrors)).toEqual([]);
  });
}

// Windows and Linux keep the desktop header in a zoomed window narrower than
// the phone header's breakpoint. The menu, the arrows and the account controls
// already fill the row there, so the tabs may not reserve room of their own.
test("in a zoomed Windows window the header's controls stay clear of the caption buttons", async ({
  page,
}) => {
  await page.setViewportSize({ width: 560, height: 800 });
  await open(page, "placement=top&wco=win&account=1");
  await page.evaluate(() => window.__appColumnTopProbe?.openTabs(12));
  await expect(
    page
      .getByRole("menubar", { name: "Application menu" })
      .getByRole("menuitem"),
  ).toHaveCount(5);
  await expect(page.getByTestId("notifications-bell")).toBeVisible();
  await expect(page.getByTestId("user-menu-trigger")).toBeVisible();
  const header = page.getByTestId("app-header");
  const limit = await header.evaluate(
    (node) =>
      window.innerWidth - parseFloat(getComputedStyle(node).paddingRight),
  );
  await expect
    .poll(() =>
      header
        .locator("> :last-child")
        .locator("button, a")
        .evaluateAll((nodes) =>
          Math.max(...nodes.map((node) => node.getBoundingClientRect().right)),
        ),
    )
    .toBeLessThanOrEqual(limit);
  const sideways = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(sideways).toBe(0);
});

for (const query of ["placement=right&wco=mac", "placement=left&wco=win"]) {
  test(`side tabs under a title band (${query}) start the content at the band's bottom`, async ({
    page,
  }) => {
    await open(page, query);

    const band = await boxOf(page.getByTestId("app-title-band"));
    expect((await boxOf(page.locator("main"))).y).toBe(band.y + band.height);
  });
}

test("side tabs with no band on a frameless mac start the content and the strip at the window's top, and drag from the strip's top block", async ({
  page,
}) => {
  await open(page, "placement=left&wco=mac");

  expect((await boxOf(page.locator("main"))).y).toBe(0);
  const block = page.getByTestId("side-strip-top-block");
  expect((await boxOf(block)).y).toBe(0);
  expect(await appRegionOf(page.getByTestId("side-strip-title-row"))).toBe(
    "drag",
  );
  const buttons = block.getByRole("button");
  await expect(buttons.first()).toBeVisible();
  const regions = await buttons.evaluateAll((nodes) =>
    nodes.map((node) => {
      for (
        let current: Element | null = node;
        current !== null;
        current = current.parentElement
      ) {
        const region =
          getComputedStyle(current).getPropertyValue("-webkit-app-region");
        if (region !== "none" && region !== "") return region;
      }
      return "none";
    }),
  );
  expect(new Set(regions)).toEqual(new Set(["no-drag"]));
});

test("side tabs in a browser window start the content at the top, and nothing computes a drag region", async ({
  page,
}) => {
  await open(page, "placement=left");

  expect((await boxOf(page.locator("main"))).y).toBe(0);
  const drags = await page.evaluate(
    () =>
      [...document.querySelectorAll("*")].filter(
        (node) =>
          getComputedStyle(node).getPropertyValue("-webkit-app-region") ===
          "drag",
      ).length,
  );
  expect(drags).toBe(0);
});
