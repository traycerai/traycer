import { expect, test, type Page } from "@playwright/test";

import { chromeLaunchOptions, fixture } from "./support/fixtures.ts";

// Where a toast's buttons sit when it has two (`components/ui/sonner.css`):
// under a full-width text row, at the end, instead of squeezing the text into
// a narrow column beside them. jsdom has no layout, so this measures the real
// `Toaster` against the real stylesheet.
//
// A fine, hovering pointer is pinned so the stylesheet's `(pointer: coarse)`
// padding never applies on a runner that reports other input devices.
const MOUSE_INPUT_ARGS = [
  "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
];

test.use({
  launchOptions: chromeLaunchOptions(MOUSE_INPUT_ARGS),
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
});

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly right: number;
  readonly bottom: number;
}

interface ToastLayout {
  readonly toast: Box;
  readonly content: Box;
  readonly contentBoxRight: number;
  readonly contentBoxWidth: number;
  readonly cancel: Box | null;
  readonly action: Box;
}

async function openToast(page: Page, buttons: 1 | 2): Promise<void> {
  await page.goto(`${fixture("toast-two-actions")}?buttons=${String(buttons)}`);
  await expect(
    page.locator('[data-sonner-toast][data-mounted="true"]'),
  ).toHaveCount(1);
  await page.waitForFunction("document.getAnimations().length === 0");
}

async function readToastLayout(page: Page): Promise<ToastLayout> {
  return page.evaluate(() => {
    const toast = document.querySelector<HTMLElement>("[data-sonner-toast]");
    if (toast === null) throw new Error("no toast on the page");
    const content = toast.querySelector<HTMLElement>("[data-content]");
    const cancel = toast.querySelector<HTMLElement>("[data-cancel]");
    const action = toast.querySelector<HTMLElement>("[data-action]");
    if (content === null || action === null) {
      throw new Error("toast is missing its content or action");
    }
    const toastRect = toast.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const actionRect = action.getBoundingClientRect();
    const style = getComputedStyle(toast);
    const paddingLeft = Number.parseFloat(style.paddingLeft);
    const paddingRight = Number.parseFloat(style.paddingRight);
    const borderLeft = Number.parseFloat(style.borderLeftWidth);
    const borderRight = Number.parseFloat(style.borderRightWidth);
    const box = (rect: DOMRect): Box => ({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      right: rect.right,
      bottom: rect.bottom,
    });
    return {
      toast: box(toastRect),
      content: box(contentRect),
      contentBoxRight: toastRect.right - paddingRight - borderRight,
      contentBoxWidth:
        toastRect.width - paddingLeft - paddingRight - borderLeft - borderRight,
      cancel: cancel === null ? null : box(cancel.getBoundingClientRect()),
      action: box(actionRect),
    };
  });
}

function expectWithinOnePixel(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);
}

async function expectTwoButtonLayout(page: Page): Promise<void> {
  const layout = await readToastLayout(page);
  if (layout.cancel === null) throw new Error("cancel button is missing");
  expectWithinOnePixel(layout.content.width, layout.contentBoxWidth);
  expect(layout.cancel.y).toBeGreaterThanOrEqual(layout.content.bottom);
  expect(layout.action.y).toBeGreaterThanOrEqual(layout.content.bottom);
  expectWithinOnePixel(layout.cancel.y, layout.action.y);
  expect(layout.cancel.x).toBeLessThan(layout.action.x);
  const buttonGap = layout.action.x - layout.cancel.right;
  expect(buttonGap).toBeGreaterThanOrEqual(0);
  expect(buttonGap).toBeLessThan(10);
  expectWithinOnePixel(layout.action.right, layout.contentBoxRight);
}

test("two buttons occupy a full-width text row at 1280px", async ({ page }) => {
  await openToast(page, 2);
  await expectTwoButtonLayout(page);
});

test("two buttons occupy a full-width text row in Sonner's narrow layout", async ({
  page,
}) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await openToast(page, 2);
  await expectTwoButtonLayout(page);
});

test("one action keeps Sonner's single row at 1280px", async ({ page }) => {
  await openToast(page, 1);
  const layout = await readToastLayout(page);
  expect(layout.cancel).toBeNull();
  expect(layout.action.y).toBeLessThan(layout.content.bottom);
});
