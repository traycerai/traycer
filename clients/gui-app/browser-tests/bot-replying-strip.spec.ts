import { expect, test, type Locator, type Page } from "@playwright/test";

import { centreOf, fixture, nextFrames } from "./support/fixtures.ts";

// "Tracy is replying…" is the way into the running turn (Tracy Bots T148).
// At rest it reads as status; hovered or keyboard-focused it says
// "View turn" and the running time, with a chevron; on a touch screen the whole line takes
// the tap at the 44px minimum while the drawn line, and so the dock, keeps
// its height. Which text shows, what paints, what a point hits and how tall
// the line is are CSS and layout, which jsdom cannot answer.

const STRIP = '[data-testid="strip-turn"]';
const PLAIN_STRIP = '[data-testid="strip-plain"]';
const DOCK = '[data-testid="dock-turn"]';
const BUTTON = `${STRIP} button`;

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

/** Whether the button is what a point on the page hits. */
async function hitsButton(page: Page, x: number, y: number): Promise<boolean> {
  return page.evaluate(
    ({ px, py, selector }) => {
      const hit = document.elementFromPoint(px, py);
      return hit !== null && hit.closest(selector) !== null;
    },
    { px: x, py: y, selector: BUTTON },
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

  expect(await hitsButton(page, at.x, at.y - 16)).toBe(false);
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("the whole line width takes the tap at 44px, and the dock keeps its height", async ({
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

    const centre = await centreOf(page.locator(STRIP));
    const xs = [strip.x + 2, centre.x, strip.x + strip.width - 2];
    for (const x of xs) {
      for (const dy of [-21, 21]) {
        expect(await hitsButton(page, x, centre.y + dy)).toBe(true);
      }
    }
    // The enlarged band reaches neither the composer below nor the transcript above.
    expect(await hitsButton(page, centre.x, centre.y + 40)).toBe(false);
    expect(await hitsButton(page, centre.x, centre.y - 40)).toBe(false);

    await page.touchscreen.tap(centre.x, centre.y - 20);
    await expect(page.locator(DOCK)).toHaveAttribute("data-opened", "1");
  });
});
