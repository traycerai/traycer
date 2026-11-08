import { expect, test, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// The list compensates a row measured above the view with a scroll adjust
// (`maintainVisibleContentPosition`). Written during a touch fling, that
// adjust ended the fling on iOS and painted a step. The patched list holds a
// touch scroll's adjust in its pending layout term instead, and commits it
// when the scroll ends: these tests drive the real list with touch input
// (CDP, so the scroller receives `touchstart`/`touchend` as a finger's) and
// scroll reports, and read what the scroller and the rows on screen do. The
// fixture is `src/__tests__/browser/legend-list-touch-fling-adjust.tsx`.

declare global {
  interface Window {
    __growRow?: (index: number, by: number) => void;
  }
}

const SCROLLER = "[data-testid=list]";
const ROW = 100;
const GROWTH = 300;
// The list's scroll-end fallback (`SCROLL_END_FALLBACK_MS`): a fling whose
// scroller has been quiet this long has ended.
const QUIET_MS = 200;

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 700 },
});

async function open(page: Page): Promise<void> {
  await page.goto(fixture("legend-list-touch-fling-adjust"));
  await expect(page.locator('[data-row="row-0"]')).toBeVisible();
}

function scrollTop(page: Page): Promise<number> {
  return page.evaluate((selector) => {
    const scroller = document.querySelector(selector);
    if (!(scroller instanceof HTMLElement)) throw new Error("no scroller");
    return scroller.scrollTop;
  }, SCROLLER);
}

/** One scroll report: the offset is written and the frame that carries its
 *  scroll event is waited out. */
async function report(page: Page, top: number): Promise<void> {
  await page.evaluate(
    ([selector, value]) => {
      const scroller = document.querySelector(selector);
      if (!(scroller instanceof HTMLElement)) throw new Error("no scroller");
      scroller.scrollTop = Number(value);
    },
    [SCROLLER, String(top)],
  );
  await nextFrames(page, 3);
}

/** Where a row's top edge is on screen: the reader's view of it. */
function rowTop(page: Page, index: number): Promise<number | null> {
  return page.evaluate(
    (id) => {
      const row = document.querySelector(`[data-row="${id}"]`);
      return row === null ? null : Math.round(row.getBoundingClientRect().top);
    },
    `row-${String(index)}`,
  );
}

async function growRow(page: Page, index: number): Promise<void> {
  await page.evaluate(
    ([index, by]) => {
      if (window.__growRow === undefined) throw new Error("no fixture");
      window.__growRow(index, by);
    },
    [index, GROWTH] as const,
  );
}

/** A finger down and up on the scroller, no movement: what every fling begins
 *  with, and what leaves the list treating the scroller as a touch scroll's
 *  until it has been quiet. */
async function touch(page: Page): Promise<void> {
  const box = await page.locator(SCROLLER).boundingBox();
  if (box === null) throw new Error("no scroller box");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await cdp.detach();
}

test("without a touch scroll a row measured above the view adjusts the offset at once", async ({
  page,
}) => {
  await open(page);
  await report(page, 20 * ROW);
  const marker = 20;
  const before = await rowTop(page, marker);

  await growRow(page, 18);

  await expect.poll(() => scrollTop(page)).toBe(20 * ROW + GROWTH);
  expect(await rowTop(page, marker)).toBe(before);
});

test("a touch scroll's adjust waits in the layout and is committed once the scroller is quiet", async ({
  page,
}) => {
  await open(page);
  await report(page, 40 * ROW);
  const marker = 40;
  const before = await rowTop(page, marker);

  await touch(page);
  await growRow(page, 38);
  await nextFrames(page, 4);

  // The row grew and the view did not move: the layout took the adjust and
  // the scroller was not written.
  expect(await scrollTop(page)).toBe(40 * ROW);
  expect(await rowTop(page, marker)).toBe(before);

  // Quiet for the fallback: the commit writes the whole adjust, and the row
  // on screen stays where it was.
  await page.waitForTimeout(QUIET_MS * 2);
  await expect.poll(() => scrollTop(page)).toBe(40 * ROW + GROWTH);
  expect(await rowTop(page, marker)).toBe(before);
});

interface AnnouncedWrite {
  readonly from: number;
  readonly to: number;
}

/** Every write the list makes to its scroller, as it announces them. */
async function recordWrites(page: Page): Promise<void> {
  await page.evaluate((selector) => {
    const scroller = document.querySelector(selector);
    if (scroller === null) throw new Error("no scroller");
    const writes: AnnouncedWrite[] = [];
    Reflect.set(window, "__writes", writes);
    scroller.addEventListener("legend-list-scroller-moved", (event) => {
      const detail: unknown = Reflect.get(event, "detail");
      if (typeof detail !== "object" || detail === null) return;
      const from: unknown = Reflect.get(detail, "from");
      const to: unknown = Reflect.get(detail, "to");
      if (typeof from === "number" && typeof to === "number") {
        writes.push({ from: Math.round(from), to: Math.round(to) });
      }
    });
  }, SCROLLER);
}

function writes(page: Page): Promise<AnnouncedWrite[]> {
  return page.evaluate("window.__writes") as Promise<AnnouncedWrite[]>;
}

/** A fling's reports: one offset per animation frame, in one page task, so
 *  the browser's `scrollend` comes once, after the last, as a fling's does. */
async function fling(page: Page, tops: readonly number[]): Promise<void> {
  await page.evaluate(
    ([selector, offsets]) =>
      new Promise<void>((resolve) => {
        const scroller = document.querySelector(selector);
        if (!(scroller instanceof HTMLElement)) throw new Error("no scroller");
        let index = 0;
        const tick = (): void => {
          if (index >= offsets.length) {
            resolve();
            return;
          }
          scroller.scrollTop = offsets[index];
          index += 1;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    [SCROLLER, tops] as const,
  );
}

test("a fling that reaches the end commits the pending adjust a step early, in full", async ({
  page,
}) => {
  await open(page);
  await report(page, 50 * ROW);
  await recordWrites(page);
  await touch(page);
  await growRow(page, 48);
  await nextFrames(page, 4);
  expect(await scrollTop(page)).toBe(50 * ROW);
  expect(await writes(page)).toEqual([]);

  // The fling runs into the end of the content, 100px a frame. Left to the
  // commit at rest, the pending 300 would be clamped there and the rows on
  // screen would step by the difference. The list commits it from the last
  // report where it still lands: the first write is the whole adjust, inside
  // the range. The rows the fling mounts on its way are re-estimated, and
  // those smaller adjusts follow the same rule, so no write is clamped. (The
  // end is read from the scroller, since the re-estimates move it.)
  const end = await scrollEnd(page);
  await fling(
    page,
    Array.from({ length: 12 }, (_, i) => end - 1000 + (i + 1) * 100),
  );
  await page.waitForTimeout(QUIET_MS * 2);

  const seen = await writes(page);
  expect(seen.length).toBeGreaterThanOrEqual(1);
  expect(seen[0].to - seen[0].from).toBe(GROWTH);
  const endAfter = await scrollEnd(page);
  for (const write of seen) {
    expect(write.to).toBeLessThanOrEqual(endAfter);
    expect(write.to).toBeGreaterThanOrEqual(0);
  }
});

/** The far end of the scroller's range. */
function scrollEnd(page: Page): Promise<number> {
  return page.evaluate((selector) => {
    const scroller = document.querySelector(selector);
    if (!(scroller instanceof HTMLElement)) throw new Error("no scroller");
    return scroller.scrollHeight - scroller.clientHeight;
  }, SCROLLER);
}
