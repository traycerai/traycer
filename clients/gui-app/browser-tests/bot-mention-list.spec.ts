import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";

import { fixture } from "./support/fixtures.ts";

// A bot's box completes `@` with the agent composer's two-level menu
// (decision 177): People, Bots and Tasks first, each a step of names, and a
// sent row draws each mention as a chip in its line. At a phone's width the
// menu has to stay inside the viewport, each row on one line however long,
// and a chip has to sit in the line of text it is in rather than break the
// line around it.
//
// jsdom lays nothing out, so neither the menu's box nor a chip's line box is
// something it can answer. This renders the production thread panel, its
// post naming a bot, a task and a member, against the real stylesheet.

const INPUT = '[data-testid="bot-thread-composer-input"]';
const MENU = '[data-slot="composer-menu"]';
const OPTION = `${MENU} [role="option"]`;
const ANCHOR = '[data-testid="bot-thread-anchor"]';
const CHIPS = [
  '[data-testid="bot-mention-bot"]',
  '[data-testid="bot-mention-task"]',
  '[data-testid="bot-mention"]',
] as const;

const VIEWPORT = { width: 390, height: 760 };
test.use({ viewport: VIEWPORT });

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

test("the mention menu opens inside the viewport with a category row for People, Bots and Tasks", async ({
  page,
}) => {
  await page.goto(
    `${fixture("bot-thread-tasks-bound")}?mentions=team&tasks=none&post=short`,
  );
  await page.locator(INPUT).click();
  await page.keyboard.type("@");
  await expect(page.locator(OPTION)).toHaveCount(3);
  const labels = await page
    .locator(OPTION)
    .evaluateAll((options) =>
      options.map(
        (option) => option.querySelector("span.font-medium")?.textContent,
      ),
    );
  expect(labels).toEqual(["People", "Bots", "Tasks"]);

  const menu = await boxOf(page, MENU);
  expect(menu.top).toBeGreaterThanOrEqual(0);
  expect(menu.left).toBeGreaterThanOrEqual(0);
  expect(menu.right).toBeLessThanOrEqual(VIEWPORT.width);
  expect(menu.bottom).toBeLessThanOrEqual(VIEWPORT.height);

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

test("a category step stays inside the viewport at a phone's width, Back first", async ({
  page,
}) => {
  await page.goto(
    `${fixture("bot-thread-tasks-bound")}?mentions=team&tasks=none&post=short`,
  );
  await page.locator(INPUT).click();
  await page.keyboard.type("@");
  await page.locator(OPTION).filter({ hasText: "Tasks" }).click();

  const labels = await page
    .locator(OPTION)
    .evaluateAll((options) =>
      options.map(
        (option) => option.querySelector("span.font-medium")?.textContent,
      ),
    );
  expect(labels[0]).toBe("Back");
  expect(labels.length).toBeGreaterThan(1);
  const menu = await boxOf(page, MENU);
  expect(menu.top).toBeGreaterThanOrEqual(0);
  expect(menu.left).toBeGreaterThanOrEqual(0);
  expect(menu.right).toBeLessThanOrEqual(VIEWPORT.width);
  expect(menu.bottom).toBeLessThanOrEqual(VIEWPORT.height);
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
