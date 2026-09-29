import type { Locator } from "@playwright/test";

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
