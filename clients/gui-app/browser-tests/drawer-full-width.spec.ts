import { expect, test, type Page } from "@playwright/test";

import { fixture } from "./support/fixtures.ts";

// What `fullWidth` does to a side drawer, and that it does nothing else: the
// width is painted geometry, which jsdom does not compute. The drawer is the
// real primitive over a bare page, open from the start.

interface Insets {
  readonly top: number;
  readonly left: number;
  readonly right: number;
}

interface Box {
  readonly left: number;
  readonly right: number;
  readonly width: number;
}

const DRAWER = '[data-testid="drawer"]';
const NO_INSETS: Insets = { top: 0, left: 0, right: 0 };

async function settledBox(page: Page): Promise<Box> {
  const read = async (): Promise<Box> =>
    page.locator(DRAWER).evaluate((node) => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width };
    });
  let previous = await read();
  let stableFrames = 0;
  for (let attempt = 0; attempt < 200 && stableFrames < 10; attempt += 1) {
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const next = await read();
    stableFrames =
      next.left === previous.left && next.width === previous.width
        ? stableFrames + 1
        : 0;
    previous = next;
  }
  expect(stableFrames).toBeGreaterThanOrEqual(10);
  return previous;
}

async function open(
  page: Page,
  options: {
    readonly width: number;
    readonly direction: "left" | "right" | "bottom";
    readonly fullWidth: boolean;
    readonly insets: Insets;
  },
): Promise<Box> {
  await page.setViewportSize({ width: options.width, height: 800 });
  await page.goto(
    `${fixture("drawer-full-width")}?direction=${options.direction}${
      options.fullWidth ? "&fullWidth=1" : ""
    }`,
  );
  await page.evaluate((value: Insets) => {
    const style = document.documentElement.style;
    style.setProperty("--safe-area-inset-top", `${String(value.top)}px`);
    style.setProperty("--safe-area-inset-left", `${String(value.left)}px`);
    style.setProperty("--safe-area-inset-right", `${String(value.right)}px`);
  }, options.insets);
  await expect(page.locator(DRAWER)).toBeVisible();
  return settledBox(page);
}

for (const side of ["right", "left"] as const) {
  for (const width of [390, 700, 1024]) {
    test(`a ${side} drawer with fullWidth spans what the insets leave at ${String(width)}px`, async ({
      page,
    }) => {
      const insets = { top: 24, left: 20, right: 59 };
      const box = await open(page, {
        width,
        direction: side,
        fullWidth: true,
        insets,
      });
      expect(box.left).toBeCloseTo(insets.left, 0);
      expect(box.right).toBeCloseTo(width - insets.right, 0);
      expect(box.width).toBeCloseTo(width - insets.left - insets.right, 0);
    });
  }
}

for (const side of ["right", "left"] as const) {
  test(`a ${side} drawer without fullWidth keeps three quarters, capped at 24rem`, async ({
    page,
  }) => {
    const narrow = await open(page, {
      width: 390,
      direction: side,
      fullWidth: false,
      insets: NO_INSETS,
    });
    expect(narrow.width).toBeCloseTo(390 * 0.75, 0);
    const wide = await open(page, {
      width: 1024,
      direction: side,
      fullWidth: false,
      insets: NO_INSETS,
    });
    expect(wide.width).toBeCloseTo(384, 0);
  });
}

for (const fullWidth of [false, true]) {
  test(`a bottom drawer is the same with fullWidth ${String(fullWidth)}: across what the insets leave`, async ({
    page,
  }) => {
    const insets = { top: 24, left: 20, right: 59 };
    const box = await open(page, {
      width: 700,
      direction: "bottom",
      fullWidth,
      insets,
    });
    expect(box.left).toBeCloseTo(insets.left, 0);
    expect(box.width).toBeCloseTo(700 - insets.left - insets.right, 0);
  });
}
