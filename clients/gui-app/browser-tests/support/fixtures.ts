import type { LaunchOptions, Locator, Page } from "@playwright/test";

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
