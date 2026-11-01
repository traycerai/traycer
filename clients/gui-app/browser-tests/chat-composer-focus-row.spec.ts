import { expect, test, type Locator, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// The composer's one row on the keyboard focus layout: on the iPhone 17 in
// landscape 194 is left above the keyboard, so the row has to be its 44 for Send
// to clear it. Only a layout engine can read that off the real `ChatComposer`.
// Which composer draws the row is decided in jsdom next to the composer.

const COMPOSER = "[data-chat-composer]";
const EDITOR = "[data-composer-editor]";
const SEND = '[data-testid="toolbar-item-send"] button';
const GRABBER = "[data-composer-grabber]";
const DRAFT_GRABBER = "[data-composer-draft-grabber]";
const EXPANDED = "[data-composer-expanded]";

function pickers(page: Page): Locator {
  return page.locator(
    '[data-testid^="toolbar-item-"]:not([data-testid="toolbar-item-send"])',
  );
}

async function openComposer(page: Page, search: string): Promise<void> {
  await page.goto(`${fixture("chat-send-follow")}${search}`);
  await page.waitForFunction(() => window.__followDriver?.ready === true);
  await page.evaluate(() => {
    window.__followDriver?.open("idle");
  });
  await expect(page.locator(EDITOR)).toBeVisible();
  await nextFrames(page, 2);
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("no box");
  return box;
}

/** A press at (x, y), dragged `travel` down (negative is up), then released. */
async function pullFrom(
  page: Page,
  x: number,
  y: number,
  travel: number,
): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + travel, { steps: 4 });
  await page.mouse.up();
}

test.use({ viewport: { width: 874, height: 402 }, hasTouch: true });

test("draws the card as one 44 row", async ({ page }) => {
  await openComposer(page, "?focus-row");
  const composer = await boxOf(page.locator(COMPOSER));
  expect(composer.height).toBeLessThanOrEqual(44.5);
});

test("puts Send inside the row, beside the editor", async ({ page }) => {
  await openComposer(page, "?focus-row");
  const composer = await boxOf(page.locator(COMPOSER));
  const editor = await boxOf(page.locator(EDITOR));
  const send = await boxOf(page.locator(SEND));

  expect(send.y).toBeGreaterThanOrEqual(composer.y);
  expect(send.y + send.height).toBeLessThanOrEqual(
    composer.y + composer.height + 0.5,
  );
  expect(send.x).toBeGreaterThanOrEqual(editor.x + editor.width);
});

test.describe("a long draft", () => {
  async function typeLongDraft(page: Page): Promise<void> {
    await openComposer(page, "?focus-row");
    await page.locator(EDITOR).click();
    await page.keyboard.insertText(
      Array.from({ length: 40 }, (_, index) => `word${String(index)}`).join(
        " ",
      ),
    );
    await nextFrames(page, 2);
  }

  test("leaves the row its height", async ({ page }) => {
    await typeLongDraft(page);
    const composer = await boxOf(page.locator(COMPOSER));
    expect(composer.height).toBeLessThanOrEqual(44.5);
  });

  test("scrolls inside the editor", async ({ page }) => {
    await typeLongDraft(page);
    const moved = await page.locator(EDITOR).evaluate((editor) => {
      editor.scrollTop = 0;
      editor.scrollTop = editor.scrollHeight;
      return editor.scrollTop;
    });
    expect(moved).toBeGreaterThan(0);
  });
});

test("gives up the pickers on the row", async ({ page }) => {
  await openComposer(page, "?focus-row");
  // Hidden, not removed: they keep what they hold for when the row goes.
  await expect(pickers(page)).not.toHaveCount(0);
  for (const item of await pickers(page).all()) {
    await expect(item).toBeHidden();
  }
});

test("draws the pickers again without the row", async ({ page }) => {
  await openComposer(page, "");
  await expect(pickers(page).first()).toBeVisible();
});

test.describe("the pull zone on the row", () => {
  async function typeDraft(page: Page): Promise<number> {
    await openComposer(page, "?focus-row");
    await page.locator(EDITOR).click();
    await page.keyboard.insertText("a draft");
    await nextFrames(page, 2);
    return page.locator(EDITOR).evaluate((editor) => {
      const range = document.createRange();
      range.selectNodeContents(editor);
      return range.getBoundingClientRect().top;
    });
  }

  test("ends above Send and the draft's first line", async ({ page }) => {
    const firstLineTop = await typeDraft(page);
    const zone = await boxOf(page.locator(GRABBER));
    const send = await boxOf(page.locator(SEND));
    expect(zone.y + zone.height).toBeLessThanOrEqual(send.y + 0.5);
    expect(zone.y + zone.height).toBeLessThanOrEqual(firstLineTop + 0.5);
  });

  test("goes on down to the draft's first line beside Send, never over it", async ({
    page,
  }) => {
    const firstLineTop = await typeDraft(page);
    const zone = await boxOf(page.locator(GRABBER));
    const draftZone = await boxOf(page.locator(DRAFT_GRABBER));
    const send = await boxOf(page.locator(SEND));
    // Below Send's top, so deeper than the edge's zone, and meeting it.
    expect(draftZone.y + draftZone.height).toBeGreaterThan(send.y + 2);
    expect(draftZone.y).toBeLessThanOrEqual(zone.y + zone.height);
    expect(draftZone.y + draftZone.height).toBeLessThanOrEqual(
      firstLineTop + 0.5,
    );
    expect(draftZone.x + draftZone.width).toBeLessThanOrEqual(send.x + 0.5);
  });

  test("leaves every edge of Send to Send", async ({ page }) => {
    await openComposer(page, "?focus-row");
    // A disabled button takes no hits of its own.
    await page.locator(EDITOR).click();
    await page.keyboard.insertText("a draft");
    await nextFrames(page, 2);
    const hits = await page.locator(SEND).evaluate((button) => {
      const { top, bottom, left, right } = button.getBoundingClientRect();
      const inset = 2;
      return [
        [(left + right) / 2, top + inset],
        [(left + right) / 2, bottom - inset],
        [left + inset, (top + bottom) / 2],
        [right - inset, (top + bottom) / 2],
      ].map(([x, y]) => button.contains(document.elementFromPoint(x, y)));
    });
    expect(hits).toEqual([true, true, true, true]);
  });

  test("lets a touch at Send's upper edge send the draft", async ({ page }) => {
    await openComposer(page, "?focus-row");
    await page.locator(EDITOR).click();
    await page.keyboard.insertText("a draft");
    await nextFrames(page, 2);
    const send = await boxOf(page.locator(SEND));
    await page.touchscreen.tap(send.x + send.width / 2, send.y + 3);
    await expect
      .poll(() => page.evaluate(() => window.__followDriver?.lastMessageId()))
      .not.toBeNull();
  });

  test("still opens the sheet on a pull from the edge, over Send's column", async ({
    page,
  }) => {
    await openComposer(page, "?focus-row");
    const zone = await boxOf(page.locator(GRABBER));
    const send = await boxOf(page.locator(SEND));
    await pullFrom(
      page,
      send.x + send.width / 2,
      zone.y + zone.height / 2,
      -40,
    );
    await expect(page.locator(EXPANDED)).toBeVisible();
    await expect(page.locator("[data-composer-focus-row]")).toHaveCount(0);
  });

  test("opens the sheet on a pull from just above the draft's first line, across the edge's zone", async ({
    page,
  }) => {
    // One pull: it starts in the draft's zone and crosses the edge's on the
    // way up.
    const firstLineTop = await typeDraft(page);
    const editor = await boxOf(page.locator(EDITOR));
    await pullFrom(page, editor.x + editor.width / 2, firstLineTop - 1, -40);
    await expect(page.locator(EXPANDED)).toBeVisible();
  });

  test("keeps the sheet open across a blur and the next focus, and closes it on a pull down", async ({
    page,
  }) => {
    await openComposer(page, "?focus-row");
    const zone = await boxOf(page.locator(GRABBER));
    await pullFrom(
      page,
      zone.x + zone.width / 2,
      zone.y + zone.height / 2,
      -40,
    );
    await expect(page.locator(EXPANDED)).toBeVisible();
    // The sheet eases to its top; read its zone once it is there.
    await page.waitForFunction("document.getAnimations().length === 0");

    await page.locator(EDITOR).evaluate((editor) => {
      if (editor instanceof HTMLElement) editor.blur();
    });
    await nextFrames(page, 2);
    await expect(page.locator(EXPANDED)).toBeVisible();
    await page.locator(EDITOR).focus();
    await nextFrames(page, 2);
    await expect(page.locator(EXPANDED)).toBeVisible();

    const open = await boxOf(page.locator(GRABBER));
    await pullFrom(page, open.x + open.width / 2, open.y + open.height / 2, 40);
    await expect(page.locator(EXPANDED)).toHaveCount(0);
  });
});

test.describe("the mention and slash menus over the row", () => {
  // The installed app's keyboard over a window that keeps its height, as the
  // Pro Max in landscape draws it: 440 tall, so `vh` is the window's.
  test.use({ viewport: { width: 956, height: 440 }, hasTouch: true });
  const MENU = '[data-slot="composer-menu"]';
  const ROW = "[data-composer-focus-row]";

  async function openMenu(
    page: Page,
    keyboard: number,
    trigger: string,
  ): Promise<void> {
    await openComposer(page, `?focus-row&keyboard=${String(keyboard)}`);
    await page.locator(EDITOR).click();
    await page.keyboard.type(trigger);
    await expect(page.locator(MENU)).toBeVisible();
    await nextFrames(page, 2);
  }

  for (const trigger of ["@", "/"]) {
    test(`the ${trigger} menu ends above the row while three result rows fit above it, leaving the query in view`, async ({
      page,
    }) => {
      // The Pro Max's 208 keyboard leaves 232.
      await openMenu(page, 208, trigger);
      const menu = await boxOf(page.locator(MENU));
      const row = await boxOf(page.locator(ROW));
      expect(menu.y + menu.height).toBeLessThanOrEqual(row.y + 0.5);
    });
  }

  test("the @ menu runs over the row, down to the keyboard, where fewer than three result rows fit above it", async ({
    page,
  }) => {
    // A 298 keyboard leaves 142: under 100 above the row.
    await openMenu(page, 298, "@");
    const menu = await boxOf(page.locator(MENU));
    const row = await boxOf(page.locator(ROW));
    expect(menu.y + menu.height).toBeGreaterThan(row.y);
    expect(menu.y + menu.height).toBeLessThanOrEqual(440 - 298 + 0.5);
    const list = await boxOf(page.locator(`${MENU} [role="listbox"]`));
    const third = await boxOf(page.locator(`${MENU} [role="option"]`).nth(2));
    expect(third.y + third.height).toBeLessThanOrEqual(
      list.y + list.height + 0.5,
    );
  });
});

test.describe("the transcript's jump pill over the row", () => {
  // The iPhone 17's 194 above the keyboard, with the transcript scrolled back.
  test.use({ viewport: { width: 874, height: 194 }, hasTouch: true });

  async function showPill(page: Page): Promise<Locator> {
    await openComposer(page, "?focus-row");
    await page.mouse.move(300, 70);
    await page.mouse.wheel(0, -200);
    const pill = page.getByRole("button", { name: "Scroll to end" });
    await expect(pill).toBeVisible();
    await nextFrames(page, 2);
    return pill;
  }

  test("is clear of the pull zone", async ({ page }) => {
    const pill = await showPill(page);
    const zone = await boxOf(page.locator(GRABBER));
    const box = await boxOf(pill);
    expect(box.y + box.height).toBeLessThanOrEqual(zone.y + 0.5);
  });

  test("takes a touch at its bottom edge", async ({ page }) => {
    const pill = await showPill(page);
    const box = await boxOf(pill);
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height - 3);
    await expect
      .poll(() => page.evaluate(() => window.__followDriver?.probe().distance))
      .toBeLessThan(2);
  });
});
