import { expect, test, type Locator, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// The Sync profiles dialog (`ProfileCopyFlowHost`, `sync` view), in real
// Chrome: what jsdom cannot decide about it - its box inside a real viewport,
// whether the body scrolls while the header and footer stay pinned, hit
// testing on the provider picker and destination rows, and how it paints in
// both themes.
//
// The fixture (`src/__tests__/browser/profile-sync-modal.tsx`) answers a
// provider catalog, an empty sync history and an empty preview. It simulates
// no transfer, so nothing here is evidence about real devices: the logic is in
// `profile-sync-modal.test.tsx` (jsdom). The Automatic sync rule editor is
// shown only as layout; saving a rule is not exercised. Two-device behaviour is NOT covered
// here and still requires verification against real hosts.

const DIALOG = '[data-slot="dialog-content"]';
const FOOTER = '[data-slot="dialog-footer"]';
const BODY = '[data-slot="dialog-content"] .overflow-y-auto';
const DESKTOP = { width: 1280, height: 800 };
const SMALL = { width: 390, height: 520 };

async function openDialog(page: Page, mode: "light" | "dark"): Promise<void> {
  await page.goto(fixture("profile-sync-modal"));
  await page.waitForFunction("window.__profileSyncProbe?.ready === true");
  await page.evaluate(
    `window.__profileSyncProbe.setTheme(${JSON.stringify(mode)}); window.__profileSyncProbe.open(null);`,
  );
  await expect(page.locator(DIALOG)).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Build VM/ })).toBeVisible();
  await nextFrames(page, 3);
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
  { name: "small", size: SMALL },
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

    test("the tab strip sits above the scroll body without overlapping it", async ({
      page,
    }) => {
      await openDialog(page, "light");
      const tabs = await boxOf(page.getByRole("tablist"));
      const body = await boxOf(page.locator(BODY).first());
      expect(tabs.height).toBeGreaterThan(0);
      expect(tabs.y + tabs.height).toBeLessThanOrEqual(body.y + 0.5);
      // The first section's heading starts below the tabs, not under them.
      const heading = await boxOf(
        page.getByRole("heading", { name: "Providers" }),
      );
      expect(heading.y).toBeGreaterThanOrEqual(tabs.y + tabs.height);
    });

    test("the body scrolls while the footer stays pinned", async ({ page }) => {
      await openDialog(page, "light");
      const body = page.locator(BODY).first();
      const footerBefore = await boxOf(page.locator(FOOTER));
      const metrics = await body.evaluate((element) => ({
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }));
      if (viewport.name === "small") {
        // Too short to hold every row: the body, not the page, takes the overflow.
        expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
        await body.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await nextFrames(page, 2);
        const scrolled = await body.evaluate((element) => element.scrollTop);
        expect(scrolled).toBeGreaterThan(0);
      }
      const footerAfter = await boxOf(page.locator(FOOTER));
      expect(footerAfter.y).toBeCloseTo(footerBefore.y, 0);
      await expect(
        page.getByRole("button", { name: "Sync now" }),
      ).toBeInViewport();
    });

    test("provider picker and destination rows take real input", async ({
      page,
    }) => {
      await openDialog(page, "light");
      const trigger = page.getByRole("button", { name: "Choose providers" });
      await trigger.click();
      await expect(page.getByRole("option", { name: /Claude/ })).toBeVisible();
      await page.keyboard.press("Escape");
      // No device is chosen by default; picking one updates the footer.
      await expect(page.getByText("Choose destination devices.")).toBeVisible();
      await page.getByRole("checkbox", { name: /Build VM/ }).click();
      await expect(page.getByText("Choose destination devices.")).toHaveCount(
        0,
      );
      // The long device name truncates inside its row instead of widening it.
      const row = page.getByRole("checkbox", { name: /Travel laptop/ });
      await expect(row).toBeVisible();
      const dialog = await boxOf(page.locator(DIALOG));
      const rowBox = await boxOf(row);
      expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(
        dialog.x + dialog.width,
      );
    });

    for (const mode of ["light", "dark"] as const) {
      test(`automatic rule editor with the provider picker open in the ${mode} theme`, async ({
        page,
      }, testInfo) => {
        await page.emulateMedia({ colorScheme: mode });
        await openDialog(page, mode);
        await page.getByRole("tab", { name: /Automatic sync/ }).click();
        await page.getByRole("button", { name: "Add device" }).click();
        await expect(page.getByText("Add automatic sync")).toBeVisible();
        await page
          .getByRole("combobox", { name: "Destination device" })
          .click();
        await page.getByRole("option", { name: /Build VM/ }).click();
        // A new rule starts with every provider chosen, so both show in the picker.
        const trigger = page.getByRole("button", { name: "Choose providers" });
        await expect(trigger).toContainText("Claude");
        await expect(trigger).toContainText("Codex");
        await trigger.click();
        await expect(
          page.getByRole("option", { name: /Claude/ }),
        ).toBeVisible();
        await expect(page.getByRole("option", { name: /Codex/ })).toBeVisible();
        const dialog = await boxOf(page.locator(DIALOG));
        for (const name of [/Claude/, /Codex/]) {
          const option = await boxOf(page.getByRole("option", { name }));
          expect(option.y).toBeGreaterThanOrEqual(0);
          expect(option.y + option.height).toBeLessThanOrEqual(
            viewport.size.height,
          );
          expect(option.x + option.width).toBeLessThanOrEqual(
            viewport.size.width,
          );
        }
        expect(dialog.y + dialog.height).toBeLessThanOrEqual(
          viewport.size.height,
        );
        await nextFrames(page, 3);
        const filename = `profile-sync-rule-editor-${viewport.name}-${mode}.png`;
        const path = testInfo.outputPath(filename);
        await page.screenshot({ path, animations: "disabled" });
        await testInfo.attach(filename, { path, contentType: "image/png" });
      });
    }

    for (const mode of ["light", "dark"] as const) {
      test(`renders in the ${mode} theme`, async ({ page }, testInfo) => {
        await page.emulateMedia({ colorScheme: mode });
        await openDialog(page, mode);
        await page.getByRole("checkbox", { name: /Build VM/ }).click();
        // Settled: the footer has left "Checking selection…" for the preview's count.
        await expect(
          page.getByText("0 profile transfers selected"),
        ).toBeVisible();
        // The click scrolled the row into view; capture the top-of-modal composition.
        await page
          .locator(BODY)
          .first()
          .evaluate((element) => {
            element.scrollTop = 0;
          });
        await nextFrames(page, 3);
        const filename = `profile-sync-${viewport.name}-${mode}.png`;
        const path = testInfo.outputPath(filename);
        const shot = await page.screenshot({ path, animations: "disabled" });
        await testInfo.attach(filename, { path, contentType: "image/png" });
        expect(shot.byteLength).toBeGreaterThan(0);
      });
    }
  });
}
