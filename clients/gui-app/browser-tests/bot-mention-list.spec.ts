import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";

import { fixture } from "./support/fixtures.ts";

// A bot's box completes `@` with one list of the environment's people, bots
// and tasks (decision 177), and a sent row draws each mention as a chip in
// its line. At a phone's width the list has to stay inside the pane above
// the box, each name on one row however long, and a chip has to sit in the
// line of text it is in rather than break the line around it.
//
// jsdom lays nothing out, so neither the list's box nor a chip's line box is
// something it can answer. This renders the production thread panel, its
// post naming a bot, a task and a member, against the real stylesheet.

const PANE = '[data-testid="thread-pane"]';
const INPUT = '[data-testid="bot-thread-composer-input"]';
const LIST = '[data-testid="bot-mention-list"]';
const OPTION = '[data-testid="bot-mention-option"]';
const ANCHOR = '[data-testid="bot-thread-anchor"]';
const CHIPS = [
  '[data-testid="bot-mention-bot"]',
  '[data-testid="bot-mention-task"]',
  '[data-testid="bot-mention"]',
] as const;

test.use({ viewport: { width: 390, height: 760 } });

const BoxSchema = z.object({
  top: z.number(),
  bottom: z.number(),
  left: z.number(),
  right: z.number(),
  height: z.number(),
});
type Box = z.infer<typeof BoxSchema>;

async function boxOf(page: Page, selector: string): Promise<Box> {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`no box for ${selector}`);
  return BoxSchema.parse({
    top: box.y,
    bottom: box.y + box.height,
    left: box.x,
    right: box.x + box.width,
    height: box.height,
  });
}

test("the mention list opens above the box inside the pane, one row per name", async ({
  page,
}) => {
  await page.goto(
    `${fixture("bot-thread-tasks-bound")}?mentions=team&tasks=none&post=short`,
  );
  const input = page.locator(INPUT);
  await input.click();
  await page.keyboard.type("@");
  await expect(page.locator(OPTION)).toHaveCount(6);
  const kinds = await page
    .locator(OPTION)
    .evaluateAll((options) =>
      options.map((option) => option.getAttribute("data-kind")),
    );
  expect(kinds).toEqual(["person", "person", "bot", "bot", "task", "task"]);

  const pane = await boxOf(page, PANE);
  const list = await boxOf(page, LIST);
  const box = await boxOf(page, INPUT);
  expect(list.bottom).toBeLessThanOrEqual(box.top + 1);
  expect(list.top).toBeGreaterThanOrEqual(pane.top);
  expect(list.left).toBeGreaterThanOrEqual(pane.left);
  expect(list.right).toBeLessThanOrEqual(pane.right);

  const rows = await page.locator(OPTION).evaluateAll((options) =>
    options.map((option) => ({
      height: option.getBoundingClientRect().height,
      overflows: option.scrollWidth > option.clientWidth,
    })),
  );
  const first = rows[0]?.height ?? 0;
  for (const row of rows) {
    expect(row.overflows).toBe(false);
    expect(row.height).toBeCloseTo(first, 0);
  }
});

test("a sent row's bot, task and member chips sit in its line of text", async ({
  page,
}) => {
  await page.goto(
    `${fixture("bot-thread-tasks-bound")}?mentions=team&tasks=none&post=mentions`,
  );
  const anchor = await boxOf(page, ANCHOR);
  for (const selector of CHIPS) {
    await expect(page.locator(selector)).toBeVisible();
    const chip = page.locator(selector).first();
    const lines = await chip.evaluate((element) => {
      const line = Number.parseFloat(getComputedStyle(element).lineHeight);
      return { line, rects: element.getClientRects().length };
    });
    const box = await boxOf(page, selector);
    // One line box, no taller than the text's line, inside the row.
    expect(lines.rects).toBe(1);
    expect(box.height).toBeLessThanOrEqual(lines.line + 1);
    expect(box.left).toBeGreaterThanOrEqual(anchor.left);
    expect(box.right).toBeLessThanOrEqual(anchor.right);
  }
});
