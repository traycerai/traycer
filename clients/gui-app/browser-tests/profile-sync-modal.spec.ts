import { expect, test, type Locator, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// The Sync profiles dialog (`ProfileSyncModalHost`), in real Chrome: what
// jsdom cannot decide about it - its box inside a real viewport, whether the
// body scrolls while the header and footer stay pinned, whether long names and
// row actions stay inside it at a narrow width, that real Escape and
// outside-click input close it while a request is in flight, and how it paints
// in both themes.
//
// The fixture (`src/__tests__/browser/profile-sync-modal.tsx`) answers a fixed
// overview: one device kept in sync with two profiles that need the user, one
// never synced, one offline. It syncs nothing, so nothing here is evidence
// about real devices: the dialog's logic is in `profile-sync-modal.test.tsx`
// (jsdom), and two-device behaviour is verified against real hosts.

const DIALOG = '[data-slot="dialog-content"]';
const FOOTER = '[data-slot="dialog-footer"]';
const BODY = '[data-slot="dialog-content"] .overflow-y-auto';
const DESKTOP = { width: 1280, height: 800 };
const NARROW = { width: 390, height: 520 };
const LONG_DEVICE = /Travel laptop/;

async function openDialog(page: Page, mode: "light" | "dark"): Promise<void> {
  await page.goto(fixture("profile-sync-modal"));
  await page.waitForFunction("window.__profileSyncProbe?.ready === true");
  await page.evaluate(
    `window.__profileSyncProbe.setTheme(${JSON.stringify(mode)}); window.__profileSyncProbe.open();`,
  );
  await expect(page.locator(DIALOG)).toBeVisible();
  // Settled: the overview has answered and every device row is drawn.
  await expect(
    page.getByRole("region", { name: "Old Mac mini" }),
  ).toBeVisible();
  await nextFrames(page, 3);
}

/** Air's own list: the offline device has a "Show all 13" of its own. */
async function showAllOnAir(page: Page): Promise<void> {
  const air = page.getByRole("region", { name: "Air", exact: true });
  await air.getByRole("button", { name: "Show all 13" }).click();
  await expect(air.getByRole("button", { name: "Show fewer" })).toBeVisible();
}

async function boxOf(locator: Locator): Promise<{
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`no layout box for ${locator.toString()}`);
  return box;
}

for (const viewport of [
  { name: "desktop", size: DESKTOP },
  { name: "narrow", size: NARROW },
]) {
  test.describe(`${viewport.name} viewport`, () => {
    test.use({ viewport: viewport.size });

    test("the dialog and its footer stay inside the viewport", async ({
      page,
    }) => {
      await openDialog(page, "light");
      const dialog = await boxOf(page.locator(DIALOG));
      const footer = await boxOf(page.locator(FOOTER));
      for (const box of [dialog, footer]) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.size.width);
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.size.height);
      }
      // The page itself never scrolls: the dialog contains its own overflow.
      const pageOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(pageOverflow).toBeLessThanOrEqual(0);
    });

    test("every profile shown scrolls the body while Done stays pinned", async ({
      page,
    }) => {
      await openDialog(page, "light");
      // Expanding grows the dialog up to its cap, so the footer is measured
      // once the rows are in: what must not move it is the body scrolling.
      await showAllOnAir(page);
      await nextFrames(page, 2);
      const footerBefore = await boxOf(page.locator(FOOTER));
      const body = page.locator(BODY).first();
      const metrics = await body.evaluate((element) => ({
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }));
      if (viewport.name === "narrow") {
        // Too short to hold thirteen rows: the body, not the page or the
        // dialog box, takes the overflow.
        expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
        await body.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await nextFrames(page, 2);
        expect(
          await body.evaluate((element) => element.scrollTop),
        ).toBeGreaterThan(0);
      }
      const footerAfter = await boxOf(page.locator(FOOTER));
      expect(footerAfter.y).toBeCloseTo(footerBefore.y, 0);
      expect(footerAfter.y + footerAfter.height).toBeLessThanOrEqual(
        viewport.size.height,
      );
      await expect(page.getByRole("button", { name: "Done" })).toBeInViewport();
    });

    test("long names and row actions stay inside the dialog", async ({
      page,
    }) => {
      await openDialog(page, "light");
      await showAllOnAir(page);
      const dialog = await boxOf(page.locator(DIALOG));
      const right = dialog.x + dialog.width;
      const body = page.locator(BODY).first();
      // No row widens the body sideways.
      const sideways = await body.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      );
      expect(sideways).toBeLessThanOrEqual(0);
      for (const control of [
        page.getByRole("heading", { name: LONG_DEVICE }),
        page.getByRole("button", { name: "Sign in on Mac Studio" }),
        page.getByRole("button", { name: "Sync the new account" }),
        page.getByRole("button", { name: "Sync now" }),
        page.getByRole("switch", { name: LONG_DEVICE }),
        page.getByText(/A profile with a deliberately long name/),
      ]) {
        const box = await boxOf(control);
        expect(box.x).toBeGreaterThanOrEqual(dialog.x);
        expect(box.x + box.width).toBeLessThanOrEqual(right + 0.5);
      }
    });

    test("Escape closes the dialog while a request is in flight", async ({
      page,
    }) => {
      await openDialog(page, "light");
      await page.evaluate("window.__profileSyncProbe.holdRequests(true)");
      const syncNow = page.getByRole("button", { name: "Sync now" });
      await syncNow.click();
      // The request is in flight: its own control is the only thing disabled.
      await expect(syncNow).toBeDisabled();
      await expect(
        page.getByRole("switch", { name: "Keep Air in sync" }),
      ).toBeEnabled();
      await page.keyboard.press("Escape");
      await expect(page.locator(DIALOG)).toHaveCount(0);
      // Reopened, the same request is still shown on the control that sent it.
      await page.evaluate("window.__profileSyncProbe.open()");
      await expect(
        page.getByRole("button", { name: "Sync now" }),
      ).toBeDisabled();
    });

    test("a click outside closes the dialog while a request is in flight", async ({
      page,
    }) => {
      await openDialog(page, "light");
      await page.evaluate("window.__profileSyncProbe.holdRequests(true)");
      const keepInSync = page.getByRole("switch", { name: "Keep Air in sync" });
      await keepInSync.click();
      await expect(keepInSync).toBeDisabled();
      const dialog = await boxOf(page.locator(DIALOG));
      // A point on the dim, clear of the dialog box on both viewports.
      await page.mouse.click(
        Math.round(dialog.x + dialog.width / 2),
        Math.max(2, Math.round(dialog.y / 2)),
      );
      await expect(page.locator(DIALOG)).toHaveCount(0);
    });

    for (const mode of ["light", "dark"] as const) {
      test(`renders in the ${mode} theme`, async ({ page }, testInfo) => {
        await page.emulateMedia({ colorScheme: mode });
        await openDialog(page, mode);
        await expect(page.getByText("11 synced")).toBeVisible();
        await expect(page.getByText("2 need you")).toBeVisible();
        await expect(page.getByText("Not synced yet")).toBeVisible();
        await expect(
          page.getByText("Device offline · syncs when it connects"),
        ).toBeVisible();
        const filename = `profile-sync-${viewport.name}-${mode}.png`;
        const path = testInfo.outputPath(filename);
        const shot = await page.screenshot({ path, animations: "disabled" });
        await testInfo.attach(filename, { path, contentType: "image/png" });
        expect(shot.byteLength).toBeGreaterThan(0);
      });
    }
  });
}
