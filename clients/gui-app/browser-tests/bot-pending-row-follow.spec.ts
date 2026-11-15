import { expect, test, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// The member's own pending row in a bot's channel (Tracy Bots T249) is one
// more row at the end of the list, and the host's stored row later takes its
// place under the same id. Whether the list follows it at the end, leaves a
// reader who scrolled away where they are, and keeps the reader's anchor when
// the stored row arrives with a teammate's row after it is real layout and
// scroll state, which jsdom cannot decide. The fixture is the real chat list
// (`src/__tests__/browser/bot-pending-row-follow.tsx`); it only plays the
// transcript the app builds.

test.use({ viewport: { width: 900, height: 700 }, colorScheme: "light" });

async function probe(page: Page): Promise<BotPendingRowProbe> {
  return page.evaluate(() => {
    if (window.__pendingDriver === undefined) throw new Error("no driver");
    return window.__pendingDriver.probe();
  });
}

async function open(page: Page): Promise<void> {
  await page.goto(fixture("bot-pending-row-follow"));
  await page.waitForFunction(() => window.__pendingDriver?.ready === true);
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="chat-messages-scroll"]') !== null,
  );
}

async function scrollTo(page: Page, where: "end" | number): Promise<void> {
  await page.evaluate((target) => {
    const node = document.querySelector<HTMLElement>(
      '[data-testid="chat-messages-scroll"]',
    );
    if (node === null) throw new Error("no scroll node");
    node.scrollTo({ top: target === "end" ? node.scrollHeight : target });
  }, where);
  await nextFrames(page, 10);
}

test("a pending post at the end is followed: it is the last row and in view", async ({
  page,
}) => {
  await open(page);
  await scrollTo(page, "end");
  await expect
    .poll(async () => (await probe(page)).distance)
    .toBeLessThanOrEqual(1);

  await page.evaluate(() => {
    window.__pendingDriver?.appendPending();
  });
  await nextFrames(page, 10);

  const after = await probe(page);
  expect(after.rowsWithPendingText).toBe(1);
  expect(after.distance).toBeLessThanOrEqual(1);
  expect(after.pendingTop).not.toBeNull();
  expect(after.pendingTop ?? Number.POSITIVE_INFINITY).toBeLessThan(
    after.clientHeight,
  );
});

test("a reader scrolled away is not pulled down by the pending post", async ({
  page,
}) => {
  await open(page);
  await scrollTo(page, 600);
  const before = await probe(page);
  expect(before.distance).toBeGreaterThan(200);

  await page.evaluate(() => {
    window.__pendingDriver?.appendPending();
  });
  await nextFrames(page, 10);

  const after = await probe(page);
  expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(1);
  expect(after.anchorId).toBe(before.anchorId);
  expect(after.rowsWithPendingText).toBeLessThanOrEqual(1);
});

test("the stored row replaces the pending row with a row after it: one row, and the reader's anchor stays", async ({
  page,
}) => {
  await open(page);
  await scrollTo(page, 600);
  await page.evaluate(() => {
    window.__pendingDriver?.appendPending();
  });
  await nextFrames(page, 6);
  const before = await probe(page);

  await page.evaluate(() => {
    window.__pendingDriver?.storeBeforeLateRow();
  });
  await nextFrames(page, 10);

  const after = await probe(page);
  expect(after.anchorId).toBe(before.anchorId);
  expect(
    Math.abs((after.anchorTop ?? 0) - (before.anchorTop ?? 0)),
  ).toBeLessThanOrEqual(1);
  // Scrolled to the end, exactly one row carries the text, not two.
  await scrollTo(page, "end");
  expect((await probe(page)).rowsWithPendingText).toBe(1);
});
