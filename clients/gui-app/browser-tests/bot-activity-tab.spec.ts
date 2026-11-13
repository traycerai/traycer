import { expect, test } from "@playwright/test";
import { z } from "zod";

import { fixture, nextFrames } from "./support/fixtures.ts";

// A bot's Activity tab lists its tasks, each row a parent the
// way the Chats panel draws one: a chevron, the rolled-up glyph, the title
// with its badges and the state line under it, all one open button. On a
// phone the title and the line give way (they truncate or wrap) and nothing
// else does: the page never scrolls sideways and every row's open button
// stays inside the pane, with a long title, an `every` badge and "Needs you"
// in the same row.
//
// jsdom lays nothing out; this renders the production page against the real
// stylesheet at a phone's width and reads the boxes back.

const PAGE = '[data-testid="bot-activity-page"]';
const ROW = '[data-testid="bot-activity-task"]';
const OPEN = '[data-testid="bot-activity-task-open"]';

const ReadingSchema = z.object({
  pageScrollWidth: z.number(),
  pageClientWidth: z.number(),
  pageRight: z.number(),
  openRights: z.array(z.number()),
});

test.use({ viewport: { width: 360, height: 780 } });

test("no row pushes the page sideways or its open button out of the pane on a phone", async ({
  page,
}) => {
  await page.goto(fixture("bot-activity-tab"));
  const rows = page.locator(ROW);
  await expect(rows).toHaveCount(5);
  for (const title of [
    "Release notes draft for 1.9",
    "Nightly flake roster",
    "iPad switcher scroller layer fix",
    "Weekly dependency sweep",
    "Slack uninstall copy",
  ]) {
    await expect(rows.filter({ hasText: title })).toHaveCount(1);
  }
  await nextFrames(page, 2);
  const reading = ReadingSchema.parse(
    await page.evaluate(
      (selectors: { readonly page: string; readonly open: string }) => {
        const pane = document.querySelector(selectors.page);
        if (pane === null) throw new Error(`no ${selectors.page}`);
        return {
          pageScrollWidth: pane.scrollWidth,
          pageClientWidth: pane.clientWidth,
          pageRight: pane.getBoundingClientRect().right,
          openRights: [...document.querySelectorAll(selectors.open)].map(
            (el) => el.getBoundingClientRect().right,
          ),
        };
      },
      { page: PAGE, open: OPEN },
    ),
  );
  expect(reading.pageScrollWidth).toBeLessThanOrEqual(reading.pageClientWidth);
  expect(reading.openRights).toHaveLength(5);
  for (const right of reading.openRights) {
    expect(right).toBeLessThanOrEqual(reading.pageRight);
  }
});
