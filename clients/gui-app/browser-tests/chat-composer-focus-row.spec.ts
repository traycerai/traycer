import { expect, test, type Locator, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// The composer's one row on the keyboard focus layout: on the iPhone 17 in
// landscape 194 is left above the keyboard, so the row has to be its 44 for Send
// to clear it. Only a layout engine can read that off the real `ChatComposer`.
// Which composer draws the row is decided in jsdom next to the composer.

const COMPOSER = "[data-chat-composer]";
const EDITOR = "[data-composer-editor]";
const SEND = '[data-testid="toolbar-item-send"] button';

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

test.use({ viewport: { width: 874, height: 402 } });

test("draws the card as one 44 row, the editor beside Send", async ({
  page,
}) => {
  await openComposer(page, "?focus-row");
  const composer = await boxOf(page.locator(COMPOSER));
  const editor = await boxOf(page.locator(EDITOR));
  const send = await boxOf(page.locator(SEND));

  expect(composer.height).toBeLessThanOrEqual(44.5);
  expect(send.y).toBeGreaterThanOrEqual(composer.y);
  expect(send.y + send.height).toBeLessThanOrEqual(
    composer.y + composer.height + 0.5,
  );
  expect(send.x).toBeGreaterThanOrEqual(editor.x + editor.width);
});

test("a long draft stays in the row and scrolls in the editor", async ({
  page,
}) => {
  await openComposer(page, "?focus-row");
  await page.locator(EDITOR).click();
  await page.keyboard.insertText(
    Array.from({ length: 40 }, (_, index) => `word${String(index)}`).join(" "),
  );
  await nextFrames(page, 2);
  const composer = await boxOf(page.locator(COMPOSER));
  expect(composer.height).toBeLessThanOrEqual(44.5);
});

test("the pickers are not painted on the row, and are without it", async ({
  page,
}) => {
  const toolbarItem = page.locator(
    '[data-testid^="toolbar-item-"]:not([data-testid="toolbar-item-send"])',
  );
  await openComposer(page, "?focus-row");
  for (const item of await toolbarItem.all()) await expect(item).toBeHidden();

  await openComposer(page, "");
  const composer = await boxOf(page.locator(COMPOSER));
  expect(composer.height).toBeGreaterThan(80);
});
