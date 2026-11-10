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
  readonly revealThread: (threadId: string) => void;
  readonly lastThreadId: () => string | null;
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

/**
 * A wheel keeps moving the page after the event returns, and a box read
 * during that animation is stale by the time the outline is drawn. Wait
 * until scroll and zoom hold for three frames, then measure.
 */
async function scrollSettled(page: Page): Promise<void> {
  const read = async (): Promise<string> => {
    const now = await memory(page);
    return `${String(now.scrollY)}\0${now.zoom}`;
  };
  let previous = await read();
  let held = 0;
  await expect
    .poll(
      async () => {
        await nextFrames(page, 1);
        const next = await read();
        held = next === previous ? held + 1 : 0;
        previous = next;
        return held;
      },
      { intervals: [0], timeout: 5_000 },
    )
    .toBeGreaterThanOrEqual(3);
}

/** One move to the element's centre. The caller asserts where the outline lands. */
async function hoverElement(page: Page, selector: string): Promise<void> {
  const center = await elementCenter(page, selector);
  await page.mouse.move(center.x, center.y);
  await expect
    .poll(() => markerDelta(page, hoverOutline(page), selector))
    .toBeLessThanOrEqual(2);
}

async function clickInPage(page: Page, selector: string): Promise<void> {
  const center = await elementCenter(page, selector);
  await page.mouse.click(center.x, center.y);
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
  await scrollSettled(page);
}

async function clickZoom(
  page: Page,
  name: "Zoom in" | "Zoom out",
): Promise<void> {
  await page.getByRole("button", { name }).click();
  await scrollSettled(page);
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
  await clickZoom(page, "Zoom in");
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

  await clickZoom(page, "Zoom in");
  await expect(zoomReadout(page)).toHaveText("120%");
  await clickZoom(page, "Zoom out");
  await expect(zoomReadout(page)).toHaveText("100%");

  await page.keyboard.down("Control");
  await wheelOnPage(page, ZOOM_TO_150_DELTA);
  await page.keyboard.up("Control");
  await expect(zoomReadout(page)).toHaveText("150%");

  await clickZoom(page, "Zoom out");
  await expect(zoomReadout(page)).not.toHaveText("150%");
  const scrolled = (await memory(page)).scrollY;
  await wheelOnPage(page, 480);
  await expect
    .poll(async () => (await memory(page)).scrollY)
    .toBeGreaterThan(scrolled + 40);
});

async function pinOffset(page: Page, selector: string): Promise<number> {
  // The deep section's own pin. Its number follows document order, so it is
  // not the comment labelled 1 once another thread sits above it.
  const pinBox = await pin(page, "thread-deep").boundingBox();
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
 * Centre of the zoom script's vertical thumb, in the test page's coordinates.
 * The thumb is in a closed shadow root, so this is the script's own formula:
 * the track starts below the page inset, and the button sits 3px from the
 * right and 6px from the top.
 */
async function verticalThumbCentre(
  page: Page,
): Promise<{ x: number; y: number }> {
  const frameBox = await boxOf(frameElement(page));
  const inner = await pageFrame(page)
    .locator("html")
    .evaluate((html) => {
      const view = html.ownerDocument.defaultView;
      const root = html.ownerDocument.scrollingElement;
      if (view === null || root === null) return null;
      const start =
        Number.parseFloat(
          view
            .getComputedStyle(html)
            .getPropertyValue("--traycer-page-inset-top"),
        ) || 0;
      const track = view.innerHeight - 12 - start;
      const length = Math.min(
        track,
        Math.max(28, (view.innerHeight / root.scrollHeight) * track),
      );
      const offset =
        start +
        (root.scrollTop / (root.scrollHeight - view.innerHeight)) *
          (track - length);
      return {
        x: view.innerWidth - 5.5,
        y: 6 + offset + length / 2,
      };
    });
  if (inner === null) throw new Error("no scrollbar thumb");
  return { x: frameBox.x + inner.x, y: frameBox.y + inner.y };
}

test("the scrollbar thumb still scrolls while Comments is on", async ({
  page,
}) => {
  await open(page);
  await setComments(page, true);
  // The thumb starts under the zoom chip. One wheel puts it below that chip.
  await wheelOnPage(page, 480);
  const before = (await memory(page)).scrollY;
  const thumb = await verticalThumbCentre(page);
  await page.mouse.move(thumb.x - 30, thumb.y);
  await page.mouse.move(thumb.x, thumb.y);
  await nextFrames(page, 2);
  await page.mouse.down();
  for (let step = 1; step <= 5; step += 1)
    await page.mouse.move(thumb.x, thumb.y + (100 * step) / 5);
  await page.mouse.up();
  await scrollSettled(page);

  expect((await memory(page)).scrollY).toBeGreaterThan(before + 100);
  await expect(
    page.getByRole("button", { name: "Comment", exact: true }),
  ).toHaveCount(0);
  await expect(selectionOutline(page)).toHaveCount(0);
});

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

  // A row is 21px tall at 150%, so a hit test off by more than about 10px
  // outlines and picks the row next to it.
  await wheelUntilInside(page, "#row-3");
  await hoverElement(page, "#row-3");

  await clickInPage(page, "#row-3");
  await expect
    .poll(() => markerDelta(page, selectionOutline(page), "#row-3"))
    .toBeLessThanOrEqual(2);

  await wheelSelectionFollows(page, "#row-3");
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
  await scrollSettled(page);

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

const MISSING = "This page is not in the artifact.";
const UNREACHABLE = "Couldn't load this page from its host.";

function pin(page: Page, threadId: string): Locator {
  return page.locator(`[data-comment-pin="${threadId}"]`);
}

async function postedThreadId(page: Page): Promise<string> {
  const threadId = await page.evaluate(() => {
    const probe = (window as ProbeWindow).__commentModeProbe;
    if (probe === undefined) throw new Error("no comment-mode probe");
    return probe.lastThreadId();
  });
  if (threadId === null) throw new Error("no comment was created");
  return threadId;
}

/** Hover, pick, and post. The pin is the comment's, and the document is the one already loaded. */
async function commentOn(page: Page, selector: string): Promise<string> {
  const loaded = (await memory(page)).loadId;
  await hoverElement(page, selector);
  await clickInPage(page, selector);
  const dialog = page.getByRole("dialog", { name: "New comment" });
  await expect(dialog).toBeVisible();
  await dialog
    .locator('[contenteditable="true"]')
    .fill("A note on this element");
  await dialog.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const threadId = await postedThreadId(page);
  await expect(pin(page, threadId)).toBeVisible();
  expect((await memory(page)).loadId).toBe(loaded);
  return threadId;
}

async function expectOnlyPin(
  page: Page,
  shown: string,
  hidden: string,
): Promise<void> {
  await expect(pin(page, shown)).toBeVisible();
  await expect(pin(page, hidden)).toHaveCount(0);
}

test("a comment on the entry page is adopted without reloading it", async ({
  page,
}) => {
  await open(page);
  await setComments(page, true);

  await commentOn(page, "#fresh");
  // The seeded entry pin sits at the top of the page, so it is on screen
  // without scrolling down to the deep section.
  await expect(pin(page, "thread-top")).toBeVisible();
});

test("each page shows only its own pins, and Back and Home keep that", async ({
  page,
}) => {
  await open(page);
  await setComments(page, true);
  await expectOnlyPin(page, "thread-top", "thread-marked");

  // Comment mode takes the click, so the link is followed with the tool off.
  await setComments(page, false);
  await clickInPage(page, "#detail");
  await expect(pageFrame(page).locator("#marked")).toBeVisible();
  await setComments(page, true);
  await expectOnlyPin(page, "thread-marked", "thread-top");

  await page.getByRole("button", { name: "Back" }).click();
  await expect(pageFrame(page).locator("#counter")).toBeVisible();
  await expect(pageFrame(page).locator("#marked")).toHaveCount(0);
  await expectOnlyPin(page, "thread-top", "thread-marked");

  await setComments(page, false);
  await clickInPage(page, "#detail");
  await expect(pageFrame(page).locator("#marked")).toBeVisible();
  await setComments(page, true);
  await page.getByRole("button", { name: "Home" }).click();
  await expect(pageFrame(page).locator("#counter")).toBeVisible();
  await expect(pageFrame(page).locator("#marked")).toHaveCount(0);
  await expectOnlyPin(page, "thread-top", "thread-marked");
});

test("a comment stamped on the other page is still there after Home and the link back", async ({
  page,
}) => {
  await open(page);
  await clickInPage(page, "#detail");
  await expect(pageFrame(page).locator("#marked")).toBeVisible();
  await setComments(page, true);
  const threadId = await commentOn(page, "#fresh");
  const stamped = (await memory(page)).loadId;

  await page.getByRole("button", { name: "Home" }).click();
  await expect(pageFrame(page).locator("#marked")).toHaveCount(0);
  await expect(pageFrame(page).locator("#counter")).toBeVisible();
  await expect(pin(page, threadId)).toHaveCount(0);

  await setComments(page, false);
  await clickInPage(page, "#detail");
  await expect(pageFrame(page).locator("#marked")).toBeVisible();
  await setComments(page, true);

  expect((await memory(page)).loadId).not.toBe(stamped);
  await expect(pageFrame(page).locator("#fresh")).toHaveAttribute(
    "data-tid",
    /.+/,
  );
  await expect(pin(page, threadId)).toBeVisible();
  await expect(pin(page, "thread-deep")).toHaveCount(0);
});

test("revealing a thread on the other page opens it and Back returns", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    const probe = (window as ProbeWindow).__commentModeProbe;
    if (probe === undefined) throw new Error("no comment-mode probe");
    probe.revealThread("thread-marked");
  });

  await expect(commentsButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(pageFrame(page).locator("#marked")).toBeVisible();
  await expect
    .poll(() => markerDelta(page, selectionOutline(page), "#marked"))
    .toBeLessThanOrEqual(2);

  await page.getByRole("button", { name: "Back" }).click();
  await expect(pageFrame(page).locator("#counter")).toBeVisible();
  await expect(pageFrame(page).locator("#marked")).toHaveCount(0);
  await expect(commentsButton(page)).toHaveAttribute("aria-pressed", "true");
});

test("a missing page stays on its stand-in when Comments turns on", async ({
  page,
}) => {
  await open(page);
  await clickInPage(page, "#away");
  await expect(page.getByText(MISSING)).toBeVisible();

  await setComments(page, true);

  await expect(page.getByText(MISSING)).toBeVisible();
  await expect(
    page.getByText("Comments can't be added on this page."),
  ).toHaveCount(0);
  await expect(page.locator("[data-canvas-selection-overlay]")).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "New comment" })).toHaveCount(
    0,
  );

  await page.getByRole("button", { name: "Go home" }).click();
  await expect(pageFrame(page).locator("#counter")).toBeVisible();
  await expect(page.getByText(MISSING)).toHaveCount(0);
});

test("an unreachable page stays on its stand-in when Comments turns on", async ({
  page,
}) => {
  await open(page);
  await clickInPage(page, "#broken");
  await expect(page.getByText(UNREACHABLE)).toBeVisible();

  await setComments(page, true);

  await expect(page.getByText(UNREACHABLE)).toBeVisible();
  await expect(
    page.getByText("Comments can't be added on this page."),
  ).toHaveCount(0);
  await expect(page.locator("[data-canvas-selection-overlay]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();

  await page.getByRole("button", { name: "Back" }).click();
  await expect(pageFrame(page).locator("#counter")).toBeVisible();
  await expect(page.getByText(UNREACHABLE)).toHaveCount(0);
});

test("a link still opens the other page while Comments is off, and that page still runs", async ({
  page,
}) => {
  await open(page);
  await clickInPage(page, "#detail");
  await expect(pageFrame(page).locator("#marked")).toBeVisible();
  await expect(page.locator("[data-canvas-selection-overlay]")).toHaveCount(0);

  await clickInPage(page, "#counter");

  await expect(pageFrame(page).locator("#counter")).toHaveText("count 1");
});
