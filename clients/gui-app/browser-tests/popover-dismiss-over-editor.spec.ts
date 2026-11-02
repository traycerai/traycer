import { expect, test, type Locator, type Page } from "@playwright/test";

import { centreOf, fixture } from "./support/fixtures.ts";

// Browser regression: a popover opened from the status bar closes on the
// next press anywhere on the page - inside an artifact editor, on plain
// text, and inside the sandboxed frame an HTML artifact page renders in.
//
// Radix defers its outside-pointerdown dismissal to the gesture's `click`,
// and a press inside a sandboxed iframe produces neither event in this
// document, nor a `focusin`: without the relay the popover stayed open over
// an HTML artifact until the next click elsewhere. Only trusted input can
// decide this, since a synthetic click never moves focus into a frame.
//
// Drives `src/__tests__/browser/popover-dismiss-over-editor.html`.

test.use({ viewport: { width: 900, height: 900 }, actionTimeout: 10_000 });

function popover(page: Page) {
  return page.getByRole("dialog", { name: "Usage limits" });
}

async function loadFixture(page: Page): Promise<void> {
  await page.goto(fixture("popover-dismiss-over-editor"));
  await expect(page.locator("[data-artifact-editor] p").first()).toBeVisible();
  await page.waitForFunction(
    () => document.body.dataset.sandboxStatus === "ready",
  );
}

async function openPopover(page: Page): Promise<void> {
  await loadFixture(page);
  await page.getByTestId("popover-trigger").click();
  await expect(popover(page)).toBeVisible();
}

function editorParagraph(page: Page) {
  return page.locator("[data-artifact-editor] p").first();
}

function artifactPageFrame(page: Page) {
  return page.getByTestId("sandbox-frame").locator("iframe");
}

async function pressIntoFrame(page: Page, frame: Locator): Promise<void> {
  const point = await centreOf(frame);
  await page.mouse.click(point.x, point.y);
  // Focus did move into the frame: the press landed there.
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.tagName))
    .toBe("IFRAME");
}

test("a click in the editor closes the popover", async ({ page }) => {
  await openPopover(page);
  const point = await centreOf(editorParagraph(page));
  await page.mouse.click(point.x, point.y);
  await expect(popover(page)).toHaveCount(0);
});

test("a double-click in the editor closes the popover", async ({ page }) => {
  await openPopover(page);
  const point = await centreOf(editorParagraph(page));
  await page.mouse.dblclick(point.x, point.y);
  // The double-click did select a word, so the gesture landed in the editor.
  await expect
    .poll(() => page.evaluate(() => String(getSelection()).length))
    .toBeGreaterThan(0);
  await expect(popover(page)).toHaveCount(0);
});

test("a drag-select in the editor closes the popover", async ({ page }) => {
  await openPopover(page);
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
  await openPopover(page);
  const point = await centreOf(page.getByTestId("plain-paragraph"));
  await page.mouse.dblclick(point.x, point.y);
  await expect(popover(page)).toHaveCount(0);
});

test("premise: a press inside a bare guest frame reaches no document listener", async ({
  page,
}) => {
  await openPopover(page);
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
  await pressIntoFrame(page, page.getByTestId("guest-frame"));
  // The relay is the only way a press in a frame can be heard: nothing
  // arrived on its own, and the popover is still up.
  await expect(popover(page)).toBeVisible();
  expect(await page.evaluate(() => window.__guestFramePresses)).toBe(0);
});

test("a click inside an artifact page's frame closes the popover", async ({
  page,
}) => {
  await openPopover(page);
  await pressIntoFrame(page, artifactPageFrame(page));
  await expect(popover(page)).toHaveCount(0);
});

test("the application losing focus while the frame holds it is not a press", async ({
  page,
}) => {
  await loadFixture(page);
  await pressIntoFrame(page, artifactPageFrame(page));
  await page.evaluate(() => window.__setUsageOpen?.(true));
  await expect(popover(page)).toBeVisible();

  // Playwright emulates focus so every page believes it is focused; turn
  // that off so another tab in front takes the window's focus for real.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  const other = await page.context().newPage();
  await other.bringToFront();
  // The document did lose focus, with the frame still the active element.
  // (Chrome delivers that blur to the frame's own window, not to this one;
  // the relay's focus check covers an engine that delivers it here.)
  await expect
    .poll(() =>
      page.evaluate(
        () => `${document.hasFocus()}:${document.activeElement?.tagName}`,
      ),
    )
    .toBe("false:IFRAME");
  await page.bringToFront();

  await expect(popover(page)).toBeVisible();
  await other.close();
});

declare global {
  interface Window {
    __guestFramePresses?: number;
    __setUsageOpen?: (open: boolean) => void;
  }
}
