import {
  expect,
  test,
  type FrameLocator,
  type Locator,
  type Page,
} from "@playwright/test";

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

function selectedLayer(page: Page): Locator {
  return page.getByLabel("Element properties").locator("span").first();
}

/** Opens the inspector and picks `first`; the frame may still be starting, so the click is retried. */
async function selectFirst(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  await expect(async () => {
    await click(page, "first");
    await expect(selectedLayer(page)).toHaveText("Paragraph", {
      timeout: 1000,
    });
  }).toPass();
}

test("a plain click selects the element and shows it in the inspector", async ({
  page,
}) => {
  await open(page);
  await selectFirst(page);
});

test("a Shift-click on a sibling adds it to the selection", async ({
  page,
}) => {
  await open(page);
  await selectFirst(page);

  await shiftClick(page, "second");

  await expect(page.getByText("Arrange · 2 selected")).toBeVisible();
  await expect(page.getByRole("button", { name: "Align left" })).toBeEnabled();
});

test("a Shift-click can add several siblings, one after the other", async ({
  page,
}) => {
  await open(page);
  await selectFirst(page);

  await shiftClick(page, "second");
  await expect(page.getByText("Arrange · 2 selected")).toBeVisible();
  await shiftClick(page, "third");

  await expect(page.getByText("Arrange · 3 selected")).toBeVisible();
});

test("a Shift-click on an element in another container says so and keeps the selection", async ({
  page,
}) => {
  await open(page);
  await selectFirst(page);

  await shiftClick(page, "elsewhere");

  await expect(
    page.getByText("Select elements in the same container."),
  ).toBeVisible();
  await expect(selectedLayer(page)).toHaveText("Paragraph");
  await expect(page.getByText(/^Arrange ·/)).toHaveCount(0);
});

test("the two elements picked by Shift-click are arranged through the toolbar", async ({
  page,
}) => {
  await open(page);
  await selectFirst(page);
  await shiftClick(page, "second");
  await expect(page.getByText("Arrange · 2 selected")).toBeVisible();

  await page.getByRole("button", { name: "Align left" }).click();

  await expect
    .poll(() =>
      page.evaluate(
        () => (window as ProbeWindow).__selectionProbe?.editKinds() ?? [],
      ),
    )
    .toEqual(["align-elements"]);
});
