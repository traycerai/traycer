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
const INPUT =
  '[data-testid="bot-thread-composer-input"] [data-composer-editor]';
const SEND = '[data-testid="bot-thread-composer-send"]';
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

      test("the panel takes the focus layout, and its Tasks are not painted", async ({
        page,
      }) => {
        await openFocused(page, search);
        await expect(page.locator(PANEL)).toHaveAttribute(
          "data-focus-layout",
          "",
        );
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

// The iPad mini in landscape, as the second tile: 744 tall, a 32 status bar and
// a 428 keyboard leave the pane ending at 316.
test.describe("iPad mini, a short post", () => {
  test.use({ viewport: { width: 1133, height: 744 } });
  const keyboardTop = 744 - 428;

  for (const [threadName, thread] of [
    ["no reply", "zero"],
    ["no listing yet", "posted"],
  ] as const) {
    test(`with ${threadName}: the box rests on the keyboard, the post's region filling above it`, async ({
      page,
    }) => {
      await openFocused(
        page,
        `?thread=${thread}&post=short&keyboard=428&top=32`,
      );
      const { composer } = await readBands(page);
      expect(composer.bottom).toBeGreaterThanOrEqual(keyboardTop - 0.5);
      expect(composer.bottom).toBeLessThanOrEqual(keyboardTop + 0.5);
      const post = await page.locator(ANCHOR).boundingBox();
      if (post === null) throw new Error("no post");
      // Short: well clear of the box, so only a filling region puts it there.
      expect(post.y + post.height).toBeLessThan(composer.top - 40);
    });
  }
});

test.describe("the iPad Pro 11's keyboard", () => {
  test.use({ viewport: { width: 1210, height: 834 } });

  test("leaves 374 under its 32 status bar, which takes the one row", async ({
    page,
  }) => {
    await openFocused(page, "?thread=zero&post=long&keyboard=428&top=32");
    await expect(page.locator(PANEL)).toHaveAttribute("data-focus-layout", "");
  });

  test("would leave 406 with no status bar, which keeps the full box", async ({
    page,
  }) => {
    await page.goto(
      `${fixture("bot-thread-tasks-bound")}?thread=zero&post=long&keyboard=428`,
    );
    await page.locator(INPUT).focus();
    await nextFrames(page, 2);
    await expect(page.locator(COMPOSER)).toHaveAttribute(
      "data-box-form",
      "full",
    );
    await expect(page.locator(PANEL)).not.toHaveAttribute("data-focus-layout");
  });
});

// A thread opened at Send whose first attempt came back uncertain, on a phone:
// the pane shows the thread alone, so the post the thread opens on is where the
// person reads that the send may not have arrived, and where they send it again.
test.describe("a thread opened at Send, its send unconfirmed", () => {
  test.use({ viewport: { width: 390, height: 700 } });

  test("the post it opens on shows the unconfirmed mark and Retry", async ({
    page,
  }) => {
    await page.goto(
      `${fixture("bot-thread-tasks-bound")}?thread=posted&pending=uncertain`,
    );
    const origin = page.locator(ANCHOR);
    await expect(origin.getByText(/Not confirmed/)).toBeVisible();
    await expect(origin.getByRole("button", { name: "Retry" })).toBeVisible();
  });
});

// A held reply under a thread the list does not have yet is drawn in its own
// column. A long one must scroll there, not push the box out of the pane.
test.describe("a long held reply, in the panel layout", () => {
  test.use({ viewport: { width: 390, height: 700 } });
  const HELD = '[data-testid="bot-thread-held-replies"]';

  test("the held column scrolls and the box stays inside the panel", async ({
    page,
  }) => {
    await page.goto(
      `${fixture("bot-thread-tasks-bound")}?thread=posted&pending=long-reply`,
    );
    const held = page.locator(HELD);
    await expect(held).toBeVisible();
    await nextFrames(page, 2);

    const column = await held.evaluate((node) => ({
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      overflowY: getComputedStyle(node).overflowY,
    }));
    expect
      .soft(
        column.scrollHeight - column.clientHeight,
        `the held column scrolls: scrollHeight ${String(column.scrollHeight)} over clientHeight ${String(column.clientHeight)}`,
      )
      .toBeGreaterThan(1);
    expect
      .soft(column.overflowY, "the held column's overflow-y is auto")
      .toBe("auto");

    const panel = await page.locator(PANEL).boundingBox();
    const composer = await page.locator(COMPOSER).boundingBox();
    if (panel === null || composer === null) throw new Error("no box");
    expect
      .soft(
        {
          top: composer.y >= panel.y - 0.5,
          bottom: composer.y + composer.height <= panel.y + panel.height + 0.5,
        },
        `the reply box lies inside the panel (box ${String(composer.y)}..${String(composer.y + composer.height)}, panel ${String(panel.y)}..${String(panel.y + panel.height)})`,
      )
      .toEqual({ top: true, bottom: true });
    await expect
      .soft(page.locator(COMPOSER), "the reply box is fully in the viewport")
      .toBeInViewport({ ratio: 1 });
  });
});
