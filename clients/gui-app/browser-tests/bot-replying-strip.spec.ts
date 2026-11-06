import { expect, test, type Locator, type Page } from "@playwright/test";

import { centreOf, fixture, nextFrames } from "./support/fixtures.ts";

// "Tracy is replying…" is the way into the running turn (Tracy Bots T148).
// At rest it reads as status; hovered or keyboard-focused it says "View
// turn" and the running time, with a chevron; on a touch screen the whole
// line takes the tap at the 44px minimum while the drawn line, and so the
// dock, keeps its height. The extra height is taken above the line, never
// from the message box under it. Which text shows, what paints, what a
// point hits and how tall the line is are CSS and layout, which jsdom
// cannot answer.

const STRIP = '[data-testid="strip-turn"]';
const PLAIN_STRIP = '[data-testid="strip-plain"]';
const DOCK = '[data-testid="dock-turn"]';
const BUTTON = `${STRIP} button`;
const COMPOSER_INPUT = '[data-testid="composer-turn-input"]';

const REPLYING = "Tracy is replying…";
const VIEW_TURN = /^View turn · \d+m \d+s$/;

function button(page: Page): Locator {
  return page.locator(BUTTON);
}

async function open(page: Page): Promise<void> {
  await page.goto(fixture("bot-replying-strip"));
  await expect(button(page)).toBeVisible();
  await nextFrames(page, 2);
  // Park the pointer away from both docks.
  await page.mouse.move(2, 2);
}

async function background(page: Page): Promise<string> {
  return button(page).evaluate((el) => getComputedStyle(el).backgroundColor);
}

function chevron(page: Page): Locator {
  return button(page).locator("svg.lucide-chevron-right");
}

async function expectRestingText(page: Page): Promise<void> {
  await expect(button(page).getByText(REPLYING)).toBeVisible();
  await expect(button(page).getByText(/View turn/)).toBeHidden();
  await expect(chevron(page)).toBeHidden();
}

async function expectViewTurnText(page: Page): Promise<void> {
  await expect(button(page).getByText(VIEW_TURN)).toBeVisible();
  await expect(button(page).getByText(REPLYING)).toBeHidden();
  await expect(chevron(page)).toBeVisible();
}

/** Whether a point on the page lands in an element matching `selector`. */
async function hits(
  page: Page,
  selector: string,
  x: number,
  y: number,
): Promise<boolean> {
  return page.evaluate(
    ({ px, py, target }) => {
      const hit = document.elementFromPoint(px, py);
      return hit !== null && hit.closest(target) !== null;
    },
    { px: x, py: y, target: selector },
  );
}

test("at rest the line reads as status: the replying text, no View turn, no chevron", async ({
  page,
}) => {
  await open(page);

  await expectRestingText(page);
  await expect(page.locator(STRIP)).toHaveAttribute("role", "status");
});

test("hovering the line swaps in View turn and the running time, with a chevron and a fill", async ({
  page,
}) => {
  await open(page);
  const resting = await background(page);

  const at = await centreOf(button(page));
  await page.mouse.move(at.x, at.y);

  await expectViewTurnText(page);
  expect(await background(page)).not.toBe(resting);
});

test("keyboard focus swaps the text the way hover does", async ({ page }) => {
  await open(page);
  const resting = await background(page);

  await page.keyboard.press("Tab");

  await expect(button(page)).toBeFocused();
  await expectViewTurnText(page);
  expect(await background(page)).not.toBe(resting);
});

test("on a fine pointer the hit area stays the drawn line", async ({
  page,
}) => {
  await open(page);
  const at = await centreOf(page.locator(STRIP));

  expect(await hits(page, BUTTON, at.x, at.y - 16)).toBe(false);
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("the line's touch band grows upward only: the message box keeps every pixel, and the dock its height", async ({
    page,
  }) => {
    await open(page);
    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
    ).toBe(true);

    const strip = await page.locator(STRIP).boundingBox();
    const plain = await page.locator(PLAIN_STRIP).boundingBox();
    if (strip === null || plain === null) throw new Error("no strip box");
    expect(strip.height).toBe(plain.height);

    const bottom = strip.y + strip.height;
    const centreX = strip.x + strip.width / 2;
    const xs = [strip.x + 2, centreX, strip.x + strip.width - 2];
    for (const x of xs) {
      expect(await hits(page, BUTTON, x, bottom - 1)).toBe(true);
      expect(await hits(page, BUTTON, x, bottom - 43)).toBe(true);
      // Past the 44px band, the transcript stand-in.
      expect(await hits(page, BUTTON, x, bottom - 45)).toBe(false);
    }

    // The box keeps its pixels: the padding under the line is not the
    // button, and the field's first row and the point 21px under the
    // line's centre are the box's own.
    expect(await hits(page, BUTTON, centreX, bottom + 1)).toBe(false);
    const centreY = strip.y + strip.height / 2;
    expect(await hits(page, COMPOSER_INPUT, centreX, centreY + 21)).toBe(true);
    const input = await page.locator(COMPOSER_INPUT).boundingBox();
    if (input === null) throw new Error("no composer input box");
    expect(await hits(page, COMPOSER_INPUT, centreX, input.y + 1)).toBe(true);

    // A tap 21px under the line's centre focuses the box and opens nothing;
    // a tap inside the band opens the turn.
    await page.touchscreen.tap(centreX, centreY + 21);
    await expect(page.locator(COMPOSER_INPUT)).toBeFocused();
    await expect(page.locator(DOCK)).not.toHaveAttribute("data-opened", /.*/);
    await page.touchscreen.tap(centreX, centreY - 20);
    await expect(page.locator(DOCK)).toHaveAttribute("data-opened", "1");
  });
});
