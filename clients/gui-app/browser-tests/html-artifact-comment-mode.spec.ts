import { expect, test, type Locator, type Page } from "@playwright/test";

import { centreOf, fixture, nextFrames } from "./support/fixtures.ts";

// Turning Comments on used to swap the served document, which reloaded the
// page, and a shield over the frame then ate scroll. The page now stays
// loaded: the tool is a message. Layout and input are what decide that, so
// this drives the real comment surface through a real composed document.
//
// The page lives in a sandboxed frame with an opaque origin. Playwright's
// frame locators read it over the browser's debugging channel.

test.use({ viewport: { width: 900, height: 700 }, actionTimeout: 10_000 });

const FRAME_TITLE = "Comment page";
/** Ctrl-wheel pixels that take the zoom script from 100% to 150%. */
const ZOOM_TO_150_DELTA = -Math.round(Math.log(1.5) / 0.005);

interface CommentModeProbe {
  readonly serve: (url: string) => Promise<{
    readonly status: number;
    readonly mediaType: string;
    readonly base64: string;
  }>;
}
interface ProbeWindow extends Window {
  __commentModeProbe?: CommentModeProbe;
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface PageMemory {
  readonly loadId: string;
  readonly scrollY: number;
  readonly counter: string;
  readonly touch: string;
  readonly folded: boolean;
  readonly note: string;
  readonly zoom: string;
  readonly escaped: string;
}

function frameElement(page: Page): Locator {
  return page.locator(`iframe[title="${FRAME_TITLE}"]`);
}

function pageFrame(page: Page) {
  return page.frameLocator(`iframe[title="${FRAME_TITLE}"]`);
}

function commentsButton(page: Page): Locator {
  return page.getByRole("button", { name: "Comments" });
}

function zoomReadout(page: Page): Locator {
  return page.getByRole("status", { name: "Zoom level" });
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("no layout box");
  return box;
}

async function serveArtifactFromPage(page: Page): Promise<void> {
  await page.route(
    /^https:\/\/artifact-[^/]+\.traycer-artifact\.invalid\//,
    async (route) => {
      const served = await page.evaluate(
        (url) => (window as ProbeWindow).__commentModeProbe?.serve(url),
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
  await serveArtifactFromPage(page);
  await page.goto(fixture("html-artifact-comment-mode"));
  await expect(pageFrame(page).locator("#counter")).toHaveText("count 0");
  await expect(commentsButton(page)).toHaveAttribute("aria-pressed", "false");
  await expect(zoomReadout(page)).toHaveText("100%");
}

async function setComments(page: Page, on: boolean): Promise<void> {
  const button = commentsButton(page);
  if ((await button.getAttribute("aria-pressed")) === "true") {
    if (!on) await button.click();
  } else if (on) {
    await button.click();
  }
  await expect(button).toHaveAttribute("aria-pressed", on ? "true" : "false");
}

async function memory(page: Page): Promise<PageMemory> {
  return pageFrame(page)
    .locator("html")
    .evaluate((html) => {
      const document = html.ownerDocument;
      const note = document.querySelector("#note");
      const fold = document.querySelector("#fold");
      return {
        loadId: html.dataset.loadId ?? "",
        scrollY: document.defaultView?.scrollY ?? -1,
        counter: document.querySelector("#counter")?.textContent ?? "",
        touch: document.querySelector("#touch")?.textContent ?? "",
        folded: fold instanceof HTMLDetailsElement && fold.open,
        note: note instanceof HTMLInputElement ? note.value : "",
        zoom: document.body.style.zoom,
        escaped: html.dataset.escaped ?? "",
      };
    });
}

/** The element's border box in the test page's coordinates. */
async function elementBoxInPage(page: Page, selector: string): Promise<Box> {
  const frameBox = await boxOf(frameElement(page));
  const inner = await pageFrame(page)
    .locator(selector)
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    });
  return {
    x: frameBox.x + inner.x,
    y: frameBox.y + inner.y,
    width: inner.width,
    height: inner.height,
  };
}

/** The hover rectangle. It is the outline without the selection's ring. */
function hoverOutline(page: Page): Locator {
  return page.locator("[data-canvas-selection-outline]:not(.ring-1)");
}

/** The picked element's rectangle. Emphasis is the ring class. */
function selectionOutline(page: Page): Locator {
  return page.locator("[data-canvas-selection-outline].ring-1");
}

/** Largest edge `marker` misses the element's mapped box by. */
async function markerDelta(
  page: Page,
  marker: Locator,
  selector: string,
): Promise<number> {
  if ((await marker.count()) !== 1) return Number.POSITIVE_INFINITY;
  const box = await marker.boundingBox();
  if (box === null) return Number.POSITIVE_INFINITY;
  const target = await elementBoxInPage(page, selector);
  return Math.max(
    Math.abs(box.x - target.x),
    Math.abs(box.y - target.y),
    Math.abs(box.width - target.width),
    Math.abs(box.height - target.height),
  );
}

/** Center of the element's border box, in the test page's coordinates. */
async function elementCenter(
  page: Page,
  selector: string,
): Promise<{ x: number; y: number }> {
  const box = await elementBoxInPage(page, selector);
  return {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2),
  };
}

interface Aim {
  readonly x: number;
  readonly y: number;
}

function aimsMatch(left: Aim, right: Aim): boolean {
  return Math.abs(left.x - right.x) <= 2 && Math.abs(left.y - right.y) <= 2;
}

/**
 * The artifact iframe tells us where a pointer move actually arrived. Chrome
 * sometimes delivers the move after a CDP wheel shifted by that wheel's
 * delta, so the point Playwright aimed at is not the point the page hit.
 */
async function watchPointer(page: Page): Promise<void> {
  await pageFrame(page)
    .locator("html")
    .evaluate((html) => {
      const view = html.ownerDocument.defaultView as Window & {
        __pointerWatch?: boolean;
        __seenMove?: { x: number; y: number } | null;
      };
      if (view.__pointerWatch === true) return;
      view.__pointerWatch = true;
      view.__seenMove = null;
      view.addEventListener(
        "pointermove",
        (event) => {
          view.__seenMove = { x: event.clientX, y: event.clientY };
        },
        true,
      );
    });
}

async function takeSeenMove(page: Page): Promise<Aim | null> {
  return pageFrame(page)
    .locator("html")
    .evaluate((html) => {
      const view = html.ownerDocument.defaultView as Window & {
        __seenMove?: Aim | null;
      };
      const seen = view.__seenMove ?? null;
      view.__seenMove = null;
      return seen;
    });
}

/**
 * Move onto an element inside the artifact iframe, correcting when Chrome
 * shifts the delivered event. The element's own rectangle is the target:
 * Playwright's box for it sometimes carries the same wheel shift.
 */
async function moveOnto(page: Page, selector: string): Promise<Aim> {
  await watchPointer(page);
  const target = await elementCenter(page, selector);
  let aim = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await takeSeenMove(page);
    await page.mouse.move(aim.x, aim.y);
    await nextFrames(page, 2);
    const seen = await takeSeenMove(page);
    if (seen === null) continue;
    const frameBox = await boxOf(frameElement(page));
    const delivered = {
      x: Math.round(frameBox.x + seen.x),
      y: Math.round(frameBox.y + seen.y),
    };
    if (aimsMatch(delivered, target)) return aim;
    aim = aimsMatch(delivered, aim)
      ? target
      : {
          x: Math.round(target.x - (delivered.x - aim.x)),
          y: Math.round(target.y - (delivered.y - aim.y)),
        };
  }
  throw new Error(`pointer missed ${selector}`);
}

async function clickInPage(page: Page, selector: string): Promise<void> {
  await moveOnto(page, selector);
  await page.mouse.down();
  await page.mouse.up();
}

/** Playwright's box of the element sits fully inside the iframe. */
async function boxInsideFrame(page: Page, selector: string): Promise<boolean> {
  const frameBox = await boxOf(frameElement(page));
  const target = await pageFrame(page).locator(selector).boundingBox();
  if (target === null) return false;
  return (
    target.y >= frameBox.y &&
    target.y + target.height <= frameBox.y + frameBox.height &&
    target.x >= frameBox.x &&
    target.x + target.width <= frameBox.x + frameBox.width
  );
}

async function pointInFrame(page: Page): Promise<{ x: number; y: number }> {
  const frameBox = await boxOf(frameElement(page));
  return {
    x: Math.round(frameBox.x + frameBox.width / 2),
    y: Math.round(frameBox.y + frameBox.height / 2),
  };
}

async function wheelOnPage(page: Page, deltaY: number): Promise<void> {
  const point = await pointInFrame(page);
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, deltaY);
}

/**
 * Scroll the page far enough to see the selection move, and keep the element
 * fully inside the frame. The outline is clipped to the frame, so a box that
 * hangs off the edge no longer matches the element's own rectangle.
 */
async function wheelSelectionFollows(
  page: Page,
  selector: string,
): Promise<void> {
  const frameBox = await boxOf(frameElement(page));
  const before = await elementBoxInPage(page, selector);
  const roomAbove = before.y - frameBox.y;
  const roomBelow = frameBox.y + frameBox.height - (before.y + before.height);
  const delta =
    roomBelow > roomAbove
      ? -Math.min(180, Math.floor(roomBelow - 24))
      : Math.min(180, Math.floor(roomAbove - 24));
  await wheelOnPage(page, delta);
  await expect
    .poll(async () => {
      const moved = await elementBoxInPage(page, selector);
      const shifted =
        delta < 0 ? moved.y > before.y + 20 : moved.y < before.y - 20;
      return (
        shifted &&
        (await markerDelta(page, selectionOutline(page), selector)) <= 2
      );
    })
    .toBe(true);
}

/** Wheel until the element's box sits inside the frame, clear of the edges. */
async function wheelUntilInside(page: Page, selector: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const frameBox = await boxOf(frameElement(page));
    const target = await elementBoxInPage(page, selector);
    const margin = 32;
    if (
      target.y >= frameBox.y + margin &&
      target.y + target.height <= frameBox.y + frameBox.height - margin &&
      target.x >= frameBox.x &&
      target.x + target.width <= frameBox.x + frameBox.width
    )
      return;
    const delta =
      target.y + target.height / 2 < frameBox.y + frameBox.height / 2
        ? -240
        : 240;
    await wheelOnPage(page, delta);
  }
  throw new Error(`${selector} never scrolled into the frame`);
}

/** Wheel back toward the top. A reload is not how the controls are reached. */
async function wheelUntilScrollAtMost(
  page: Page,
  limit: number,
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await memory(page)).scrollY <= limit) return;
    await wheelOnPage(page, -480);
  }
  throw new Error(`scrollY stayed ${(await memory(page)).scrollY}`);
}

/**
 * One Chrome touch gesture on one CDP session. Touch state is per session:
 * an end sent on a fresh session is rejected, because that session never saw
 * the start.
 */
async function withTouch(
  page: Page,
  run: (
    send: (
      type: "touchStart" | "touchMove" | "touchEnd",
      touchPoints: readonly { x: number; y: number }[],
    ) => Promise<void>,
  ) => Promise<void>,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await run(async (type, touchPoints) => {
      await cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: touchPoints.map((point) => ({
          x: Math.round(point.x),
          y: Math.round(point.y),
        })),
      });
    });
  } finally {
    await cdp.detach();
  }
}

test("comment mode keeps the loaded page, and reading still reaches it", async ({
  page,
}) => {
  await open(page);
  await clickInPage(page, "#counter");
  await expect(pageFrame(page).locator("#counter")).toHaveText("count 1");
  await clickInPage(page, "#fold-summary");
  await expect(pageFrame(page).locator("#fold")).toHaveJSProperty("open", true);
  await clickInPage(page, "#note");
  await page.keyboard.type("kept");
  await wheelOnPage(page, 360);
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(zoomReadout(page)).toHaveText("120%");
  await frameElement(page).evaluate((frame) => {
    frame.dataset.traycerFrame = "mounted";
  });
  const before = await memory(page);
  expect(before.scrollY).toBeGreaterThan(0);
  expect(before.note).toBe("kept");
  expect(before.zoom).toBe("1.2");

  await setComments(page, true);
  await nextFrames(page, 5);
  expect(await memory(page)).toEqual(before);
  await expect(frameElement(page)).toHaveAttribute(
    "data-traycer-frame",
    "mounted",
  );

  await setComments(page, false);
  await nextFrames(page, 5);
  expect(await memory(page)).toEqual(before);

  // The checks above hold the scrolled page. Wheel back, the way a reader
  // would, so the click and Escape land on the controls and not on empty
  // space where they used to be.
  await wheelUntilScrollAtMost(page, 1);
  expect(await boxInsideFrame(page, "#counter")).toBe(true);
  await clickInPage(page, "#counter");
  await expect(pageFrame(page).locator("#counter")).toHaveText("count 2");
  await clickInPage(page, "#note");
  await page.keyboard.press("Escape");
  await expect
    .poll(async () => (await memory(page)).escaped)
    .toBe(String(Number(before.escaped) + 1));
  expect((await memory(page)).loadId).toBe(before.loadId);
});

test("zoom and wheel scroll keep working while Comments is on", async ({
  page,
}) => {
  await open(page);
  await setComments(page, true);

  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(zoomReadout(page)).toHaveText("120%");
  await page.getByRole("button", { name: "Zoom out" }).click();
  await expect(zoomReadout(page)).toHaveText("100%");

  await page.keyboard.down("Control");
  await wheelOnPage(page, ZOOM_TO_150_DELTA);
  await page.keyboard.up("Control");
  await expect(zoomReadout(page)).toHaveText("150%");

  await page.getByRole("button", { name: "Zoom out" }).click();
  await expect(zoomReadout(page)).not.toHaveText("150%");
  const scrolled = (await memory(page)).scrollY;
  await wheelOnPage(page, 480);
  await expect
    .poll(async () => (await memory(page)).scrollY)
    .toBeGreaterThan(scrolled + 40);
});

async function pinOffset(page: Page, selector: string): Promise<number> {
  const pinBox = await page
    .getByRole("button", { name: "Open comment 1" })
    .boundingBox();
  if (pinBox === null) return Number.POSITIVE_INFINITY;
  const target = await elementBoxInPage(page, selector);
  // The pin hangs off the element's top-right: its right edge on the
  // element's right edge, its top on the element's top.
  return Math.max(
    Math.abs(pinBox.x + pinBox.width - (target.x + target.width)),
    Math.abs(pinBox.y - target.y),
  );
}

/**
 * Hover until the page's outline sits on the element. A wheel can leave the
 * next pointer event shifted, so the first aim may highlight the element
 * below; each miss aims again by how far that outline missed.
 */
async function hoverElement(page: Page, selector: string): Promise<void> {
  const box = await elementBoxInPage(page, selector);
  let aim = {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2),
  };
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await page.mouse.move(aim.x, aim.y);
    await nextFrames(page, 4);
    if ((await markerDelta(page, hoverOutline(page), selector)) <= 2) return;
    const outlineBox = await hoverOutline(page).boundingBox();
    const target = await elementBoxInPage(page, selector);
    if (outlineBox === null) continue;
    aim = {
      x: Math.round(aim.x - (outlineBox.x - target.x)),
      y: Math.round(aim.y - (outlineBox.y - target.y)),
    };
  }
  throw new Error(`hover missed ${selector}`);
}

test("a deep element can be hovered and picked, and the selection follows scroll and zoom", async ({
  page,
}) => {
  await open(page);
  await setComments(page, true);
  await wheelUntilInside(page, "#deep");
  await hoverElement(page, "#deep");
  await expect.poll(() => pinOffset(page, "#deep")).toBeLessThanOrEqual(4);

  await clickInPage(page, "#deep");
  await expect
    .poll(() => markerDelta(page, selectionOutline(page), "#deep"))
    .toBeLessThanOrEqual(2);

  await wheelSelectionFollows(page, "#deep");

  // Zoom after the pick. The selection was made at 100%, so this checks that
  // the box is measured again, not that a new hit test lands. The selection
  // ring is measured on its own, so a hover rectangle under the wheel does
  // not count as a second answer.
  await page.keyboard.down("Control");
  await wheelOnPage(page, ZOOM_TO_150_DELTA);
  await page.keyboard.up("Control");
  await expect(zoomReadout(page)).toHaveText("150%");
  await wheelUntilInside(page, "#deep");
  await expect
    .poll(() => markerDelta(page, selectionOutline(page), "#deep"))
    .toBeLessThanOrEqual(2);
  await expect.poll(() => pinOffset(page, "#deep")).toBeLessThanOrEqual(4);
  await wheelSelectionFollows(page, "#deep");
});

test("at 150% zoom a hover and a pick land on the element under the pointer", async ({
  page,
}) => {
  await open(page);
  await setComments(page, true);
  await page.keyboard.down("Control");
  await wheelOnPage(page, ZOOM_TO_150_DELTA);
  await page.keyboard.up("Control");
  await expect(zoomReadout(page)).toHaveText("150%");

  await wheelUntilInside(page, "#deep");
  await hoverElement(page, "#deep");

  await clickInPage(page, "#deep");
  await expect
    .poll(() => markerDelta(page, selectionOutline(page), "#deep"))
    .toBeLessThanOrEqual(2);

  await wheelSelectionFollows(page, "#deep");
});

test("comment mode picks instead of activating the page, while a pinch still zooms", async ({
  page,
}) => {
  await open(page);
  const before = await memory(page);
  await setComments(page, true);

  await clickInPage(page, "#counter");
  await clickInPage(page, "#away");
  await nextFrames(page, 5);
  const afterClicks = await memory(page);
  expect(afterClicks.counter).toBe("count 0");
  expect(afterClicks.loadId).toBe(before.loadId);
  await expect(pageFrame(page).locator("#away")).toBeVisible();
  await expect(page.getByText("This page is not in the artifact.")).toHaveCount(
    0,
  );

  const touch = await centreOf(pageFrame(page).locator("#touch"));
  await withTouch(page, async (send) => {
    await send("touchStart", [touch]);
    await send("touchEnd", []);
  });
  await nextFrames(page, 5);
  expect((await memory(page)).touch).toBe("touch 0");

  const center = await pointInFrame(page);
  const spread = (distance: number) => [
    { x: center.x - distance / 2, y: center.y },
    { x: center.x + distance / 2, y: center.y },
  ];
  await withTouch(page, async (send) => {
    await send("touchStart", spread(80));
    for (let step = 1; step <= 6; step += 1)
      await send("touchMove", spread(80 + (160 * step) / 6));
    await send("touchEnd", []);
  });
  await expect
    .poll(async () => (await memory(page)).zoom)
    .not.toBe(before.zoom);

  const scrolled = (await memory(page)).scrollY;
  const from = { x: center.x, y: center.y + 80 };
  const to = { x: center.x, y: center.y - 120 };
  await withTouch(page, async (send) => {
    await send("touchStart", [from]);
    for (let step = 1; step <= 8; step += 1) {
      const t = step / 8;
      await send("touchMove", [
        { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t },
      ]);
    }
    await send("touchEnd", []);
  });
  await expect
    .poll(async () => (await memory(page)).scrollY, { timeout: 3_000 })
    .toBeGreaterThan(scrolled + 20);
});
