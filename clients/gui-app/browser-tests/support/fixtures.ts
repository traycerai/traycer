import type { LaunchOptions, Locator, Page } from "@playwright/test";

declare global {
  interface Window {
    /** Wheel events the page has received, counted by `wheelsDelivered`. */
    __wheelsSeen?: number;
  }
}

/**
 * The URL path of a fixture page in `src/__tests__/browser/`, relative to the
 * shared Vite server `playwright.config.ts` starts (its `baseURL`).
 */
export function fixture(name: string): string {
  return `/src/__tests__/browser/${name}.html`;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * The centre of an element's box, rounded to whole CSS pixels, for a click
 * that must land by COORDINATES: `page.mouse.click(x, y)` dispatches real
 * input wherever the point is, where a locator click first waits for the
 * element itself to be the hit target.
 */
export async function centreOf(locator: Locator): Promise<Point> {
  const box = await locator.boundingBox();
  if (box === null) {
    throw new Error(`no layout box for ${locator.toString()}`);
  }
  return {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2),
  };
}

/**
 * Resolves once web fonts have loaded and `count` animation frames have been
 * presented, counted page-side. It is the wait for "the browser has laid out
 * and painted what I just changed", and the synchronisation for a NEGATIVE
 * claim ("nothing fades", "no vertical range") where there is no positive
 * event to wait for: font loading and the first ResizeObserver delivery both
 * move layout, and a reading taken before them proves nothing. Counted in
 * frames and not milliseconds, so a loaded runner takes longer in wall-clock
 * time but never reads early.
 */
export async function nextFrames(page: Page, count: number): Promise<void> {
  await page.evaluate(async (frames: number) => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      let remaining = frames;
      const tick = (): void => {
        remaining -= 1;
        if (remaining <= 0) {
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }, count);
}

/** Far beyond a delivered wheel's latency on a loaded runner: a wheel that
 *  has not arrived by then never will, and the test says why instead of
 *  waiting out its own timeout. */
const WHEEL_DELIVERY_TIMEOUT_MS = 10_000;

export interface WheelDelta {
  readonly deltaX: number;
  readonly deltaY: number;
}

/**
 * Sends `deltas` as wheel input at the mouse's position, `gapFrames` frames
 * apart (0: back to back), and resolves once the page has received every one
 * of them, in an animation frame after the last - when the main thread holds
 * the scroll offset they produced. `page.mouse.wheel` resolves as soon as the
 * input is queued, and on a loaded runner a page task sent next (a read, a
 * hide, a click) can run before the wheel lands: a test that reads a position
 * after wheeling, or acts on the view the wheel left, sends the wheel through
 * here. The gaps count from each send, as a burst of bare `page.mouse.wheel`
 * calls would, so a burst keeps its cadence and waits once, at its end.
 */
export async function wheelsDelivered(
  page: Page,
  deltas: readonly WheelDelta[],
  gapFrames: number,
): Promise<void> {
  const before = await page.evaluate(() => {
    if (window.__wheelsSeen === undefined) {
      window.__wheelsSeen = 0;
      window.addEventListener(
        "wheel",
        () => {
          window.__wheelsSeen = (window.__wheelsSeen ?? 0) + 1;
        },
        { capture: true, passive: true },
      );
    }
    return window.__wheelsSeen;
  });
  for (const [index, { deltaX, deltaY }] of deltas.entries()) {
    if (index > 0 && gapFrames > 0) await nextFrames(page, gapFrames);
    await page.mouse.wheel(deltaX, deltaY);
  }
  const expected = before + deltas.length;
  try {
    await page.waitForFunction(
      (count) => (window.__wheelsSeen ?? 0) >= count,
      expected,
      { polling: "raf", timeout: WHEEL_DELIVERY_TIMEOUT_MS },
    );
  } catch (error) {
    const seen = await page.evaluate(() => window.__wheelsSeen ?? 0);
    throw new Error(
      `wheelsDelivered: the page received ${String(seen - before)} of ${String(deltas.length)} wheel events in ${String(WHEEL_DELIVERY_TIMEOUT_MS)}ms. ` +
        "A wheel at a point outside the viewport reaches no page: move the mouse onto the visible part of the element first.",
      { cause: error },
    );
  }
}

/**
 * Chrome launch options carrying extra command-line flags, for a
 * `test.use({ launchOptions })`. That REPLACES the config's `launchOptions`
 * (Playwright merges options one level deep), so a run under `CHROME_BIN`
 * would lose its `executablePath`; this carries it across. `channel` is a
 * separate option and is kept from the config untouched.
 */
export function chromeLaunchOptions(args: readonly string[]): LaunchOptions {
  const chromeBin = process.env.CHROME_BIN;
  return chromeBin === undefined
    ? { args: [...args] }
    : { args: [...args], executablePath: chromeBin };
}
