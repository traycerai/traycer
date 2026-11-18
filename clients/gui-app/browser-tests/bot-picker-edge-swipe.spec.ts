import { expect, test, type Page } from "@playwright/test";

import { fixture } from "./support/fixtures.ts";

// The Tracy channel picker opens on a swipe from the trailing edge, through the
// shell's one edge recognizer, and stays put under further edge swipes. Touch
// input, the recognizer and the modal barrier an open drawer raises are what
// jsdom cannot stand in for: the barrier is the library's own, set on `body`
// while the drawer is open, and only a real drawer in a real browser shows
// that the recognizer reads it.

declare global {
  interface Window {
    __pickerSwipeOpens?: number;
    __mobileNavOpen?: () => boolean;
    __openedAt?: number;
    __touchDownAt?: number;
  }
}

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  reducedMotion: "no-preference",
});

const PICKER = '[data-testid="bot-channel-picker"]';
const TRIGGER = '[data-testid="bot-channel-picker-trigger"]';

async function swipe(
  page: Page,
  fromX: number,
  toX: number,
  y: number,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: fromX, y }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: toX, y }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await cdp.detach();
}

/**
 * A swipe whose pointer events are dispatched on `body`, not on the open
 * drawer. The drawer declares `touch-action: none`, which the recognizer
 * refuses on its own; a touch on `body` has no such ancestor, so what refuses it
 * is the modal barrier alone.
 */
async function swipeOnBody(
  page: Page,
  fromX: number,
  toX: number,
  y: number,
): Promise<void> {
  await page.evaluate(
    ([x0, x1, y0]) =>
      new Promise<void>((resolve) => {
        const fire = (type: string, x: number): void => {
          document.body.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              pointerId: 1,
              pointerType: "touch",
              isPrimary: true,
              clientX: x,
              clientY: y0,
            }),
          );
        };
        const frame = (next: () => void): void => {
          requestAnimationFrame(() => setTimeout(next, 16));
        };
        fire("pointerdown", x0);
        frame(() => {
          fire("pointermove", x0 + (x1 - x0) / 2);
          frame(() => {
            fire("pointermove", x1);
            frame(() => {
              fire("pointerup", x1);
              resolve();
            });
          });
        });
      }),
    [fromX, toX, y] as const,
  );
}

/** Resolves once the page has painted the frames the swipe's handlers ran in. */
async function afterPaint(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

test("a swipe from the trailing edge opens the picker", async ({ page }) => {
  await page.goto(fixture("bot-picker-edge-swipe"));
  await expect(page.locator(TRIGGER)).toBeVisible();
  await expect(page.locator(PICKER)).toHaveCount(0);

  await swipe(page, 382, 290, 300);

  await expect(page.locator(PICKER)).toBeVisible();
  expect(await page.evaluate(() => window.__pickerSwipeOpens)).toBe(1);
});

/**
 * Opens the picker with its trigger and waits for the barrier. The page records
 * when the open click landed and when each touch went down, so a case can say
 * how long after the open a swipe began.
 */
async function openPicker(page: Page): Promise<void> {
  await page.goto(fixture("bot-picker-edge-swipe"));
  await page.evaluate(() => {
    document.addEventListener(
      "click",
      () => {
        window.__openedAt = performance.now();
      },
      { capture: true, once: true },
    );
    document.addEventListener(
      "pointerdown",
      () => {
        window.__touchDownAt = performance.now();
      },
      { capture: true },
    );
  });
  await page.locator(TRIGGER).click();
  await expect(page.locator(PICKER)).toBeVisible();
  // The barrier the recognizer reads: the library's own, on the document.
  await expect
    .poll(() => page.evaluate(() => document.body.style.pointerEvents))
    .toBe("none");
}

// A and its leading twin dispatch on `body`, not on the open drawer. The drawer
// declares `touch-action: none` (vaul's own CSS), which the recognizer refuses
// on its own, and a touch on the drawer is also handled by vaul's drag. A touch
// on `body` has neither, so what refuses it is the modal barrier alone. Each
// edge is its own case so that either can go red without the other.
test("with the picker open, the modal barrier alone refuses a trailing-edge swipe", async ({
  page,
}) => {
  await openPicker(page);

  await swipeOnBody(page, 382, 290, 300);
  await afterPaint(page);

  await expect(page.locator(PICKER)).toBeVisible();
  expect(await page.evaluate(() => window.__pickerSwipeOpens)).toBe(0);
});

test("with the picker open, the modal barrier alone refuses a leading-edge swipe", async ({
  page,
}) => {
  await openPicker(page);

  await swipeOnBody(page, 8, 100, 300);
  await afterPaint(page);

  await expect(page.locator(PICKER)).toBeVisible();
  expect(await page.evaluate(() => window.__mobileNavOpen?.())).toBe(false);
  expect(await page.evaluate(() => window.__pickerSwipeOpens)).toBe(0);
});

test.describe("a real touch over the open picker", () => {
  // INWARD only. For a right drawer, vaul's release treats a drag whose
  // `pointerStart - pageX` is positive (leftward, here 382 - 290 = +92) as a
  // drag back toward open: it takes the "Moved upwards, don't do anything"
  // branch and calls `resetDrawer()`, never `closeDrawer()`, whatever the
  // distance or speed (vaul 1.1.2, `onRelease`). The margin is the sign of the
  // drag, so no threshold is involved. A rightward drag is the dismiss
  // direction and is not asserted on here.
  test("an inward swipe from the trailing edge leaves it open and reaches neither action", async ({
    page,
  }) => {
    await openPicker(page);

    await swipe(page, 382, 290, 300);
    await afterPaint(page);

    await expect(page.locator(PICKER)).toBeVisible();
    expect(await page.evaluate(() => window.__pickerSwipeOpens)).toBe(0);
    expect(await page.evaluate(() => window.__mobileNavOpen?.())).toBe(false);
  });

  // A rightward drag over a right drawer is vaul's own dismiss gesture and may
  // close the picker, so this case asserts only what the shell must not do:
  // open the task drawer or call the registered picker function. What vaul did
  // is recorded, not asserted.
  test("a rightward swipe from the leading edge opens neither the task drawer nor the picker", async ({
    page,
  }, testInfo) => {
    await openPicker(page);

    await swipe(page, 8, 100, 300);
    const observed = await page.evaluate(() => {
      const content = document.querySelector(
        '[data-testid="bot-channel-picker"]',
      );
      return {
        pickerInDom: content !== null,
        dataState: content?.getAttribute("data-state") ?? null,
        translate:
          content === null ? null : getComputedStyle(content).transform,
        inlineTransform:
          content instanceof HTMLElement ? content.style.transform : null,
        openToTouchDownMs:
          window.__openedAt !== undefined && window.__touchDownAt !== undefined
            ? window.__touchDownAt - window.__openedAt
            : null,
      };
    });
    await testInfo.attach("leading-swipe-observed", {
      body: JSON.stringify(observed, null, 2),
      contentType: "application/json",
    });
    await afterPaint(page);

    expect(await page.evaluate(() => window.__mobileNavOpen?.())).toBe(false);
    expect(await page.evaluate(() => window.__pickerSwipeOpens)).toBe(0);
  });
});
