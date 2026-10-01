import { expect, test, type Locator, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// The Activity view's sections in real Chrome: the claims only real layout
// answers. Which task is in which section, the second line's words and the
// folding are in `side-tab-strip.test.tsx`; here the rows' real heights, what
// hovering does to a two-line row and to a one-line row's meter, and what
// gives way first at the narrowest width.

test.use({ viewport: { width: 900, height: 900 } });

const STRIP = `${fixture("side-tab-strip")}?edge=left&scene=sections`;

async function openStrip(page: Page): Promise<void> {
  await page.goto(STRIP);
  await page.waitForFunction("window.__sideTabStripProbe?.ready === true");
  await nextFrames(page, 4);
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`no layout box for ${locator.toString()}`);
  return box;
}

const row = (page: Page, id: string): Locator =>
  page.getByTestId(`tab-epic-fixture-${id}`);

const closeWrapper = (page: Page, id: string): Locator =>
  row(page, id).getByTestId(`tab-close-epic-fixture-${id}`).locator("..");

test("draws Needs you and To review rows 52px tall and Working and Idle rows 32px tall", async ({
  page,
}) => {
  await openStrip(page);

  for (const id of ["staging", "onboarding", "release", "migration"]) {
    expect((await boxOf(row(page, id))).height).toBe(52);
  }
  for (const id of ["gui", "cookie", "host", "layout", "launch", "react"]) {
    expect((await boxOf(row(page, id))).height).toBe(32);
  }
});

test("colours only the Needs you header amber", async ({ page }) => {
  await openStrip(page);

  const colourOf = (section: string): Promise<string> =>
    page
      .getByTestId(`side-strip-section-${section}`)
      .evaluate((node) => getComputedStyle(node).color);
  const needsYou = await colourOf("needs-you");
  const others = await Promise.all(
    ["to-review", "working", "idle"].map(colourOf),
  );

  expect(new Set(others).size).toBe(1);
  expect(others[0]).not.toBe(needsYou);
});

test("starts every title on the row's padding, and does not move it on hover", async ({
  page,
}) => {
  await openStrip(page);

  for (const id of ["staging", "cookie", "react"]) {
    const target = row(page, id);
    const title = target
      .getByTestId("side-tab-title")
      .locator(".header-tab-title-text");
    const rowBox = await boxOf(target);
    const atRest = await boxOf(title);
    expect(atRest.x - rowBox.x).toBeCloseTo(8, 0);

    await target.hover();
    await nextFrames(page, 2);

    expect((await boxOf(title)).x).toBeCloseTo(atRest.x, 1);
  }
});

test("keeps a two-line row's time on hover, and the close joins after it", async ({
  page,
}) => {
  await openStrip(page);
  const staging = row(page, "staging");
  const time = staging.getByTestId("side-tab-section-time");
  const close = closeWrapper(page, "staging");
  await expect(close).toHaveCSS("opacity", "0");
  const timeAtRest = await boxOf(time);

  await staging.hover();

  await expect(close).toHaveCSS("opacity", "1");
  await expect(time).toHaveCSS("opacity", "1");
  const timeHovered = await boxOf(time);
  const closeBox = await boxOf(
    staging.getByTestId("tab-close-epic-fixture-staging"),
  );
  // The time steps aside for the close, which sits on the title's line.
  expect(closeBox.x).toBeGreaterThanOrEqual(timeHovered.x + timeHovered.width);
  expect(timeAtRest.x - timeHovered.x).toBeCloseTo(20, 0);
  const titleBox = await boxOf(
    staging.getByTestId("side-tab-title").locator(".header-tab-title-text"),
  );
  expect(closeBox.y + closeBox.height / 2).toBeCloseTo(
    titleBox.y + titleBox.height / 2,
    0,
  );
});

test("has a one-line row's meter fade out where the close fades in, and the title does not move", async ({
  page,
}) => {
  await openStrip(page);
  const cookie = row(page, "cookie");
  const meter = cookie.getByTestId("side-tab-meter");
  const close = closeWrapper(page, "cookie");
  const title = cookie
    .getByTestId("side-tab-title")
    .locator(".header-tab-title-text");
  await expect(meter).toBeVisible();
  await expect(close).toHaveCSS("opacity", "0");
  const titleAtRest = await boxOf(title);

  await cookie.hover();

  await expect(close).toHaveCSS("opacity", "1");
  await expect(meter.locator("xpath=..")).toHaveCSS("opacity", "0");
  const titleHovered = await boxOf(title);
  expect(titleHovered.x).toBeCloseTo(titleAtRest.x, 1);
  expect(titleHovered.width).toBeCloseTo(titleAtRest.width, 1);
});

test("cuts the title short before the time and the close at 192px", async ({
  page,
}) => {
  await openStrip(page);
  await page.evaluate("window.__sideTabStripProbe.setWidth(192)");
  await nextFrames(page, 3);
  const staging = row(page, "staging");
  const title = staging
    .getByTestId("side-tab-title")
    .locator(".header-tab-title-text");
  const time = staging.getByTestId("side-tab-section-time");

  expect(
    await title.evaluate((node) => node.scrollWidth > node.clientWidth),
  ).toBe(true);
  expect(
    await time.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  const rowBox = await boxOf(staging);

  await staging.hover();
  await nextFrames(page, 2);

  const closeBox = await boxOf(
    staging.getByTestId("tab-close-epic-fixture-staging"),
  );
  const timeBox = await boxOf(time);
  expect(timeBox.x + timeBox.width).toBeLessThanOrEqual(closeBox.x + 0.5);
  expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(
    rowBox.x + rowBox.width,
  );
  // The second line gives way to its own edge and does not overflow the row.
  const detail = staging.getByTestId("side-tab-section-detail");
  const detailBox = await boxOf(detail);
  expect(detailBox.x + detailBox.width).toBeLessThanOrEqual(
    rowBox.x + rowBox.width,
  );
});

test("signing in, keeps the device code's wait and its expiry apart in the strip's foot", async ({
  page,
}) => {
  await openStrip(page);
  await page.getByRole("button", { name: "Sign in" }).click();
  const waiting = await boxOf(page.getByText("Waiting for approval"));
  const expiry = await boxOf(page.getByText(/^Expires in/));

  const beside = waiting.x + waiting.width <= expiry.x;
  const below = waiting.y + waiting.height <= expiry.y;
  expect(beside || below).toBe(true);
});

test("signing in at 192px, keeps the device code on one line, clear of its copy button", async ({
  page,
}) => {
  await openStrip(page);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.evaluate("window.__sideTabStripProbe.setWidth(192)");
  await nextFrames(page, 3);
  const code = page.getByTestId("signin-device-code");
  const copy = await boxOf(
    page.getByRole("button", { name: "Copy device code" }),
  );
  const text = await code.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const box = range.getBoundingClientRect();
    return { lines: range.getClientRects().length, right: box.right };
  });

  expect(await code.textContent()).toBe("ABCDE-FGHIJ");
  expect(text.lines).toBe(1);
  expect(text.right).toBeLessThanOrEqual(copy.x);
});

test("signing in, pads the code panel's foot as much as its head", async ({
  page,
}) => {
  await openStrip(page);
  await page.getByRole("button", { name: "Sign in" }).click();
  const panel = page.getByTestId("signin-device-fallback-content");
  const box = await boxOf(panel);
  const border = await panel.evaluate((node) =>
    parseFloat(getComputedStyle(node).borderTopWidth),
  );
  // From the first label's top, and from the last field's own box: anything
  // the field holds room for under it is space at the foot.
  const label = await boxOf(panel.getByText("Device code"));
  const field = await boxOf(
    page.getByTestId("signin-device-url").locator(".."),
  );

  expect(box.y + box.height - (field.y + field.height)).toBe(
    label.y - box.y - border,
  );
});

test("fades a second line at the edge at 192px, as the title does, instead of ending in an ellipsis", async ({
  page,
}) => {
  await openStrip(page);
  await page.evaluate("window.__sideTabStripProbe.setWidth(192)");
  await nextFrames(page, 3);
  const staging = row(page, "staging");
  const title = staging
    .getByTestId("side-tab-title")
    .locator(".header-tab-title-text");
  const detailText = staging
    .getByTestId("side-tab-section-detail")
    .locator(".header-tab-title-text");
  const faded = (locator: Locator) =>
    locator.evaluate((node) => {
      const style = getComputedStyle(node);
      return { mask: style.maskImage, overflow: style.textOverflow };
    });

  expect(
    await detailText.evaluate((node) => node.scrollWidth > node.clientWidth),
  ).toBe(true);
  expect(await faded(detailText)).toEqual(await faded(title));
  expect((await faded(detailText)).overflow).toBe("clip");
});
