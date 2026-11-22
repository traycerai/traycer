import { expect, test } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// A run of a bot's messages with other bots is one quiet line between the
// channel's rows (Tracy Bots, decision 174), centred as Slack centres
// "joined the channel", its pairs on one line while the column has room.
// Where a box sits is what jsdom cannot decide. The fixture is the real chat
// list over a seeded feed (`bot-exchange-lines.html`).

test.use({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
});

test("each run is one centred line between the rows it falls between", async ({
  page,
}) => {
  await page.goto(fixture("bot-exchange-lines"));
  const channel = page.getByTestId("fixture-channel");
  const lines = channel.getByTestId("bot-exchange-line");
  await expect(lines).toHaveCount(2);
  await nextFrames(page, 2);

  const post = await channel.getByTestId("bot-member-row").boundingBox();
  const reply = await channel.getByTestId("bot-reply-row").boundingBox();
  const first = await lines.nth(0).boundingBox();
  const second = await lines.nth(1).boundingBox();
  if (post === null || reply === null || first === null || second === null) {
    throw new Error("a row of the channel has no layout box");
  }
  // Placed by time: the first run between the post and the reply, the
  // second after the reply.
  expect(first.y).toBeGreaterThanOrEqual(post.y + post.height);
  expect(first.y + first.height).toBeLessThanOrEqual(reply.y);
  expect(second.y).toBeGreaterThanOrEqual(reply.y + reply.height);

  // Centred: the pairs and the time sit in the middle of the line's box,
  // which spans the reading column.
  for (const line of [lines.nth(0), lines.nth(1)]) {
    const extent = await line.evaluate((element) => {
      const boxes = Array.from(element.children).map((child) =>
        child.getBoundingClientRect(),
      );
      const outer = element.getBoundingClientRect();
      return {
        left: Math.min(...boxes.map((box) => box.left)) - outer.left,
        right: outer.right - Math.max(...boxes.map((box) => box.right)),
        rows: new Set(boxes.map((box) => Math.round(box.top))).size,
      };
    });
    expect(Math.abs(extent.left - extent.right)).toBeLessThanOrEqual(1);
    // Two pairs and the time fit on one line in a desktop column.
    expect(extent.rows).toBe(1);
  }
});
