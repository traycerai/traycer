import { expect, test, type Page } from "@playwright/test";

import { centreOf, fixture, nextFrames } from "./support/fixtures.ts";

// A bot channel's row floats its actions (Reply in thread) at its top right
// while it is hovered or one of them has keyboard focus (Tracy Bots,
// decision 176). A touch screen has no hover, so at rest the actions neither
// show nor take a tap there; a long press is the way in, which the Vitest
// suite holds. Keyboard focus reveals them on every pointer. Whether they
// paint and take input is computed style and hit testing, which jsdom cannot
// answer.

const ROW = '[data-testid="bot-member-row"]';
const ACTIONS = '[data-testid="bot-message-actions"]';
const REPLY = '[data-testid="bot-message-reply-in-thread"]';
const OPENED = '[data-testid="opened"]';

async function actionsStyle(
  page: Page,
): Promise<{ readonly opacity: string; readonly pointerEvents: string }> {
  return page.locator(ACTIONS).evaluate((element) => {
    const style = getComputedStyle(element);
    return { opacity: style.opacity, pointerEvents: style.pointerEvents };
  });
}

async function open(page: Page): Promise<void> {
  await page.goto(fixture("bot-channel-row-actions"));
  await expect(page.locator(ROW)).toBeVisible();
  await nextFrames(page, 2);
}

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("the row's actions neither show nor take a tap at rest", async ({
    page,
  }) => {
    await open(page);
    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
    ).toBe(true);
    expect(await actionsStyle(page)).toEqual({
      opacity: "0",
      pointerEvents: "none",
    });

    // A tap where Reply in thread sits lands on the row, not on the action.
    const at = await centreOf(page.locator(REPLY));
    await page.touchscreen.tap(at.x, at.y);
    await nextFrames(page, 3);

    expect(await actionsStyle(page)).toEqual({
      opacity: "0",
      pointerEvents: "none",
    });
    await expect(page.locator(OPENED)).toHaveText("0");
  });

  test("keyboard focus reveals the row's actions and opens the thread", async ({
    page,
  }) => {
    await open(page);
    await page.locator(REPLY).focus();

    await expect.poll(async () => (await actionsStyle(page)).opacity).toBe("1");
    expect((await actionsStyle(page)).pointerEvents).toBe("auto");
    await page.keyboard.press("Enter");
    await expect(page.locator(OPENED)).toHaveText("1");
  });
});

test("on a fine pointer, hovering the row reveals its actions", async ({
  page,
}) => {
  await open(page);
  expect(await actionsStyle(page)).toEqual({
    opacity: "0",
    pointerEvents: "none",
  });

  await page.locator(ROW).hover();

  await expect.poll(async () => (await actionsStyle(page)).opacity).toBe("1");
  await page.locator(REPLY).click();
  await expect(page.locator(OPENED)).toHaveText("1");
});
