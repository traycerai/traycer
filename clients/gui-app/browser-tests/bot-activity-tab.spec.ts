import { expect, test } from "@playwright/test";
import { z } from "zod";

import { fixture, nextFrames } from "./support/fixtures.ts";

// A bot's Activity tab lists the tasks it started, each row a parent the
// way the Chats panel draws one: a chevron, the rolled-up glyph, the title
// with its badges, the state line under it and the row's ⋮. On a phone the
// title and the line give way (they truncate or wrap) and nothing else does:
// the page never scrolls sideways and every row's ⋮ stays inside the pane,
// with a long title, an `every` badge and "Needs you" in the same row.
//
// jsdom lays nothing out; this renders the production page against the real
// stylesheet at a phone's width and reads the boxes back.

const PAGE = '[data-testid="bot-activity-page"]';
const ROW = '[data-testid="bot-activity-task"]';
const MENU = '[data-testid="bot-activity-task-menu"]';

const ReadingSchema = z.object({
  pageScrollWidth: z.number(),
  pageClientWidth: z.number(),
  pageRight: z.number(),
  menuRights: z.array(z.number()),
});

test.use({ viewport: { width: 360, height: 780 } });

test("no row pushes the page sideways or its ⋮ out of the pane on a phone", async ({
  page,
}) => {
  await page.goto(fixture("bot-activity-tab"));
  await expect(page.locator(ROW)).toHaveCount(4);
  await nextFrames(page, 2);
  const reading = ReadingSchema.parse(
    await page.evaluate(
      (selectors: { readonly page: string; readonly menu: string }) => {
        const pane = document.querySelector(selectors.page);
        if (pane === null) throw new Error(`no ${selectors.page}`);
        return {
          pageScrollWidth: pane.scrollWidth,
          pageClientWidth: pane.clientWidth,
          pageRight: pane.getBoundingClientRect().right,
          menuRights: [...document.querySelectorAll(selectors.menu)].map(
            (menu) => menu.getBoundingClientRect().right,
          ),
        };
      },
      { page: PAGE, menu: MENU },
    ),
  );
  expect(reading.pageScrollWidth).toBeLessThanOrEqual(reading.pageClientWidth);
  expect(reading.menuRights).toHaveLength(4);
  for (const right of reading.menuRights) {
    expect(right).toBeLessThanOrEqual(reading.pageRight);
  }
});
