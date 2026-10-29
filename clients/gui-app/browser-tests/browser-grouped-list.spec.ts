import { expect, test, type Locator, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// The grouped browser list (`BrowsersPanelBody` and the task switcher's
// `SwitcherBrowsersList`) in real Chrome, over a seeded three-device catalog.
// What jsdom cannot decide is here: whether long device names, titles and URLs
// overflow a narrow column, whether the count and close controls stay on the
// row, and what real Tab / Enter / Space / arrow / Escape do to focus.
// The grouping, collapse memory, search expansion and offline rules are in
// `epic-browser-sidebar.test.tsx`, `use-browser-list-model.test.tsx` and
// `switcher-browsers-list.test.tsx`.

test.use({ viewport: { width: 900, height: 700 } });

const LOCAL = "fx-local";
const WORK = "fx-work";

async function openList(
  page: Page,
  options: { readonly width: number; readonly mobile: boolean },
): Promise<void> {
  await openListWith(page, options, "");
}

async function openListWith(
  page: Page,
  options: { readonly width: number; readonly mobile: boolean },
  extra: string,
): Promise<void> {
  const surface = options.mobile ? "&surface=mobile" : "";
  await page.goto(
    `${fixture("browser-grouped-list")}?width=${String(options.width)}${surface}${extra}`,
  );
  await page.waitForFunction(
    "window.__browserGroupedListProbe?.ready === true",
  );
  await expect(page.getByTestId(`browser-device-group-${WORK}`)).toBeVisible();
  await nextFrames(page, 4);
}

const panel = (page: Page): Locator => page.locator("[data-fixture-panel]");
const group = (page: Page, hostId: string): Locator =>
  page.getByTestId(`browser-device-group-${hostId}`);
const header = (page: Page, hostId: string): Locator =>
  group(page, hostId)
    .getByRole("button", { expanded: true })
    .or(group(page, hostId).getByRole("button", { expanded: false }))
    .first();

/** A menu fades in; a picture taken mid-fade shows half-painted text. */
async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations().map((animation) => animation.finished),
    ),
  );
  await nextFrames(page, 2);
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`no layout box for ${locator.toString()}`);
  return box;
}

async function hasHorizontalOverflow(locator: Locator): Promise<boolean> {
  return locator.evaluate(
    (element) => element.scrollWidth > element.clientWidth,
  );
}

for (const width of [280, 720]) {
  test(`at ${String(width)}px a long device name truncates and the count stays inside its header`, async ({
    page,
  }) => {
    await openList(page, { width, mobile: false });
    const workHeader = header(page, WORK);
    const headerBox = await boxOf(workHeader);
    const countBox = await boxOf(group(page, WORK).getByLabel("2 tabs"));
    const panelBox = await boxOf(panel(page));

    expect(headerBox.x + headerBox.width).toBeLessThanOrEqual(
      panelBox.x + panelBox.width + 0.5,
    );
    expect(countBox.x + countBox.width).toBeLessThanOrEqual(
      headerBox.x + headerBox.width + 0.5,
    );
    expect(await hasHorizontalOverflow(panel(page))).toBe(false);
    if (width === 280) {
      const name = workHeader.locator("span.truncate").first();
      expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
        true,
      );
    }
  });

  test(`at ${String(width)}px a long title and URL truncate on the row and keep close inside the column`, async ({
    page,
  }) => {
    await openList(page, { width, mobile: false });
    const row = page.getByTestId("epic-browser-sidebar-row-work-long");
    const close = row.getByRole("button", { name: /^Close/ });
    const rowBox = await boxOf(row);
    const panelBox = await boxOf(panel(page));

    expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(
      panelBox.x + panelBox.width + 0.5,
    );
    await row.hover();
    const closeBox = await boxOf(close);
    expect(closeBox.x).toBeGreaterThanOrEqual(rowBox.x);
    expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(
      rowBox.x + rowBox.width + 0.5,
    );
    expect(await hasHorizontalOverflow(panel(page))).toBe(false);
  });
}

test("a group header toggles from the keyboard and keeps focus", async ({
  page,
}) => {
  await openList(page, { width: 360, mobile: false });
  const workHeader = header(page, WORK);
  const rows = group(page, WORK).locator(
    '[data-testid^="epic-browser-sidebar-row-"]',
  );
  await workHeader.focus();
  await expect(workHeader).toBeFocused();
  await expect(rows.first()).toBeVisible();

  await page.keyboard.press("Enter");
  await expect(workHeader).toHaveAttribute("aria-expanded", "false");
  await expect(rows.first()).toBeHidden();
  await expect(workHeader).toBeFocused();

  await page.keyboard.press("Space");
  await expect(workHeader).toHaveAttribute("aria-expanded", "true");
  await expect(rows.first()).toBeVisible();

  await page.keyboard.press("ArrowLeft");
  await expect(workHeader).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowRight");
  await expect(workHeader).toHaveAttribute("aria-expanded", "true");
  await expect(workHeader).toBeFocused();
});

test("a collapsed group takes its rows out of the tab order", async ({
  page,
}) => {
  await openList(page, { width: 360, mobile: false });
  const workHeader = header(page, WORK);
  await workHeader.focus();
  await page.keyboard.press("Enter");
  await expect(workHeader).toHaveAttribute("aria-expanded", "false");

  await page.keyboard.press("Tab");

  const focusedInsideWork = await page.evaluate(
    (id) =>
      document.activeElement !== null &&
      document
        .querySelector(`[data-testid="browser-device-group-${id}"]`)
        ?.contains(document.activeElement) === true &&
      document.activeElement.tagName === "BUTTON" &&
      document.activeElement.getAttribute("aria-expanded") === null,
    WORK,
  );
  expect(focusedInsideWork).toBe(false);
});

test("the device picker opens from the keyboard, lists every device and returns focus on Escape", async ({
  page,
}) => {
  await openList(page, { width: 360, mobile: false });
  const add = page.getByTestId("epic-browsers-panel-add");
  await add.focus();

  await page.keyboard.press("Enter");

  const picker = page.getByTestId("browser-create-device-picker");
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("menuitem")).toHaveCount(3);
  await expect(
    picker.getByRole("menuitem").filter({ hasText: "This Mac" }),
  ).toBeVisible();
  await settleAnimations(page);
  // Every device keeps a readable name beside its status word, and short
  // names are not cut at all.
  for (const item of await picker.getByRole("menuitem").all()) {
    const name = item.locator("span.truncate").first();
    expect((await boxOf(name)).width).toBeGreaterThanOrEqual(48);
  }
  for (const short of ["This Mac", "Lab"]) {
    const name = picker
      .getByRole("menuitem")
      .filter({ hasText: short })
      .locator("span.truncate")
      .first();
    expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
      false,
    );
  }
  const pickerBox = await boxOf(picker);
  expect(pickerBox.x).toBeGreaterThanOrEqual(0);
  expect(pickerBox.x + pickerBox.width).toBeLessThanOrEqual(900);

  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(add).toBeFocused();
});

test("the offline filter opens from the keyboard and returns focus on Escape", async ({
  page,
}) => {
  await openList(page, { width: 360, mobile: false });
  const filter = page.getByTestId("epic-browsers-panel-filter");
  await filter.focus();

  await page.keyboard.press("Enter");

  const menu = page.getByTestId("epic-browsers-panel-filter-menu");
  await expect(
    menu.getByRole("menuitemcheckbox", { name: "Show offline devices" }),
  ).toBeVisible();
  await settleAnimations(page);
  // Each label sits on one line: a single-line item is one row high.
  const checkbox = menu.getByRole("menuitemcheckbox", {
    name: "Show offline devices",
  });
  const submenu = menu.getByRole("menuitem", { name: "Open links on" });
  expect((await boxOf(checkbox)).height).toBeLessThan(40);
  expect((await boxOf(submenu)).height).toBeLessThan(40);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(filter).toBeFocused();
});

test("search from the header field narrows to a matching device and reveals it", async ({
  page,
}) => {
  await openList(page, { width: 360, mobile: false });
  await page.getByTestId("epic-browsers-panel-search").click();
  const input = page
    .getByRole("searchbox", { name: "Search browsers" })
    .or(page.getByLabel("Search browsers"))
    .first();
  await expect(input).toBeFocused();

  await page.keyboard.type("router");

  await expect(group(page, "fx-lab")).toBeVisible();
  await expect(group(page, WORK)).toHaveCount(0);
  await expect(group(page, LOCAL)).toHaveCount(0);
});

test("the task switcher shows the same groups at phone width with touch-sized headers and no overflow", async ({
  page,
}) => {
  await openList(page, { width: 360, mobile: true });

  await expect(group(page, LOCAL)).toBeVisible();
  await expect(group(page, WORK)).toBeVisible();
  expect((await boxOf(header(page, WORK))).height).toBeGreaterThanOrEqual(44);
  expect(await hasHorizontalOverflow(panel(page))).toBe(false);

  await header(page, WORK).focus();
  await page.keyboard.press("Enter");
  await expect(header(page, WORK)).toHaveAttribute("aria-expanded", "false");
});

// Rendered evidence for review: a screenshot of each configuration, attached
// to the test report. The claims above are geometric; these are for eyes.
for (const shot of [
  { name: "narrow-280", width: 280, mobile: false },
  { name: "wide-720", width: 720, mobile: false },
  { name: "mobile-360", width: 360, mobile: true },
]) {
  test(`renders ${shot.name}`, async ({ page }, testInfo) => {
    await openList(page, { width: shot.width, mobile: shot.mobile });
    const path = testInfo.outputPath(`${shot.name}.png`);
    await panel(page).screenshot({ path });
    await testInfo.attach(shot.name, { path, contentType: "image/png" });
    expect(await hasHorizontalOverflow(panel(page))).toBe(false);
  });
}

test("renders the open device picker", async ({ page }, testInfo) => {
  await openList(page, { width: 360, mobile: false });
  await page.getByTestId("epic-browsers-panel-add").click();
  await expect(page.getByTestId("browser-create-device-picker")).toBeVisible();
  await settleAnimations(page);
  const path = testInfo.outputPath("device-picker.png");
  await page.screenshot({ path });
  await testInfo.attach("device-picker", { path, contentType: "image/png" });
});

test("renders the open filter menu", async ({ page }, testInfo) => {
  await openList(page, { width: 360, mobile: false });
  await page.getByTestId("epic-browsers-panel-filter").click();
  await expect(
    page.getByTestId("epic-browsers-panel-filter-menu"),
  ).toBeVisible();
  await settleAnimations(page);
  const path = testInfo.outputPath("filter-menu.png");
  await page.screenshot({ path });
  await testInfo.attach("filter-menu", { path, contentType: "image/png" });
});

test("a confirmed-offline device is labelled Offline inside its header once offline devices are shown", async ({
  page,
}, testInfo) => {
  await openListWith(page, { width: 280, mobile: false }, "&offline=1");
  const lab = group(page, "fx-lab");
  await expect(lab).toBeVisible();
  const labHeader = header(page, "fx-lab");
  const label = labHeader.getByText("Offline");
  await expect(label).toBeVisible();
  const headerBox = await boxOf(labHeader);
  const labelBox = await boxOf(label);
  expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(
    headerBox.x + headerBox.width + 0.5,
  );
  expect(await hasHorizontalOverflow(panel(page))).toBe(false);
  const path = testInfo.outputPath("offline-280.png");
  await panel(page).screenshot({ path });
  await testInfo.attach("offline-280", { path, contentType: "image/png" });
});
