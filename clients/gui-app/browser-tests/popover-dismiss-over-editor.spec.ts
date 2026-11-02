import { expect, test, type Page } from "@playwright/test";

import { centreOf, fixture } from "./support/fixtures.ts";

// Browser regression: a popover opened from the status bar closes on the
// next press anywhere on the page - inside an artifact editor, on plain
// text, and inside a sandboxed guest frame (an HTML artifact page).
//
// Radix defers its outside-pointerdown dismissal to the gesture's `click`,
// and a press inside a sandboxed iframe produces neither event in this
// document, nor a `focusin`: without the relay the popover stayed open over
// an HTML artifact until the next click elsewhere. Only trusted input can
// decide this, since a synthetic click never moves focus into a frame.
//
// Drives `src/__tests__/browser/popover-dismiss-over-editor.html`.

test.use({ viewport: { width: 900, height: 700 }, actionTimeout: 10_000 });

function popover(page: Page) {
  return page.getByRole("dialog", { name: "Usage limits" });
}

async function openPopover(page: Page, relay: "on" | "off"): Promise<void> {
  await page.goto(`${fixture("popover-dismiss-over-editor")}?relay=${relay}`);
  await expect(page.locator("[data-artifact-editor] p").first()).toBeVisible();
  await page.getByTestId("popover-trigger").click();
  await expect(popover(page)).toBeVisible();
}

function editorParagraph(page: Page) {
  return page.locator("[data-artifact-editor] p").first();
}

async function pressIntoGuestFrame(page: Page): Promise<void> {
  const point = await centreOf(page.getByTestId("guest-frame"));
  await page.mouse.click(point.x, point.y);
  // Focus did move into the frame: the press landed there.
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.tagName))
    .toBe("IFRAME");
}

test("a click in the editor closes the popover", async ({ page }) => {
  await openPopover(page, "on");
  const point = await centreOf(editorParagraph(page));
  await page.mouse.click(point.x, point.y);
  await expect(popover(page)).toHaveCount(0);
});

test("a double-click in the editor closes the popover", async ({ page }) => {
  await openPopover(page, "on");
  const point = await centreOf(editorParagraph(page));
  await page.mouse.dblclick(point.x, point.y);
  // The double-click did select a word, so the gesture landed in the editor.
  await expect
    .poll(() => page.evaluate(() => String(getSelection()).length))
    .toBeGreaterThan(0);
  await expect(popover(page)).toHaveCount(0);
});

test("a drag-select in the editor closes the popover", async ({ page }) => {
  await openPopover(page, "on");
  const start = await centreOf(editorParagraph(page));
  await page.mouse.move(start.x - 120, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y, { steps: 4 });
  await page.mouse.move(start.x + 120, start.y + 40, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => String(getSelection()).length))
    .toBeGreaterThan(0);
  await expect(popover(page)).toHaveCount(0);
});

test("a double-click on plain text closes the popover", async ({ page }) => {
  await openPopover(page, "on");
  const point = await centreOf(page.getByTestId("plain-paragraph"));
  await page.mouse.dblclick(point.x, point.y);
  await expect(popover(page)).toHaveCount(0);
});

test("premise: a press inside a guest frame reaches no document listener", async ({
  page,
}) => {
  await openPopover(page, "off");
  await page.evaluate(() => {
    window.__guestFramePresses = 0;
    for (const type of ["pointerdown", "click"]) {
      document.addEventListener(
        type,
        () => {
          window.__guestFramePresses = (window.__guestFramePresses ?? 0) + 1;
        },
        true,
      );
    }
  });
  await pressIntoGuestFrame(page);
  // The relay is the only way a press in the frame can be heard: nothing
  // arrived on its own, and the popover is still up.
  await expect(popover(page)).toBeVisible();
  expect(await page.evaluate(() => window.__guestFramePresses)).toBe(0);
});

test("a click inside a guest frame closes the popover", async ({ page }) => {
  await openPopover(page, "on");
  await pressIntoGuestFrame(page);
  await expect(popover(page)).toHaveCount(0);
});

declare global {
  interface Window {
    __guestFramePresses?: number;
  }
}
