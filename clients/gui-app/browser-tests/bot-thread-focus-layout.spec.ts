import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";

import { fixture, nextFrames } from "./support/fixtures.ts";

// With the keyboard up on a short viewport, a thread with its box focused is
// three bands: the header, the scroll region and the box's one row. The shell's
// safe-height token already ends the pane at the keyboard, so what jsdom cannot
// answer is whether the bands fit there with Send above the keyboard and a post
// readable over it. Each device is the window and keyboard inset measured for
// the landscape usability report.

const PANEL = '[data-testid="bot-thread-panel"]';
const HEADER = `${PANEL} > header`;
const ANCHOR = '[data-testid="bot-thread-anchor"]';
const COMPOSER = '[data-testid="bot-thread-composer"]';
const INPUT = '[data-testid="bot-thread-composer-input"]';
const SEND = '[data-testid="bot-thread-composer-send"]';
const ACTIVITY = '[data-testid="bot-thread-activity"]';
const TASKS = '[data-testid="bot-thread-tasks"]';

const BoxSchema = z.object({ top: z.number(), bottom: z.number() });
const ReadingSchema = z.object({
  header: BoxSchema,
  composer: BoxSchema,
  send: BoxSchema,
});

async function readBands(page: Page): Promise<z.infer<typeof ReadingSchema>> {
  const box = async (selector: string) => {
    const found = await page.locator(selector).boundingBox();
    if (found === null) throw new Error(`no box for ${selector}`);
    return { top: found.y, bottom: found.y + found.height };
  };
  return ReadingSchema.parse({
    header: await box(HEADER),
    composer: await box(COMPOSER),
    send: await box(SEND),
  });
}

async function openFocused(page: Page, search: string): Promise<void> {
  await page.goto(`${fixture("bot-thread-tasks-bound")}${search}`);
  await page.locator(INPUT).focus();
  await expect(page.locator(COMPOSER)).toHaveAttribute(
    "data-box-form",
    "one-row",
  );
  await nextFrames(page, 2);
}

const DEVICES = [
  { name: "iPhone 17", width: 874, height: 402, inset: 208 },
  { name: "iPhone 17 Pro Max", width: 956, height: 440, inset: 208 },
  { name: "iPhone Duo open", width: 951, height: 669, inset: 264 },
] as const;

const THREADS = [
  ["no reply", "zero"],
  ["replies", "listed"],
] as const;

for (const device of DEVICES) {
  for (const [threadName, thread] of THREADS) {
    test.describe(`${device.name}, a thread with ${threadName}`, () => {
      test.use({ viewport: { width: device.width, height: device.height } });
      const search = `?thread=${thread}&post=long&keyboard=${String(device.inset)}`;
      const keyboardTop = device.height - device.inset;

      test("the bands fit above the keyboard", async ({ page }) => {
        await openFocused(page, search);
        const { header, composer, send } = await readBands(page);

        expect(header.bottom - header.top).toBeLessThanOrEqual(45);
        expect(composer.bottom - composer.top).toBeLessThanOrEqual(44.5);
        expect(composer.bottom).toBeLessThanOrEqual(keyboardTop + 0.5);
        expect(send.bottom).toBeLessThanOrEqual(keyboardTop + 0.5);
      });

      test("the post is readable between them", async ({ page }) => {
        await openFocused(page, search);
        const { header, composer } = await readBands(page);

        // The measured floor: 194 less two rows leaves 100 and more for reading.
        expect(composer.top - header.bottom).toBeGreaterThanOrEqual(100);
        const post = await page.locator(ANCHOR).boundingBox();
        expect(post).not.toBeNull();
        expect(post?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(composer.top);
      });

      test("what the row gives up is not painted", async ({ page }) => {
        await openFocused(page, search);
        await expect(page.locator(ACTIVITY)).toBeHidden();
        await expect(page.locator(TASKS)).toBeHidden();
      });

      test("focus stays in the box", async ({ page }) => {
        await openFocused(page, search);
        await expect(page.locator(INPUT)).toBeFocused();
      });
    });
  }
}

test.describe("a long draft", () => {
  test.use({ viewport: { width: 874, height: 402 } });

  test("scrolls inside the field, so Send stays above the keyboard", async ({
    page,
  }) => {
    await openFocused(page, "?thread=zero&post=long&keyboard=208");
    await page
      .locator(INPUT)
      .fill(
        Array.from({ length: 12 }, (_, index) => `Line ${String(index)}`).join(
          "\n",
        ),
      );
    await nextFrames(page, 2);
    const { composer, send } = await readBands(page);
    expect(composer.bottom - composer.top).toBeLessThanOrEqual(44.5);
    expect(send.bottom).toBeLessThanOrEqual(194.5);
  });
});

test.describe("the iPad Pro 11's keyboard", () => {
  test.use({ viewport: { width: 1210, height: 834 } });

  test("leaves 406, which keeps the full box", async ({ page }) => {
    await page.goto(
      `${fixture("bot-thread-tasks-bound")}?thread=zero&post=long&keyboard=428`,
    );
    await page.locator(INPUT).focus();
    await nextFrames(page, 2);
    await expect(page.locator(COMPOSER)).toHaveAttribute(
      "data-box-form",
      "full",
    );
    await expect(page.locator(ACTIVITY)).toBeVisible();
  });
});
