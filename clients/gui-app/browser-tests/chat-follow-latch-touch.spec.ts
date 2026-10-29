import { expect, test, type Page } from "@playwright/test";
import { fixture, nextFrames, wheelsDelivered } from "./support/fixtures";

/**
 * The chat transcript's bottom-follow under real touch input, against the
 * fixture in `src/__tests__/browser/chat-follow-latch-touch.tsx`.
 *
 * The first two tests are the same swipe twice: once with Chrome's full
 * touch sequence, once with `touchmove` withheld from the list, which is what
 * iOS WebKit does once its native pan owns the touch (and a touch landing
 * during a fling fires no touch or pointer event at all). Either way a swipe
 * away from the end must detach follow, so streamed content leaves the
 * reading position alone. The wheel test is the desktop control.
 */

interface Geometry {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** The row under the scroller's top edge, and its top relative to that edge. */
interface ReadingRow {
  readonly id: string;
  readonly top: number;
}

declare global {
  interface Window {
    /** Written by the fixture: the list's live scroll geometry. */
    __geometry?: () => Geometry | null;
    /** Written by the fixture: the row the reader is looking at. */
    __readingRow?: () => ReadingRow | null;
    /** Written by the fixture: appends one row. */
    __appendRow?: () => void;
    /** Written by the fixture: streams text into the last row. */
    __growLastRow?: () => void;
    /** Written by the fixture: grows the rendered row nearest above the
     *  view, which the list compensates by moving `scrollTop`. */
    __growRowAboveView?: () => string | null;
  }
}

async function geometry(page: Page): Promise<Geometry> {
  const result = await page.evaluate(() => window.__geometry?.() ?? null);
  if (result === null) throw new Error("no scroll node");
  return result;
}

async function readingRow(page: Page): Promise<ReadingRow> {
  const result = await page.evaluate(() => window.__readingRow?.() ?? null);
  if (result === null) throw new Error("no row under the top edge");
  return result;
}

async function following(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.body.dataset.following);
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

/** Three new rows, each streamed in four growth steps. */
async function streamContent(page: Page): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await page.evaluate(() => window.__appendRow?.());
    await nextFrames(page, 3);
    for (let j = 0; j < 4; j += 1) {
      await page.evaluate(() => window.__growLastRow?.());
      await nextFrames(page, 2);
    }
  }
}

async function loadFollowingAtEnd(page: Page): Promise<Geometry> {
  await page.goto(fixture("chat-follow-latch-touch"));
  await nextFrames(page, 10);
  const start = await waitForScrollSettle(page);
  expect(
    start.scrollHeight - start.scrollTop - start.clientHeight,
  ).toBeLessThanOrEqual(1);
  expect(await following(page)).toBe("true");
  return start;
}

/**
 * The reader's position is what they see: the row under the top edge and its
 * offset. Not raw `scrollTop`, which an anchored refresh of the estimates
 * above the view moves while nothing on screen does.
 */
async function expectReadingPositionKept(
  page: Page,
  start: Geometry,
): Promise<void> {
  const afterSwipe = await waitForScrollSettle(page);
  expect(afterSwipe.scrollTop).toBeLessThan(start.scrollTop - 50);
  const before = await readingRow(page);

  await streamContent(page);
  const afterStream = await waitForScrollSettle(page);
  expect(await following(page)).toBe("false");
  expect(afterStream.scrollHeight).toBeGreaterThan(afterSwipe.scrollHeight);
  const after = await readingRow(page);
  const kept = `the reader's position is kept: ${JSON.stringify({ before, after })}`;
  expect(after.id, kept).toBe(before.id);
  expect(Math.abs(after.top - before.top), kept).toBeLessThanOrEqual(2);
}

// Finger moves DOWN the screen: the content scrolls toward the top.
const SWIPE_FROM = { x: 195, y: 250 };
const SWIPE_TO = { x: 195, y: 550 };

test.describe("touch", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 700 },
  });

  test("a swipe away from the end keeps the reading position when new content arrives", async ({
    page,
  }) => {
    const start = await loadFollowingAtEnd(page);
    await swipe(page, SWIPE_FROM, SWIPE_TO, 12);
    await expectReadingPositionKept(page, start);
  });

  test("a swipe the list only sees as scroll events (iOS WebKit) keeps the reading position when new content arrives", async ({
    page,
  }) => {
    const start = await loadFollowingAtEnd(page);
    await page.evaluate(() => {
      document.body.dataset.swallowTouchmove = "true";
    });
    await swipe(page, SWIPE_FROM, SWIPE_TO, 12);
    await expectReadingPositionKept(page, start);
  });

  test("a tap at the end keeps following new content", async ({ page }) => {
    await loadFollowingAtEnd(page);
    await page.touchscreen.tap(195, 400);
    await nextFrames(page, 3);

    await streamContent(page);
    const afterStream = await waitForScrollSettle(page);
    expect(await following(page)).toBe("true");
    expect(
      afterStream.scrollHeight -
        afterStream.scrollTop -
        afterStream.clientHeight,
    ).toBeLessThanOrEqual(1);
  });
});

/**
 * One contact held across `body`: `touchStart` at `from`, then whatever the
 * test does (stream content, move the finger), then `touchEnd`. `move` shifts
 * the finger by `dy` in steps with frames between them, so the list reports
 * each step as its own scroll; a negative `dy` is toward the end.
 */
async function holdContact(
  page: Page,
  from: { readonly x: number; readonly y: number },
  body: (move: (dy: number) => Promise<void>) => Promise<void>,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  let y = from.y;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: from.x, y }],
  });
  await nextFrames(page, 2);
  const move = async (dy: number): Promise<void> => {
    const steps = Math.max(1, Math.round(Math.abs(dy) / 20));
    for (let i = 0; i < steps; i += 1) {
      y += dy / steps;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: from.x, y }],
      });
      await nextFrames(page, 2);
    }
  };
  try {
    await body(move);
  } finally {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await cdp.detach();
  }
}

/** Streamed text reaching the tail while a finger is held. */
async function growTailUnderContact(page: Page): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await page.evaluate(() => window.__appendRow?.());
    await nextFrames(page, 3);
    await page.evaluate(() => window.__growLastRow?.());
    await nextFrames(page, 2);
  }
}

async function expectAtTail(page: Page): Promise<void> {
  const settled = await waitForScrollSettle(page);
  expect(
    settled.scrollHeight - settled.scrollTop - settled.clientHeight,
  ).toBeLessThanOrEqual(1);
}

const CONTACT = { x: 195, y: 450 };

// The two deliveries of the same finger: Chrome's full touch sequence, and
// iOS WebKit's, where the list sees `touchstart`, scroll reports and
// `touchend` but no `touchmove`.
const DELIVERIES = [
  { name: "with touchmove", swallowTouchmove: false },
  { name: "as scroll events only (iOS WebKit)", swallowTouchmove: true },
] as const;

test.describe("touch toward the end while the stream grows", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 700 },
  });

  for (const delivery of DELIVERIES) {
    test.describe(delivery.name, () => {
      test.beforeEach(async ({ page }) => {
        await loadFollowingAtEnd(page);
        if (delivery.swallowTouchmove) {
          await page.evaluate(() => {
            document.body.dataset.swallowTouchmove = "true";
          });
        }
      });

      test("a drag toward the end under a growing tail keeps following, and the lift reaches the tail", async ({
        page,
      }) => {
        await holdContact(page, CONTACT, async (move) => {
          await growTailUnderContact(page);
          await move(-100);
          expect(
            await following(page),
            "following is kept while the finger is down",
          ).toBe("true");
        });

        await expectAtTail(page);
        expect(await following(page)).toBe("true");
      });

      test("a drag toward the end after a row above the view re-measured under the contact keeps following, and the lift reaches the tail", async ({
        page,
      }) => {
        await holdContact(page, CONTACT, async (move) => {
          await growTailUnderContact(page);
          for (let i = 0; i < 3; i += 1) {
            expect(
              await page.evaluate(() => window.__growRowAboveView?.()),
              "a rendered row above the view grew",
            ).not.toBeNull();
            await nextFrames(page, 3);
          }
          await move(-100);
          expect(
            await following(page),
            "following is kept while the finger is down",
          ).toBe("true");
        });

        await expectAtTail(page);
        expect(await following(page)).toBe("true");
      });

      test("a drag toward the end that reverses past the contact offset keeps the reading position", async ({
        page,
      }) => {
        const contactTop = (await geometry(page)).scrollTop;
        await holdContact(page, CONTACT, async (move) => {
          await growTailUnderContact(page);
          await move(-120);
          // Back away from the end, still short of where the contact began.
          await move(60);
        });

        const afterLift = await waitForScrollSettle(page);
        expect(afterLift.scrollTop).toBeGreaterThan(contactTop + 20);
        expect(
          afterLift.scrollHeight - afterLift.scrollTop - afterLift.clientHeight,
          "the lift did not correct them to the tail",
        ).toBeGreaterThan(20);
        expect(await following(page)).toBe("false");

        const before = await readingRow(page);
        await streamContent(page);
        const afterStream = await waitForScrollSettle(page);
        expect(await following(page)).toBe("false");
        expect(afterStream.scrollHeight).toBeGreaterThan(
          afterLift.scrollHeight,
        );
        const after = await readingRow(page);
        const kept = `the reader's position is kept: ${JSON.stringify({ before, after })}`;
        expect(after.id, kept).toBe(before.id);
        expect(Math.abs(after.top - before.top), kept).toBeLessThanOrEqual(2);
      });
    });
  }
});

test.describe("wheel (desktop control)", () => {
  test("a wheel scroll away from the end keeps the reading position when new content arrives", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    const start = await loadFollowingAtEnd(page);
    await page.mouse.move(195, 350);
    await wheelsDelivered(page, [{ deltaX: 0, deltaY: -400 }], 0);
    await expectReadingPositionKept(page, start);
  });
});
