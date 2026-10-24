import { expect, test, type Page } from "@playwright/test";
import { fixture, nextFrames } from "./support/fixtures";

/**
 * A send while the reader is scrolled up, against the fixture in
 * `src/__tests__/browser/chat-send-void-rekey.tsx`: the real transcript folds
 * into the real `ChatMessages` list.
 *
 * A send voids the transcript index and streams a replacement back over
 * several commits. The reader's row must not move by a pixel through any of
 * them, and a detached reader must stay detached - the list's own landings
 * during the recovery are not the reader returning to the tail. Two sends at
 * the tail first, so the list has measured rows through a void before the
 * one that matters.
 */

interface Geometry {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

interface SendSample {
  readonly anchorOffset: number | null;
  readonly following: string | undefined;
}

declare global {
  interface Window {
    /** Written by the fixture: one send, void to complete index. */
    __sendThroughVoid?: () => Promise<void>;
    /** Written by the fixture: places a row `offset` px below the top. */
    __scrollRowTo?: (rowId: string, offset: number) => Promise<void>;
    /** Written by the fixture: a row's top relative to the scroller's. */
    __anchorOffset?: (rowId: string) => number | null;
    /** Written by the fixture: the list's live scroll geometry. */
    __geometry?: () => Geometry | null;
  }
}

const ANCHOR_ROW = "row-150";
const ANCHOR_OFFSET = 120;
/** Sub-pixel layout rounding, nothing more. */
const EPSILON_PX = 2;

async function geometry(page: Page): Promise<Geometry> {
  const result = await page.evaluate(() => window.__geometry?.() ?? null);
  if (result === null) throw new Error("no scroll node");
  return result;
}

async function following(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.body.dataset.following);
}

function distanceFromEnd(at: Geometry): number {
  return at.scrollHeight - at.scrollTop - at.clientHeight;
}

async function waitForScrollSettle(page: Page): Promise<Geometry> {
  let previous = await geometry(page);
  for (let i = 0; i < 60; i += 1) {
    await nextFrames(page, 6);
    const current = await geometry(page);
    if (
      current.scrollTop === previous.scrollTop &&
      current.scrollHeight === previous.scrollHeight
    ) {
      return current;
    }
    previous = current;
  }
  return previous;
}

/** One send, sampling the anchor and the follow mirror every frame until the
 *  folds are done and the scroller has held still for ten frames. */
async function sendSampling(
  page: Page,
  rowId: string,
): Promise<readonly SendSample[]> {
  return page.evaluate(async (anchorRowId) => {
    const samples: SendSample[] = [];
    const sample = (): void => {
      samples.push({
        anchorOffset: window.__anchorOffset?.(anchorRowId) ?? null,
        following: document.body.dataset.following,
      });
    };
    const progress = { done: false };
    const send = window.__sendThroughVoid?.().then(() => {
      progress.done = true;
    });
    if (send === undefined) throw new Error("no send driver");
    let previousScrollTop = Number.NaN;
    let previousScrollHeight = Number.NaN;
    let stillFrames = 0;
    while (!progress.done || stillFrames < 10) {
      await new Promise((resolve) => {
        requestAnimationFrame(resolve);
      });
      sample();
      const at = window.__geometry?.();
      const still =
        at !== null &&
        at !== undefined &&
        at.scrollTop === previousScrollTop &&
        at.scrollHeight === previousScrollHeight;
      stillFrames = still ? stillFrames + 1 : 0;
      previousScrollTop = at?.scrollTop ?? Number.NaN;
      previousScrollHeight = at?.scrollHeight ?? Number.NaN;
    }
    await send;
    return samples;
  }, rowId);
}

async function loadAfterTwoSendsAtTheEnd(page: Page): Promise<void> {
  await page.goto(fixture("chat-send-void-rekey"));
  await nextFrames(page, 10);
  await waitForScrollSettle(page);
  expect(await following(page)).toBe("true");
  for (let i = 0; i < 2; i += 1) {
    await page.evaluate(() => window.__sendThroughVoid?.());
    const after = await waitForScrollSettle(page);
    expect(await following(page)).toBe("true");
    expect(distanceFromEnd(after)).toBeLessThanOrEqual(1);
  }
}

async function expectSendKeepsTheAnchor(page: Page): Promise<void> {
  await page.evaluate(
    ({ rowId, offset }) => window.__scrollRowTo?.(rowId, offset),
    { rowId: ANCHOR_ROW, offset: ANCHOR_OFFSET },
  );
  await waitForScrollSettle(page);
  expect(await following(page)).toBe("false");
  const before = await page.evaluate(
    (rowId) => window.__anchorOffset?.(rowId) ?? null,
    ANCHOR_ROW,
  );
  expect(before).not.toBeNull();

  const samples = await sendSampling(page, ANCHOR_ROW);
  expect(samples.length).toBeGreaterThan(10);
  const offsets = samples.map((sample) => sample.anchorOffset);
  // Every frame of the recovery, not just where it settles: a jump the
  // library later corrects is still a jump the reader saw. A row that is no
  // longer rendered at all has left the viewport.
  const worstDrift = Math.max(
    ...offsets.map((offset) =>
      offset === null || before === null
        ? Number.POSITIVE_INFINITY
        : Math.abs(offset - before),
    ),
  );
  expect(
    worstDrift,
    `${ANCHOR_ROW}'s offset per frame, from ${String(before)}: ${JSON.stringify(offsets)}`,
  ).toBeLessThan(EPSILON_PX);
  expect(samples.map((sample) => sample.following)).toEqual(
    samples.map(() => "false"),
  );
  expect(await following(page)).toBe("false");
}

test.describe("wheel", () => {
  test.use({ viewport: { width: 390, height: 700 } });

  test("a send never moves a detached reader's row through the transcript void", async ({
    page,
  }) => {
    await loadAfterTwoSendsAtTheEnd(page);
    await page.mouse.move(195, 350);
    await page.mouse.wheel(0, -600);
    await expectSendKeepsTheAnchor(page);
  });
});

/** One finger, from `from` to `to`, as real touch input through Chrome. */
async function swipe(
  page: Page,
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
  steps: number,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: from.x, y: from.y }],
  });
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t },
      ],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await cdp.detach();
}

test.describe("touch", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 700 },
  });

  test("a send never moves a reader who swiped away (iOS WebKit) through the transcript void", async ({
    page,
  }) => {
    await loadAfterTwoSendsAtTheEnd(page);
    await page.evaluate(() => {
      document.body.dataset.swallowTouchmove = "true";
    });
    // Finger moves DOWN the screen: the content scrolls toward the top.
    await swipe(page, { x: 195, y: 250 }, { x: 195, y: 550 }, 12);
    await expectSendKeepsTheAnchor(page);
  });
});
