import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";

import { fixture, nextFrames } from "./support/fixtures.ts";

// A bot's thread panel lists the tasks its thread set up between the post
// the thread opens on and its replies. However many there are, the list
// scrolls in a bounded band: an unbounded list pushes the box that replies
// past the pane's bottom edge, and a list that keeps its height in a short
// pane squeezes the replies to nothing, or pushes the box out of the pane
// once the person types several lines. The list gives way first, and the
// replies keep the larger share.
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
const COMPOSER_INPUT = '[data-testid="bot-thread-composer-input"]';
const COMPOSER_SEND = '[data-testid="bot-thread-composer-send"]';

const ReadingSchema = z.object({
  paneBottom: z.number(),
  tasksBottom: z.number(),
  tasksHeight: z.number(),
  repliesTop: z.number(),
  repliesHeight: z.number(),
  composerTop: z.number(),
  composerBottom: z.number(),
  sendBottom: z.number(),
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
        readonly send: string;
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
          repliesTop: box(selectors.replies).top,
          repliesHeight: box(selectors.replies).height,
          composerTop: box(selectors.composer).top,
          composerBottom: box(selectors.composer).bottom,
          sendBottom: box(selectors.send).bottom,
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
        send: COMPOSER_SEND,
      },
    ),
  );
}

async function openPanel(page: Page, pane: string): Promise<Reading> {
  await page.goto(`${fixture("bot-thread-tasks-bound")}${pane}`);
  // A pane too short for the list collapses it to nothing: attached, not visible.
  await expect(page.locator(TASKS_SCROLL)).toBeAttached();
  await expect(page.locator(REPLIES)).toHaveAttribute(
    "data-has-replies",
    "true",
  );
  await expect(page.locator(COMPOSER)).toBeVisible();
  await nextFrames(page, 2);
  return readPanel(page);
}

/** The replies keep room, more than the list's, and the box and Send stay in the pane. */
function expectReachable(reading: Reading): void {
  expect(reading.repliesTop).toBeGreaterThanOrEqual(reading.tasksBottom - 1);
  expect(reading.repliesHeight).toBeGreaterThan(0);
  expect(reading.repliesHeight).toBeGreaterThan(reading.tasksHeight);
  expect(reading.composerBottom).toBeLessThanOrEqual(reading.paneBottom + 1);
  expect(reading.sendBottom).toBeLessThanOrEqual(reading.paneBottom + 1);
}

function expectBounded(reading: Reading): void {
  expect(reading.rows).toBe(40);
  // The list is longer than its band, which scrolls it.
  expect(reading.scrollHeight).toBeGreaterThan(reading.clientHeight);
  expectReachable(reading);
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
// window, is taller than the room the pane leaves it, and the box grows with
// what the person types.
test.describe("a pane shorter than the band's cap", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("the band gives way before the replies, and a box of several lines stays in the pane", async ({
    page,
  }) => {
    await openPanel(page, "?pane=420");
    await page
      .locator(COMPOSER_INPUT)
      .fill(
        Array.from({ length: 9 }, (_, line) => `line ${String(line + 1)}`).join(
          "\n",
        ),
      );
    await nextFrames(page, 2);
    expectReachable(await readPanel(page));
  });

  test("the band gives way before the replies, and the box stays in a pane barely taller than the thread's post", async ({
    page,
  }) => {
    expectReachable(await openPanel(page, "?pane=260"));
  });
});
