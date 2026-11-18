import { expect, test, type Page } from "@playwright/test";

import {
  centreOf,
  fixture,
  nextFrames,
  type Point,
} from "./support/fixtures.ts";

// Accepting the composer's suggested prompt on a touch screen.
//
// The suggestion is the empty composer's placeholder. A tap must only focus
// the composer - it is how a phone user starts typing - and a rightward swipe
// over it accepts, the stand-in for → on a keyboard that has no arrow keys.
//
// jsdom can check the recognizer's arithmetic and nothing else. Whether a tap
// is delivered as a focus, and whether a sideways drag reaches the page as
// pointer moves instead of being taken by the browser as a pan and cancelled,
// are decided by Chrome's own touch pipeline, which is what these drive.

const SUGGESTION = "Add a test for the new endpoint";
const EDITOR = '[data-testid="composer-editor"]';
const PLACEHOLDER = `${EDITOR} p.is-editor-empty`;
/** How far each swipe travels: well past the distance that accepts. */
const SWIPE_TRAVEL_PX = 120;

/**
 * A drag slow enough that only its DISTANCE can accept it: 4px a frame is a
 * quarter of the speed that accepts on its own. This is the gesture the
 * browser gets to arbitrate - it is still travelling long after the point
 * where Chrome takes an unreserved drag for a pan and cancels the pointer.
 */
const SLOW_DRAG = { stepPx: 4, framesBetweenMoves: 1 } as const;

/**
 * A flick: the whole distance in a few moves with no frames between them, so
 * it accepts on speed, on the move that declares it.
 */
const FLICK = { stepPx: 30, framesBetweenMoves: 0 } as const;

interface DragPace {
  readonly stepPx: number;
  readonly framesBetweenMoves: number;
}

test.use({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
});

/** Loads the fixture and waits for the editor to be showing the suggestion. */
async function openComposer(page: Page): Promise<Point> {
  await page.goto(fixture("prompt-suggestion-swipe"));
  await expect(page.locator(PLACEHOLDER)).toHaveAttribute(
    "data-placeholder",
    SUGGESTION,
  );
  expect(
    await page.evaluate("matchMedia('(pointer: coarse)').matches"),
    "premise: Chrome must report a touch screen",
  ).toBe(true);
  return centreOf(page.locator(EDITOR));
}

/**
 * One finger down at `from`, dragged rightward at the given pace, then lifted.
 * Paced in frames, not milliseconds, so a loaded runner makes the drag slower
 * and never faster.
 */
async function swipeRight(
  page: Page,
  from: Point,
  pace: DragPace,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: from.x, y: from.y }],
  });
  for (
    let travelPx = pace.stepPx;
    travelPx <= SWIPE_TRAVEL_PX;
    travelPx += pace.stepPx
  ) {
    if (pace.framesBetweenMoves > 0) {
      await nextFrames(page, pace.framesBetweenMoves);
    }
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: from.x + travelPx, y: from.y }],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await cdp.detach();
}

/** Where a swipe starts so that it is centred on the editor. */
function swipeStart(centre: Point): Point {
  return { x: centre.x - SWIPE_TRAVEL_PX / 2, y: centre.y };
}

test("a tap focuses the composer and leaves the suggestion as its placeholder", async ({
  page,
}) => {
  const centre = await openComposer(page);

  await page.touchscreen.tap(centre.x, centre.y);

  // The focus is the proof the tap landed; only then does "nothing was
  // filled" mean anything.
  await expect(page.locator(EDITOR)).toBeFocused();
  await expect(page.locator(EDITOR)).toHaveText("");
  await expect(page.locator(PLACEHOLDER)).toHaveAttribute(
    "data-placeholder",
    SUGGESTION,
  );
});

// The one that fails without the editor's `touch-action` reservation: Chrome
// cancels the pointer a few pixels into the drag and the swipe never finishes.
test("a slow rightward drag over the composer fills it with the suggestion", async ({
  page,
}) => {
  const centre = await openComposer(page);

  await swipeRight(page, swipeStart(centre), SLOW_DRAG);

  await expect(page.locator(EDITOR)).toHaveText(SUGGESTION);
});

test("a quick rightward flick over the composer fills it with the suggestion", async ({
  page,
}) => {
  const centre = await openComposer(page);

  await swipeRight(page, swipeStart(centre), FLICK);

  await expect(page.locator(EDITOR)).toHaveText(SUGGESTION);
});

test("a rightward swipe still fills the composer after a tap has focused it", async ({
  page,
}) => {
  const centre = await openComposer(page);
  await page.touchscreen.tap(centre.x, centre.y);
  await expect(page.locator(EDITOR)).toBeFocused();

  await swipeRight(page, swipeStart(centre), SLOW_DRAG);

  await expect(page.locator(EDITOR)).toHaveText(SUGGESTION);
  await expect(page.locator(EDITOR)).toBeFocused();
});

test("the editor reserves its horizontal axis only while a suggestion is offered", async ({
  page,
}) => {
  const centre = await openComposer(page);
  await expect(page.locator(EDITOR)).toHaveCSS("touch-action", "pan-y");

  await swipeRight(page, swipeStart(centre), FLICK);

  await expect(page.locator(EDITOR)).toHaveText(SUGGESTION);
  await expect(page.locator(EDITOR)).toHaveCSS("touch-action", "auto");
});
