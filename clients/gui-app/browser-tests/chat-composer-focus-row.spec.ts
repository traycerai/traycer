import { expect, test, type Locator, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// The composer's one row on the keyboard focus layout: on the iPhone 17 in
// landscape 194 is left above the keyboard, so the row has to be its 44 for Send
// to clear it. Only a layout engine can read that off the real `ChatComposer`.
// Which composer draws the row is decided in jsdom next to the composer.

const COMPOSER = "[data-chat-composer]";
const EDITOR = "[data-composer-editor]";
const SEND = '[data-testid="toolbar-item-send"] button';
const GRABBER = "[data-composer-grabber]";

function pickers(page: Page): Locator {
  return page.locator(
    '[data-testid^="toolbar-item-"]:not([data-testid="toolbar-item-send"])',
  );
}

async function openComposer(page: Page, search: string): Promise<void> {
  await page.goto(`${fixture("chat-send-follow")}${search}`);
  await page.waitForFunction(() => window.__followDriver?.ready === true);
  await page.evaluate(() => {
    window.__followDriver?.open("idle");
  });
  await expect(page.locator(EDITOR)).toBeVisible();
  await nextFrames(page, 2);
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("no box");
  return box;
}

test.use({ viewport: { width: 874, height: 402 }, hasTouch: true });

test("draws the card as one 44 row", async ({ page }) => {
  await openComposer(page, "?focus-row");
  const composer = await boxOf(page.locator(COMPOSER));
  expect(composer.height).toBeLessThanOrEqual(44.5);
});

test("puts Send inside the row, beside the editor", async ({ page }) => {
  await openComposer(page, "?focus-row");
  const composer = await boxOf(page.locator(COMPOSER));
  const editor = await boxOf(page.locator(EDITOR));
  const send = await boxOf(page.locator(SEND));

  expect(send.y).toBeGreaterThanOrEqual(composer.y);
  expect(send.y + send.height).toBeLessThanOrEqual(
    composer.y + composer.height + 0.5,
  );
  expect(send.x).toBeGreaterThanOrEqual(editor.x + editor.width);
});

test.describe("a long draft", () => {
  async function typeLongDraft(page: Page): Promise<void> {
    await openComposer(page, "?focus-row");
    await page.locator(EDITOR).click();
    await page.keyboard.insertText(
      Array.from({ length: 40 }, (_, index) => `word${String(index)}`).join(
        " ",
      ),
    );
    await nextFrames(page, 2);
  }

  test("leaves the row its height", async ({ page }) => {
    await typeLongDraft(page);
    const composer = await boxOf(page.locator(COMPOSER));
    expect(composer.height).toBeLessThanOrEqual(44.5);
  });

  test("scrolls inside the editor", async ({ page }) => {
    await typeLongDraft(page);
    const moved = await page.locator(EDITOR).evaluate((editor) => {
      editor.scrollTop = 0;
      editor.scrollTop = editor.scrollHeight;
      return editor.scrollTop;
    });
    expect(moved).toBeGreaterThan(0);
  });
});

test("gives up the pickers on the row", async ({ page }) => {
  await openComposer(page, "?focus-row");
  // Hidden, not removed: they keep what they hold for when the row goes.
  await expect(pickers(page)).not.toHaveCount(0);
  for (const item of await pickers(page).all()) {
    await expect(item).toBeHidden();
  }
});

test("draws the pickers again without the row", async ({ page }) => {
  await openComposer(page, "");
  await expect(pickers(page).first()).toBeVisible();
});

test.describe("the pull zone on the row", () => {
  test("sits above the card, clear of the editor and Send", async ({
    page,
  }) => {
    await openComposer(page, "?focus-row");
    const zone = await boxOf(page.locator(GRABBER));
    const editor = await boxOf(page.locator(EDITOR));
    const send = await boxOf(page.locator(SEND));
    expect(zone.y + zone.height).toBeLessThanOrEqual(editor.y);
    expect(zone.y + zone.height).toBeLessThanOrEqual(send.y);
  });

  test("leaves every edge of Send to Send", async ({ page }) => {
    await openComposer(page, "?focus-row");
    // A disabled button takes no hits of its own.
    await page.locator(EDITOR).click();
    await page.keyboard.insertText("a draft");
    await nextFrames(page, 2);
    const hits = await page.locator(SEND).evaluate((button) => {
      const { top, bottom, left, right } = button.getBoundingClientRect();
      const inset = 2;
      return [
        [(left + right) / 2, top + inset],
        [(left + right) / 2, bottom - inset],
        [left + inset, (top + bottom) / 2],
        [right - inset, (top + bottom) / 2],
      ].map(([x, y]) => button.contains(document.elementFromPoint(x, y)));
    });
    expect(hits).toEqual([true, true, true, true]);
  });

  test("lets a touch at Send's upper edge send the draft", async ({ page }) => {
    await openComposer(page, "?focus-row");
    await page.locator(EDITOR).click();
    await page.keyboard.insertText("a draft");
    await nextFrames(page, 2);
    const send = await boxOf(page.locator(SEND));
    await page.touchscreen.tap(send.x + send.width / 2, send.y + 3);
    await expect
      .poll(() => page.evaluate(() => window.__followDriver?.lastMessageId()))
      .not.toBeNull();
  });

  test("still opens the sheet on a pull", async ({ page }) => {
    await openComposer(page, "?focus-row");
    const zone = await boxOf(page.locator(GRABBER));
    const x = zone.x + zone.width / 2;
    const y = zone.y + zone.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 40, { steps: 4 });
    await page.mouse.up();
    await expect(page.locator("[data-composer-expanded]")).toBeVisible();
    await expect(page.locator("[data-composer-focus-row]")).toHaveCount(0);
  });
});
