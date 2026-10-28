import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";

import { fixture, nextFrames } from "./support/fixtures.ts";

// A bot's thread panel lists the tasks its thread set up between the post
// the thread opens on and its replies. However many there are, the list
// scrolls in a bounded band: an unbounded list pushes the box that replies
// past the pane's bottom edge, and a list that keeps its height in a short
// pane squeezes the replies to nothing while the box stays put. The list
// gives way to its heading and a row first, and the replies keep the larger
// share.
//
// jsdom lays nothing out, so neither the band's scroll range nor the boxes'
// heights are something it can answer. This renders the production panel on
// a listed thread with replies, over forty labeled automations, against the
// real stylesheet, and reads the boxes back.

const PANE = '[data-testid="thread-pane"]';
const TASKS = '[data-testid="bot-thread-tasks"]';
const TASKS_SCROLL = '[data-testid="bot-thread-tasks-scroll"]';
const REPLIES = '[data-testid="bot-thread-replies"]';
const COMPOSER = '[data-testid="bot-thread-composer"]';

const ReadingSchema = z.object({
  paneBottom: z.number(),
  tasksBottom: z.number(),
  tasksHeight: z.number(),
  tasksFloor: z.number(),
  repliesTop: z.number(),
  repliesHeight: z.number(),
  composerTop: z.number(),
  composerBottom: z.number(),
  scrollHeight: z.number(),
  clientHeight: z.number(),
  rows: z.number(),
});
type Reading = z.infer<typeof ReadingSchema>;

async function readPanel(page: Page): Promise<Reading> {
  return ReadingSchema.parse(
    await page.evaluate(
      (selectors: {
        readonly pane: string;
        readonly tasks: string;
        readonly scroll: string;
        readonly replies: string;
        readonly composer: string;
      }) => {
        const element = (selector: string): Element => {
          const found = document.querySelector(selector);
          if (found === null) throw new Error(`no ${selector}`);
          return found;
        };
        const box = (selector: string): DOMRect =>
          element(selector).getBoundingClientRect();
        const scroll = element(selectors.scroll);
        return {
          paneBottom: box(selectors.pane).bottom,
          tasksBottom: box(selectors.tasks).bottom,
          tasksHeight: box(selectors.tasks).height,
          tasksFloor: Number.parseFloat(
            getComputedStyle(element(selectors.tasks)).minHeight,
          ),
          repliesTop: box(selectors.replies).top,
          repliesHeight: box(selectors.replies).height,
          composerTop: box(selectors.composer).top,
          composerBottom: box(selectors.composer).bottom,
          scrollHeight: scroll.scrollHeight,
          clientHeight: scroll.clientHeight,
          rows: scroll.querySelectorAll('[data-testid="bot-task-row"]').length,
        };
      },
      {
        pane: PANE,
        tasks: TASKS,
        scroll: TASKS_SCROLL,
        replies: REPLIES,
        composer: COMPOSER,
      },
    ),
  );
}

async function openPanel(page: Page, pane: string): Promise<Reading> {
  await page.goto(`${fixture("bot-thread-tasks-bound")}${pane}`);
  await expect(page.locator(TASKS_SCROLL)).toBeVisible();
  await expect(page.locator(REPLIES)).toHaveAttribute(
    "data-has-replies",
    "true",
  );
  await expect(page.locator(COMPOSER)).toBeVisible();
  await nextFrames(page, 2);
  return readPanel(page);
}

function expectBounded(reading: Reading): void {
  expect(reading.rows).toBe(40);
  // The list is longer than its band, which scrolls it.
  expect(reading.scrollHeight).toBeGreaterThan(reading.clientHeight);
  // The replies follow the list, the box follows the replies, inside the pane.
  expect(reading.repliesTop).toBeGreaterThanOrEqual(reading.tasksBottom - 1);
  expect(reading.composerBottom).toBeLessThanOrEqual(reading.paneBottom + 1);
  // The conversation keeps more of the pane than the list does.
  expect(reading.repliesHeight).toBeGreaterThan(reading.tasksHeight);
}

test.describe("a window-high pane", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("the thread's tasks scroll in a bounded band and the replies and box keep their room", async ({
    page,
  }) => {
    expectBounded(await openPanel(page, ""));
  });

  test("the band scrolls to its last task", async ({ page }) => {
    await openPanel(page, "");
    const scroll = page.locator(TASKS_SCROLL);
    await scroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(scroll.locator('[data-task-id="task-40"]')).toBeInViewport();
  });
});

// A split column shorter than the window: the band's cap, a share of the
// window, is taller than the room the pane leaves it.
test.describe("a pane shorter than the band's cap", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("the band gives way to its floor before the replies give up their share", async ({
    page,
  }) => {
    const reading = await openPanel(page, "?pane=420");
    expectBounded(reading);
    expect(reading.tasksHeight).toBeLessThanOrEqual(reading.tasksFloor + 1);
  });
});
