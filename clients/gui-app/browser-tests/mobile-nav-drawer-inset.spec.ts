import { expect, test, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// A landscape phone turns its notch toward one edge, and the drawer's panel
// has to keep clear of it. Parked off screen the panel ends at the screen's
// edge, so none of it shows in the inset's strip; open, it rests just clear
// of the inset. jsdom has no layout, so where the panel's box ends up, and
// whether it follows a change of the inset that leaves the viewport as it
// was, is something only a browser answers. This renders the production
// surface and moves the inset through the property `index.css` reads it by.

declare global {
  interface Window {
    /** The fixture's handle on the drawer's `open`. */
    __drawerProbe?: { readonly setOpen: (open: boolean) => void };
  }
}

const PANEL = '[data-testid="mobile-nav-drawer"]';
const INSET_PX = 62;

// A landscape phone.
test.use({ viewport: { width: 874, height: 402 } });

async function setInset(page: Page, px: number): Promise<void> {
  await page.evaluate((value: number) => {
    document.documentElement.style.setProperty(
      "--safe-area-inset-left",
      `${String(value)}px`,
    );
  }, px);
}

async function openFixture(page: Page, insetPx: number): Promise<void> {
  await page.goto(fixture("mobile-nav-drawer-inset"));
  await expect(page.locator(PANEL)).toBeAttached();
  await setInset(page, insetPx);
  await nextFrames(page, 2);
}

async function setOpen(page: Page, open: boolean): Promise<void> {
  await page.evaluate((next: boolean) => {
    if (window.__drawerProbe === undefined) throw new Error("no probe");
    window.__drawerProbe.setOpen(next);
  }, open);
}

async function panelEdges(
  page: Page,
): Promise<{ readonly left: number; readonly right: number }> {
  return page.locator(PANEL).evaluate((panel) => {
    const box = panel.getBoundingClientRect();
    return { left: box.left, right: box.right };
  });
}

async function settleOpen(page: Page): Promise<void> {
  await setOpen(page, true);
  await expect(page.locator(PANEL)).toHaveAttribute(
    "data-overlay-surface",
    "open",
  );
}

test.describe("a left inset", () => {
  test("the closed panel ends at the screen's edge, clear of the inset's strip", async ({
    page,
  }) => {
    await openFixture(page, INSET_PX);
    await expect
      .poll(async () => (await panelEdges(page)).right)
      .toBeLessThanOrEqual(0);
  });

  test("the open panel rests at the inset", async ({ page }) => {
    await openFixture(page, INSET_PX);
    await settleOpen(page);
    await expect
      .poll(async () => (await panelEdges(page)).left)
      .toBeCloseTo(INSET_PX, 0);
  });

  test("an inset that changes under an open drawer moves it to the new inset", async ({
    page,
  }) => {
    await openFixture(page, INSET_PX);
    await settleOpen(page);
    await expect
      .poll(async () => (await panelEdges(page)).left)
      .toBeCloseTo(INSET_PX, 0);

    await setInset(page, 0);

    await expect
      .poll(async () => (await panelEdges(page)).left)
      .toBeCloseTo(0, 0);
    await expect(page.locator(PANEL)).toHaveAttribute(
      "data-overlay-surface",
      "open",
    );
  });

  test("an inset that changes under a closed drawer keeps it off screen", async ({
    page,
  }) => {
    await openFixture(page, 0);
    await setInset(page, INSET_PX);
    await nextFrames(page, 2);
    await expect
      .poll(async () => (await panelEdges(page)).right)
      .toBeLessThanOrEqual(0);
  });
});

test.describe("no inset", () => {
  test("the closed panel ends at the screen's edge", async ({ page }) => {
    await openFixture(page, 0);
    await expect
      .poll(async () => (await panelEdges(page)).right)
      .toBeLessThanOrEqual(0);
  });

  test("the open panel rests at the screen's edge", async ({ page }) => {
    await openFixture(page, 0);
    await settleOpen(page);
    await expect
      .poll(async () => (await panelEdges(page)).left)
      .toBeCloseTo(0, 0);
  });
});
