import { expect, test, type Page } from "@playwright/test";

import { centreOf, chromeLaunchOptions, fixture } from "./support/fixtures.ts";

// The Drafts dialog's "Deleted" toast over a dismissable Radix modal Dialog.
//
// Radix sets `pointer-events: none` on `body` while a modal is open and the
// dialog overlay re-enables it, so a toast the toaster does not re-enable
// takes no click: the click lands on the overlay, counts as outside the
// dialog and closes it. jsdom never consults `pointer-events`, so this is
// real input by coordinates against the real stylesheet.

// Pin a fine, hovering pointer (see toast-close-button-touch.spec.ts) so the
// hover-revealed close button behaves the same on every runner.
const MOUSE_INPUT_ARGS = [
  "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
];
const STATE = "#probe-state";
const DIALOG = "[role=dialog]";
const TOAST = "[data-sonner-toast][data-mounted=true]";
const FRONT_TOAST = `${TOAST}[data-front=true]`;
const UNDO = `${FRONT_TOAST} [data-button]`;
const CLOSE = `${FRONT_TOAST} [data-close-button]`;

test.use({
  launchOptions: chromeLaunchOptions(MOUSE_INPUT_ARGS),
  viewport: { width: 1200, height: 800 },
  deviceScaleFactor: 1,
});

async function openDialog(page: Page): Promise<void> {
  await page.goto(fixture("toast-undo-over-modal"));
  await expect(page.locator(DIALOG)).toHaveCount(1);
  await expect(page.locator("[data-probe-input]")).toBeFocused();
}

async function raiseDeleted(page: Page): Promise<void> {
  await page.evaluate("window.__probeRaiseDeleted()");
  await expect(page.locator(UNDO)).toHaveCount(1);
  await page.waitForFunction("document.getAnimations().length === 0");
}

test("one click on Undo runs it once and leaves the dialog open", async ({
  page,
}) => {
  await openDialog(page);
  await raiseDeleted(page);

  const { x, y } = await centreOf(page.locator(UNDO));
  await page.mouse.click(x, y);

  await expect(
    page.locator(STATE),
    "the first click on Undo must run it",
  ).toHaveAttribute("data-undo-clicks", "1");
  await expect(
    page.locator(STATE),
    "clicking Undo must not dismiss the dialog",
  ).toHaveAttribute("data-dialog-open", "true");
  await expect(page.locator(DIALOG)).toHaveCount(1);
});

test("clicking the toast's close button leaves the dialog open", async ({
  page,
}) => {
  await openDialog(page);
  await raiseDeleted(page);
  // The premise the launch flags create: a fine, hovering pointer, where the
  // close button is hidden until hover. On a coarse one it is always visible
  // and the opacity check below would prove nothing.
  expect(
    await page.evaluate(
      () => matchMedia("(hover: hover) and (pointer: fine)").matches,
    ),
    "the pointer must be fine and hovering",
  ).toBe(true);

  const toastCentre = await centreOf(page.locator(FRONT_TOAST));
  await page.mouse.move(toastCentre.x, toastCentre.y);
  await expect(page.locator(CLOSE)).toHaveCSS("opacity", "1");
  const { x, y } = await centreOf(page.locator(CLOSE));
  await page.mouse.click(x, y);

  await expect(
    page.locator(TOAST),
    "the close button must dismiss the toast",
  ).toHaveCount(0);
  await expect(
    page.locator(STATE),
    "closing the toast must not dismiss the dialog",
  ).toHaveAttribute("data-dialog-open", "true");
});

test("focus stays inside the dialog after clicking Undo", async ({ page }) => {
  await openDialog(page);
  await raiseDeleted(page);

  const { x, y } = await centreOf(page.locator(UNDO));
  await page.mouse.click(x, y);
  await expect(page.locator(STATE)).toHaveAttribute("data-undo-clicks", "1");

  await expect
    .poll(
      () =>
        page.evaluate(
          (selector: string) =>
            document
              .querySelector(selector)
              ?.contains(document.activeElement) ?? false,
          DIALOG,
        ),
      { message: "focus must remain within the dialog" },
    )
    .toBe(true);
});

test("hidden toasts take no click", async ({ page }) => {
  await openDialog(page);
  // Five toasts: sonner shows three, and a collapsed stack hides the back ones
  // with `opacity: 0` alone.
  await page.evaluate("window.__probeRaiseStack(5)");
  await expect(page.locator(TOAST)).toHaveCount(5);
  await page.waitForFunction("document.getAnimations().length === 0");
  const hidden = page.locator(
    `${TOAST}[data-visible=false], ${TOAST}[data-front=false] [data-close-button]`,
  );
  expect(await hidden.count()).toBeGreaterThan(0);

  const hits = await page.evaluate(() => {
    const landed: string[] = [];
    const targets = [
      ...document.querySelectorAll(
        "[data-sonner-toast][data-visible=false], [data-sonner-toast][data-front=false] [data-close-button]",
      ),
    ];
    for (const target of targets) {
      const rect = target.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      const isHiddenToast =
        hit !== null &&
        (hit.closest("[data-sonner-toast][data-visible=false]") !== null ||
          hit.closest("[data-front=false] [data-close-button]") !== null);
      if (isHiddenToast) landed.push(hit.tagName);
    }
    return landed;
  });
  expect(hits, "a hit test must never land on a hidden toast").toEqual([]);

  const back = page.locator(`${TOAST}[data-front=false] [data-close-button]`);
  const { x, y } = await centreOf(back.first());
  // Recorded at the window after the click's own handlers have run: React
  // flushes a click's updates before the event bubbles past its root, so a
  // dismissal would already read `data-removed="true"` here.
  await page.evaluate(() => {
    const probe = window as Window & {
      __probeClicks?: Array<{ x: number; y: number }>;
    };
    probe.__probeClicks = [];
    window.addEventListener("click", (event) => {
      probe.__probeClicks?.push({ x: event.clientX, y: event.clientY });
    });
  });
  await page.mouse.click(x, y);
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as Window & { __probeClicks?: unknown[] }).__probeClicks,
        ),
      { message: "the click must be dispatched at the back close button" },
    )
    .toEqual([{ x, y }]);
  // Sonner keeps a dismissed toast's node for its exit animation, marked
  // `data-removed="true"`: a count alone cannot see a dismissal.
  await expect(
    page.locator(`${TOAST}[data-removed="false"]`),
    "a click on a hidden toast's close button must dismiss nothing",
  ).toHaveCount(5);
});
