import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";

import { fixture, nextFrames } from "./support/fixtures.ts";

// A bot's thread panel draws the post a thread opens on in a region of its
// own until a reply is listed, and selecting text there offers Quote into the
// thread's box. jsdom can say that the quote lands; it cannot say what a real
// browser's selection across two paragraphs holds, nor where the button sits
// in a short pane. This renders the production panel against the real
// stylesheet, with the fixture playing the channel's part for a quote
// (`?quote=box`), and drives the selection with real mouse input.

const POST_SCROLL = '[data-testid="bot-thread-post-scroll"]';
const COMPOSER = '[data-testid="bot-thread-composer"]';
const BOX = '[data-testid="bot-thread-composer-input"] [data-composer-editor]';
const POPOVER = '[data-slot="quote-selection-popover"]';
const QUOTE_BUTTON = `${POPOVER} button`;

const BoundsSchema = z.object({
  left: z.number(),
  right: z.number(),
  top: z.number(),
  bottom: z.number(),
});
type Bounds = z.infer<typeof BoundsSchema>;

const ReadingSchema = z.object({
  button: BoundsSchema,
  region: BoundsSchema,
  composerTop: z.number(),
  buttonIsHit: z.boolean(),
});

async function openPanel(page: Page, search: string): Promise<void> {
  await page.goto(`${fixture("bot-thread-tasks-bound")}${search}`);
  await expect(page.locator(POST_SCROLL)).toBeVisible();
  await expect(page.locator(COMPOSER)).toBeVisible();
  await nextFrames(page, 2);
}

/** Where the first `word` in the post's region is drawn. */
async function boundsOfWord(page: Page, word: string): Promise<Bounds> {
  return BoundsSchema.parse(
    await page.evaluate(
      (target: { readonly scope: string; readonly word: string }) => {
        const root = document.querySelector(target.scope);
        if (root === null) throw new Error(`no ${target.scope}`);
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (
          let node = walker.nextNode();
          node !== null;
          node = walker.nextNode()
        ) {
          const at = (node.textContent ?? "").indexOf(target.word);
          if (at < 0) continue;
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + target.word.length);
          const { left, right, top, bottom } = range.getBoundingClientRect();
          return { left, right, top, bottom };
        }
        throw new Error(`no "${target.word}" in ${target.scope}`);
      },
      { scope: POST_SCROLL, word },
    ),
  );
}

/**
 * Drags the mouse from the start of the word at `from` to the end of the
 * word at `to`, a point a character in from each edge so the caret falls on
 * the word's own boundary.
 */
async function dragFromStartToEnd(
  page: Page,
  from: Bounds,
  to: Bounds,
): Promise<void> {
  await page.mouse.move(from.left + 1, (from.top + from.bottom) / 2);
  await page.mouse.down();
  await page.mouse.move(to.right - 1, (to.top + to.bottom) / 2, { steps: 8 });
  await page.mouse.up();
}

async function selectedText(page: Page): Promise<string> {
  return z
    .string()
    .parse(await page.evaluate(() => window.getSelection()?.toString() ?? ""));
}

/** The Quote button, once the popover has put it beside the selection. */
async function quoteButtonPlaced(page: Page): Promise<void> {
  await expect(page.locator(QUOTE_BUTTON)).toBeVisible();
  await expect(page.locator(POPOVER)).toHaveCSS("transform", /^matrix/);
  await nextFrames(page, 2);
}

// The states of the panel in which the post has a region of its own beside the
// box: with a reply listed it is the first row of the replies' list instead.
const STATES = [
  ["posted, with no reply listed", "posted"],
  ["listed with no reply", "zero"],
] as const;

test.describe("a quote across the two paragraphs of the post", () => {
  test.use({ viewport: { width: 1024, height: 720 } });

  const FIRST_PART =
    "release train leaves at noon, and the freeze starts at eleven.";
  const SECOND_PART = "The nightly";

  for (const [name, thread] of STATES) {
    // The block boundary is the blank line between the parts: a quote line of
    // its own, which the box shows as `> release …\n>\n> The nightly`.
    test(`${name}: the box takes both parts as quote lines, the block boundary between them`, async ({
      page,
    }) => {
      await openPanel(
        page,
        `?thread=${thread}&post=paragraphs&tasks=none&quote=box`,
      );

      await dragFromStartToEnd(
        page,
        await boundsOfWord(page, "release"),
        await boundsOfWord(page, "nightly"),
      );
      await expect
        .poll(() => selectedText(page))
        .toBe(`${FIRST_PART}\n\n${SECOND_PART}`);
      await quoteButtonPlaced(page);
      await page.locator(QUOTE_BUTTON).click();

      await expect(page.locator(`${BOX} blockquote > p`)).toHaveText([
        FIRST_PART,
        "",
        SECOND_PART,
      ]);
    });
  }
});

// A landscape phone: the pane is a share of a window barely 400 high, so the
// post's region is a short strip above the box.
test.describe("a quote of the post in a short pane", () => {
  test.use({ viewport: { width: 874, height: 402 } });

  for (const [name, thread] of STATES) {
    test(`${name}: the Quote button sits inside the post's region, above the box, and nothing covers it`, async ({
      page,
    }) => {
      await openPanel(
        page,
        `?thread=${thread}&post=long&tasks=none&pane=300&quote=box`,
      );

      await dragFromStartToEnd(
        page,
        await boundsOfWord(page, "release"),
        await boundsOfWord(page, "noon"),
      );
      await quoteButtonPlaced(page);

      const reading = ReadingSchema.parse(
        await page.evaluate(
          (selectors: {
            readonly button: string;
            readonly region: string;
            readonly composer: string;
          }) => {
            const element = (selector: string): Element => {
              const found = document.querySelector(selector);
              if (found === null) throw new Error(`no ${selector}`);
              return found;
            };
            const boundsOf = (target: Element): Bounds => {
              const { left, right, top, bottom } =
                target.getBoundingClientRect();
              return { left, right, top, bottom };
            };
            const button = element(selectors.button);
            const buttonBounds = boundsOf(button);
            const hit = document.elementFromPoint(
              (buttonBounds.left + buttonBounds.right) / 2,
              (buttonBounds.top + buttonBounds.bottom) / 2,
            );
            return {
              button: buttonBounds,
              region: boundsOf(element(selectors.region)),
              composerTop: boundsOf(element(selectors.composer)).top,
              buttonIsHit: hit !== null && button.contains(hit),
            };
          },
          { button: QUOTE_BUTTON, region: POST_SCROLL, composer: COMPOSER },
        ),
      );

      expect(reading.button.left).toBeGreaterThanOrEqual(reading.region.left);
      expect(reading.button.right).toBeLessThanOrEqual(reading.region.right);
      expect(reading.button.top).toBeGreaterThanOrEqual(reading.region.top);
      expect(reading.button.bottom).toBeLessThanOrEqual(
        reading.region.bottom + 0.5,
      );
      expect(reading.button.bottom).toBeLessThanOrEqual(
        reading.composerTop + 0.5,
      );
      expect(reading.buttonIsHit).toBe(true);
    });
  }
});
