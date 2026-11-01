import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";

import { fixture, nextFrames } from "./support/fixtures.ts";

// A bot's thread panel opens on the post the thread is about, and the person
// who wrote it can write a great deal. However long it is, the box that
// replies and its Send stay inside the pane, and the post scrolls to its end:
// with a reply listed the post is the first thing of the replies' list, and
// with none it has a scroll region of its own, above the box.
//
// jsdom lays nothing out, so neither where the box ends up in a short pane
// nor the post's scroll range is something it can answer. This renders the
// production panel in a landscape phone's viewport, in a pane shorter than
// that, over a post of sixty paragraphs, against the real stylesheet.

const PANE = '[data-testid="thread-pane"]';
const ANCHOR = '[data-testid="bot-thread-anchor"]';
const COMPOSER = '[data-testid="bot-thread-composer"]';
const COMPOSER_SEND = '[data-testid="bot-thread-composer-send"]';
const END_OF_POST = "END-OF-POST";

const ReadingSchema = z.object({
  paneTop: z.number(),
  paneBottom: z.number(),
  composerTop: z.number(),
  composerBottom: z.number(),
  sendBottom: z.number(),
  scrollHeight: z.number(),
  clientHeight: z.number(),
});

/**
 * The panel's boxes, and the numbers of the scroller the post sits in: the
 * nearest ancestor of the post that scrolls vertically.
 */
async function readPanel(page: Page): Promise<z.infer<typeof ReadingSchema>> {
  return ReadingSchema.parse(
    await page.evaluate(
      (selectors: {
        readonly pane: string;
        readonly anchor: string;
        readonly composer: string;
        readonly send: string;
      }) => {
        const element = (selector: string): Element => {
          const found = document.querySelector(selector);
          if (found === null) throw new Error(`no ${selector}`);
          return found;
        };
        const box = (selector: string): DOMRect =>
          element(selector).getBoundingClientRect();
        let scroller: Element | null = element(selectors.anchor).parentElement;
        while (scroller !== null) {
          const overflow = getComputedStyle(scroller).overflowY;
          if (overflow === "auto" || overflow === "scroll") break;
          scroller = scroller.parentElement;
        }
        if (scroller === null) throw new Error("the post has no scroller");
        return {
          paneTop: box(selectors.pane).top,
          paneBottom: box(selectors.pane).bottom,
          composerTop: box(selectors.composer).top,
          composerBottom: box(selectors.composer).bottom,
          sendBottom: box(selectors.send).bottom,
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
        };
      },
      {
        pane: PANE,
        anchor: ANCHOR,
        composer: COMPOSER,
        send: COMPOSER_SEND,
      },
    ),
  );
}

/** Scrolls the scroller the post sits in as far as it goes. */
async function scrollPostToEnd(page: Page): Promise<void> {
  await page.locator(ANCHOR).evaluate((anchor) => {
    let scroller: HTMLElement | null = anchor.parentElement;
    while (scroller !== null) {
      const overflow = getComputedStyle(scroller).overflowY;
      if (overflow === "auto" || overflow === "scroll") break;
      scroller = scroller.parentElement;
    }
    if (scroller === null) throw new Error("the post has no scroller");
    scroller.scrollTop = scroller.scrollHeight;
  });
}

async function openPanel(page: Page, search: string): Promise<void> {
  await page.goto(`${fixture("bot-thread-tasks-bound")}${search}`);
  await expect(page.locator(ANCHOR)).toBeVisible();
  await expect(page.locator(COMPOSER)).toBeVisible();
  await nextFrames(page, 2);
}

// A landscape phone: the pane is a share of a window barely 400 high.
test.use({ viewport: { width: 874, height: 402 } });

const STATES = [
  ["posted, with no reply listed", "?thread=posted"],
  ["listed with no reply", "?thread=zero"],
  ["listed with replies, its session connecting", "?thread=listed"],
] as const;

for (const [name, thread] of STATES) {
  test.describe(`a very long post, ${name}`, () => {
    const search = `${thread}&post=long&tasks=none&pane=300`;

    test("the box and Send stay inside the pane", async ({ page }) => {
      await openPanel(page, search);
      const reading = await readPanel(page);
      expect(reading.composerTop).toBeGreaterThanOrEqual(reading.paneTop);
      expect(reading.composerBottom).toBeLessThanOrEqual(
        reading.paneBottom + 1,
      );
      expect(reading.sendBottom).toBeLessThanOrEqual(reading.paneBottom + 1);
    });

    test("the post scrolls, and scrolling reaches its end", async ({
      page,
    }) => {
      await openPanel(page, search);
      const reading = await readPanel(page);
      expect(reading.scrollHeight).toBeGreaterThan(reading.clientHeight);
      await expect(page.getByText(END_OF_POST)).not.toBeInViewport();

      await scrollPostToEnd(page);

      await expect(page.getByText(END_OF_POST)).toBeInViewport();
      const after = await readPanel(page);
      expect(after.composerBottom).toBeLessThanOrEqual(after.paneBottom + 1);
    });
  });
}
