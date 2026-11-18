import { expect, test, type FrameLocator, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// Browser regression: Shift-click adds a sibling to the selection in the real
// canvas.
//
// A fixture that sets the selection store directly skips the code a Shift-click
// depends on, so this one mounts the production canvas and clicks with trusted
// input: the XYFlow wrapper (its Shift selection key), the board's edit overlay,
// and the hit test in a real sandbox frame. Store rules and the toolbar's
// behaviour for a set stay in Vitest (`components/canvas-artifact/__tests__/`).

test.use({ viewport: { width: 1400, height: 900 }, actionTimeout: 10_000 });

const BOARD_TITLE = "Home";

interface SelectionProbe {
  readonly ready: boolean;
  readonly editKinds: () => readonly string[];
  readonly selectedTid: () => string | null;
  readonly additionalCount: () => number;
  readonly selectionNote: () => string | null;
  readonly serve: (url: string) => Promise<{
    readonly status: number;
    readonly mediaType: string;
    readonly base64: string;
  }>;
}

interface ProbeWindow extends Window {
  __selectionProbe?: SelectionProbe;
}

function board(page: Page): FrameLocator {
  return page.frameLocator(`iframe[title="${BOARD_TITLE}"]`);
}

/** Boards come from an address no network answers; the page serves them. */
async function serveBoardsFromPage(page: Page): Promise<void> {
  await page.route(
    /^https:\/\/artifact-[^/]+\.traycer-artifact\.invalid\//,
    async (route) => {
      const served = await page.evaluate(
        (url) => (window as ProbeWindow).__selectionProbe?.serve(url),
        route.request().url(),
      );
      if (served === undefined) {
        await route.abort();
        return;
      }
      await route.fulfill({
        status: served.status,
        contentType: served.mediaType,
        body: Buffer.from(served.base64, "base64"),
      });
    },
  );
}

async function open(page: Page): Promise<void> {
  await serveBoardsFromPage(page);
  await page.goto(fixture("canvas-selection"));
  await page.waitForFunction(
    () => (window as ProbeWindow).__selectionProbe?.ready === true,
  );
  // The positive event: the board's page is drawn.
  await expect(board(page).locator('[data-tid="first"]')).toBeVisible();
}

/**
 * The centre of a board element on the screen. The canvas draws the board
 * scaled, and a child frame's box is reported unscaled, so the element's own
 * box in the board is mapped through the frame's outer box and CSS size.
 */
async function centreOfElement(
  page: Page,
  tid: string,
): Promise<{ readonly x: number; readonly y: number }> {
  const frame = page.locator(`iframe[title="${BOARD_TITLE}"]`);
  const outer = await frame.boundingBox();
  if (outer === null) throw new Error("the board has no layout box");
  const cssSize = await frame.evaluate((element) => ({
    width: element.clientWidth,
    height: element.clientHeight,
  }));
  const inner = await board(page)
    .locator(`[data-tid="${tid}"]`)
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
  return {
    x: outer.x + ((inner.x + inner.width / 2) * outer.width) / cssSize.width,
    y: outer.y + ((inner.y + inner.height / 2) * outer.height) / cssSize.height,
  };
}

async function click(page: Page, tid: string): Promise<void> {
  const point = await centreOfElement(page, tid);
  await page.mouse.click(point.x, point.y);
}

/**
 * A trusted Shift-click. XYFlow arms its selection key on the keydown, and a
 * click that lands before it has re-rendered passes for the wrong reason, so
 * the click waits for the pane to report the selection mode.
 */
async function shiftClick(page: Page, tid: string): Promise<void> {
  const point = await centreOfElement(page, tid);
  await page.keyboard.down("Shift");
  try {
    await expect(page.locator(".react-flow__pane.selection")).toBeAttached();
    await nextFrames(page, 2);
    await page.mouse.click(point.x, point.y);
  } finally {
    await page.keyboard.up("Shift");
  }
}

/** The inspector sits behind its flag, so the selection is read from the
 * store through the fixture's probe instead of a panel describing it. */
function selectedTid(page: Page): Promise<string | null> {
  return page.evaluate(
    () => (window as ProbeWindow).__selectionProbe?.selectedTid() ?? null,
  );
}

/** Picks `first`; the frame may still be starting, so the click is retried. */
async function selectFirst(page: Page): Promise<void> {
  await expect(async () => {
    await click(page, "first");
    await expect.poll(() => selectedTid(page), { timeout: 1000 }).toBe("first");
  }).toPass();
}

test("a plain click selects the element", async ({ page }) => {
  await open(page);
  await selectFirst(page);
});

function additionalCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as ProbeWindow).__selectionProbe?.additionalCount() ?? -1,
  );
}

test("a Shift-click can add several siblings, one after the other", async ({
  page,
}) => {
  await open(page);
  await selectFirst(page);

  await shiftClick(page, "second");
  await expect.poll(() => additionalCount(page)).toBe(1);
  await shiftClick(page, "third");

  await expect.poll(() => additionalCount(page)).toBe(2);
});

test("a Shift-click on an element in another container says so and keeps the selection", async ({
  page,
}) => {
  await open(page);
  await selectFirst(page);

  await shiftClick(page, "elsewhere");

  await expect
    .poll(() =>
      page.evaluate(
        () => (window as ProbeWindow).__selectionProbe?.selectionNote() ?? null,
      ),
    )
    .toBe("Select elements in the same container.");
  await expect.poll(() => selectedTid(page)).toBe("first");
  await expect.poll(() => additionalCount(page)).toBe(0);
});
