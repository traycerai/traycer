import { expect, test, type Locator, type Page } from "@playwright/test";

import { centreOf, fixture, nextFrames } from "./support/fixtures.ts";

// A hostile MCP App, in the real row and the real sandbox frame, asks for
// fullscreen every 30 ms. Fullscreen is the top layer, so whatever needs the
// reader must stay on top and clickable: the approval card the app caused,
// and a dialog that was open before the app ever asked. The fixture is
// `src/__tests__/browser/mcp-app-fullscreen.tsx`; the admission rules are in
// `overlay-owner.test.ts` (jsdom).

function popoverOpen(page: Page): Promise<boolean> {
  return page.evaluate(() => document.querySelector(":popover-open") !== null);
}

/** How many times the app's surface has entered the top layer so far. */
function openCount(page: Page): Promise<number> {
  return page.evaluate(() => Number(document.body.dataset.opens ?? "0"));
}

async function readCount(page: Page): Promise<number> {
  return page.evaluate(() => Number(document.body.dataset.reads ?? "0"));
}

/** Waits until the app has polled `more` more times: 10 fullscreen asks each. */
async function waitForAppRounds(page: Page, more: number): Promise<void> {
  const target = (await readCount(page)) + more;
  await page.waitForFunction(
    (count) => Number(document.body.dataset.reads ?? "0") >= count,
    target,
  );
}

/** The element a real click at the control's centre would land on is it. */
async function expectHitTarget(control: Locator): Promise<void> {
  const point = await centreOf(control);
  const hit = await control.evaluate((element, at) => {
    const top = document.elementFromPoint(at.x, at.y);
    return top !== null && element.contains(top);
  }, point);
  expect(hit).toBe(true);
}

test("an approval card stays on top while the app keeps asking for fullscreen", async ({
  page,
}) => {
  await page.goto(fixture("mcp-app-fullscreen"));
  // Nothing needs the reader yet: the app's request is honoured.
  await page.waitForFunction(
    () => document.querySelector(":popover-open") !== null,
  );

  await page.evaluate(() => {
    document.body.dataset.command = "call";
  });
  const card = page.getByTestId("mcp-app-approval");
  await expect(card).toBeVisible();
  const opensWithCard = await openCount(page);

  await waitForAppRounds(page, 3);
  await nextFrames(page, 2);
  // Not once in 30 requests, not even for a frame.
  expect(await openCount(page)).toBe(opensWithCard);
  expect(await popoverOpen(page)).toBe(false);
  const approve = card.getByRole("button", { name: "Approve" });
  await expectHitTarget(approve);

  const point = await centreOf(approve);
  await page.mouse.click(point.x, point.y);
  await expect(card).toBeHidden();
  // The block ends with the card: the app may have fullscreen again.
  await page.waitForFunction(
    () => document.querySelector(":popover-open") !== null,
  );
});

test("a dialog open before the app asked is never covered", async ({
  page,
}) => {
  await page.goto(`${fixture("mcp-app-fullscreen")}?scenario=dialog`);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await waitForAppRounds(page, 3);
  await nextFrames(page, 2);
  expect(await openCount(page)).toBe(0);
  expect(await popoverOpen(page)).toBe(false);
  const done = dialog.getByRole("button", { name: "Done" });
  await expectHitTarget(done);

  const point = await centreOf(done);
  await page.mouse.click(point.x, point.y);
  await expect(dialog).toBeHidden();
  await page.waitForFunction(
    () => document.querySelector(":popover-open") !== null,
  );
});
