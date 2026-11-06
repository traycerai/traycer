import { expect, test, type Locator, type Page } from "@playwright/test";

import { centreOf, fixture, nextFrames } from "./support/fixtures.ts";

// "Tracy is replying…" is the way into the running turn (Tracy Bots T148).
// At rest it reads as status; hovered or keyboard-focused it says "View
// turn" and the running time, with a chevron. On a touch screen the line
// itself is drawn 44px tall and is the button edge to edge; the dock grows
// by that much while the bot replies, and nothing overlaps the row above or
// the box below. A fine pointer keeps the shorter line. Which text shows,
// what paints, what a point hits and how tall the line is are CSS and
// layout, which jsdom cannot answer.

const STRIP = '[data-testid="strip-turn"]';
const PLAIN_STRIP = '[data-testid="strip-plain"]';
const NONE_STRIP = '[data-testid="strip-none"]';
const LINK = '[data-testid="link-turn"]';
const COMPOSER = '[data-testid="composer-turn"]';
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
  await expect.poll(() => background(page)).not.toBe(resting);
});

test("keyboard focus swaps the text the way hover does", async ({ page }) => {
  await open(page);
  const resting = await background(page);

  // The link above the line is the first stop; the line is the next.
  await page.locator(LINK).focus();
  await page.keyboard.press("Tab");

  await expect(button(page)).toBeFocused();
  await expectViewTurnText(page);
  await expect.poll(() => background(page)).not.toBe(resting);
});

async function heightOf(page: Page, selector: string): Promise<number> {
  const box = await page.locator(selector).boundingBox();
  if (box === null) throw new Error(`no layout box for ${selector}`);
  return box.height;
}

test("on a fine pointer every strip is the same short line, and the hit area stays the drawn line", async ({
  page,
}) => {
  await open(page);
  const turn = await heightOf(page, STRIP);
  expect(await heightOf(page, PLAIN_STRIP)).toBe(turn);
  expect(await heightOf(page, NONE_STRIP)).toBe(turn);

  const at = await centreOf(page.locator(STRIP));
  expect(await hits(page, BUTTON, at.x, at.y - 16)).toBe(false);
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("the line is drawn 44px tall and is the button edge to edge, overlapping neither the row above nor the box below", async ({
    page,
    browser,
    baseURL,
  }) => {
    await open(page);
    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
    ).toBe(true);

    const strip = await page.locator(STRIP).boundingBox();
    if (strip === null) throw new Error("no strip box");
    expect(strip.height).toBe(44);
    // A reply to a request is as tall before the host names its turn.
    expect(await heightOf(page, PLAIN_STRIP)).toBe(44);
    // A turn answering no request is drawn as on a fine pointer.
    const fine = await browser.newContext({
      baseURL,
      hasTouch: false,
      isMobile: false,
    });
    const finePage = await fine.newPage();
    await open(finePage);
    expect(
      await finePage.evaluate(() => matchMedia("(pointer: coarse)").matches),
    ).toBe(false);
    const fineHeight = await heightOf(finePage, NONE_STRIP);
    await fine.close();
    expect(await heightOf(page, NONE_STRIP)).toBe(fineHeight);

    const centreX = strip.x + strip.width / 2;
    const xs = [strip.x + 1, centreX, strip.x + strip.width - 1];
    for (const x of xs) {
      expect(await hits(page, BUTTON, x, strip.y)).toBe(true);
      expect(await hits(page, BUTTON, x, strip.y + strip.height - 1)).toBe(
        true,
      );
    }

    // Above the line is the row above, down to the link's last row; below
    // it is the message box.
    const link = await page.locator(LINK).boundingBox();
    if (link === null) throw new Error("no link box");
    expect(await hits(page, BUTTON, centreX, strip.y - 1)).toBe(false);
    expect(
      await hits(page, "a", link.x + link.width / 2, link.y + link.height - 1),
    ).toBe(true);
    expect(
      await hits(
        page,
        BUTTON,
        link.x + link.width / 2,
        link.y + link.height - 1,
      ),
    ).toBe(false);
    expect(
      await hits(page, COMPOSER, centreX, strip.y + strip.height + 1),
    ).toBe(true);
    expect(await hits(page, BUTTON, centreX, strip.y + strip.height + 1)).toBe(
      false,
    );

    // A tap in the field's top padding focuses the field and opens nothing;
    // a tap on the line's top edge opens the turn. (A tap on the field's
    // first row, 6px under the line, Chrome's touch adjustment hands to the
    // line, though the point itself is the field's.)
    const input = await page.locator(COMPOSER_INPUT).boundingBox();
    if (input === null) throw new Error("no composer input box");
    await page.touchscreen.tap(centreX, input.y + 8);
    await expect(page.locator(COMPOSER_INPUT)).toBeFocused();
    await expect(page.locator(DOCK)).not.toHaveAttribute("data-opened", /.*/);
    await page.touchscreen.tap(centreX, strip.y);
    await expect(page.locator(DOCK)).toHaveAttribute("data-opened", "1");
  });
});
