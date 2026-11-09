import { expect, test, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// An anchored dialog grows down from a top edge near 15% of the viewport
// and its list scrolls before the box leaves the screen. jsdom has no
// boxes, so the class tokens that used to stand in for this live here.
// The fixture is the real command palette shell, open, at 1280×480.

const VIEWPORT = { width: 1280, height: 480 } as const;
const TOP_TOLERANCE_PX = 2;

interface DialogCap {
  readonly top: number;
  readonly bottom: number;
  readonly innerHeight: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

async function readCap(page: Page): Promise<DialogCap> {
  return page.evaluate(() => {
    const dialog = document.querySelector('[data-slot="dialog-content"]');
    const list = document.querySelector('[data-testid="command-palette-list"]');
    if (!(dialog instanceof HTMLElement) || !(list instanceof HTMLElement)) {
      throw new Error("the open palette dialog or its list is missing");
    }
    const box = dialog.getBoundingClientRect();
    return {
      top: box.top,
      bottom: box.bottom,
      innerHeight: window.innerHeight,
      scrollHeight: list.scrollHeight,
      clientHeight: list.clientHeight,
    };
  });
}

function capHolds(cap: DialogCap): boolean {
  const target = cap.innerHeight * 0.15;
  return (
    Math.abs(cap.top - target) <= TOP_TOLERANCE_PX &&
    cap.bottom <= cap.innerHeight + 1 &&
    cap.scrollHeight > cap.clientHeight
  );
}

test.use({ viewport: VIEWPORT });

test("an open palette anchors near 15% of a short viewport and its list scrolls", async ({
  page,
}) => {
  await page.goto(fixture("anchored-dialog-cap"));
  const dialog = page.locator('[data-slot="dialog-content"]');
  await expect(dialog).toBeVisible();
  await nextFrames(page, 2);

  await expect.poll(async () => capHolds(await readCap(page))).toBe(true);

  const cap = await readCap(page);
  expect(Math.abs(cap.top - cap.innerHeight * 0.15)).toBeLessThanOrEqual(
    TOP_TOLERANCE_PX,
  );
  expect(cap.bottom).toBeLessThanOrEqual(cap.innerHeight + 1);
  expect(cap.scrollHeight).toBeGreaterThan(cap.clientHeight);
});
