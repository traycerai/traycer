import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";

import { fixture, nextFrames } from "./support/fixtures.ts";

// A bot's thread panel lists the tasks its thread set up above the box that
// replies in the thread. However many there are, the list scrolls in a
// bounded band, and the box stays inside the pane: an unbounded list pushes
// the box past the pane's bottom edge, where the person cannot reach it.
//
// jsdom lays nothing out, so neither the band's scroll range nor the box's
// position is something it can answer. This renders the production panel,
// over forty labeled automations, against the real stylesheet in a pane the
// window's height, and reads the boxes back.

const PANE = '[data-testid="thread-pane"]';
const TASKS = '[data-testid="bot-thread-tasks"]';
const TASKS_SCROLL = '[data-testid="bot-thread-tasks-scroll"]';
const COMPOSER = '[data-testid="bot-thread-composer"]';

const ReadingSchema = z.object({
  paneTop: z.number(),
  paneBottom: z.number(),
  composerTop: z.number(),
  composerBottom: z.number(),
  tasksBottom: z.number(),
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
        readonly composer: string;
      }) => {
        const box = (selector: string): DOMRect => {
          const element = document.querySelector(selector);
          if (element === null) throw new Error(`no ${selector}`);
          return element.getBoundingClientRect();
        };
        const scroll = document.querySelector(selectors.scroll);
        if (scroll === null) throw new Error(`no ${selectors.scroll}`);
        return {
          paneTop: box(selectors.pane).top,
          paneBottom: box(selectors.pane).bottom,
          composerTop: box(selectors.composer).top,
          composerBottom: box(selectors.composer).bottom,
          tasksBottom: box(selectors.tasks).bottom,
          scrollHeight: scroll.scrollHeight,
          clientHeight: scroll.clientHeight,
          rows: scroll.querySelectorAll('[data-testid="bot-task-row"]').length,
        };
      },
      {
        pane: PANE,
        tasks: TASKS,
        scroll: TASKS_SCROLL,
        composer: COMPOSER,
      },
    ),
  );
}

async function openPanel(page: Page, pane: string): Promise<Reading> {
  await page.goto(`${fixture("bot-thread-tasks-bound")}${pane}`);
  await expect(page.locator(TASKS_SCROLL)).toBeVisible();
  await expect(page.locator(COMPOSER)).toBeVisible();
  await nextFrames(page, 2);
  return readPanel(page);
}

function expectBounded(reading: Reading): void {
  expect(reading.rows).toBe(40);
  // The list is longer than its band, which scrolls it.
  expect(reading.scrollHeight).toBeGreaterThan(reading.clientHeight);
  // The box sits under the list and inside the pane.
  expect(reading.composerTop).toBeGreaterThanOrEqual(reading.tasksBottom - 1);
  expect(reading.composerBottom).toBeLessThanOrEqual(reading.paneBottom + 1);
}

test.describe("a window-high pane", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("the thread's tasks scroll in a bounded band and the reply box stays in the pane", async ({
    page,
  }) => {
    const reading = await openPanel(page, "");
    expectBounded(reading);
    // The band leaves most of the pane to the thread's replies.
    const paneHeight = reading.paneBottom - reading.paneTop;
    expect(reading.paneBottom - reading.composerBottom).toBeGreaterThan(
      paneHeight / 2,
    );
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

  test("the band gives way before the reply box leaves the pane", async ({
    page,
  }) => {
    const reading = await openPanel(page, "?pane=260");
    expectBounded(reading);
  });
});
