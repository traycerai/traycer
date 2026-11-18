import { expect, test, type Page } from "@playwright/test";

import { fixture, chromeLaunchOptions } from "./support/fixtures.ts";

// The toast close button on touch devices, and where the toaster sits in the
// installed mobile app.
//
// jsdom cannot answer either: it evaluates no media queries, so a class scoped
// to `(pointer: coarse)` looks the same on every device, and
// it has no layout, so an offset written as a CSS `calc()` is never resolved.
// This renders the real `Toaster` against the real stylesheet and flips the
// media query with Chrome's touch emulation, which switches both `hover` and
// `pointer` exactly as a phone reports them.

const TOUCH_QUERY = "(pointer: coarse)";
// The desktop tests need a mouse, and headless Chrome otherwise reports
// whatever input devices the host has: a CI runner with none reports
// `hover: none` / `pointer: none`, under which Tailwind's `group-hover:`
// never applies and the hover test can only fail. Pin a fine, hovering
// pointer so the premise belongs to this spec, not to the runner. (Blink's
// hover/pointer enums: hover 2 = hover; pointer 4 = fine.) Touch emulation
// still overrides these while it is on.
const MOUSE_INPUT_ARGS = [
  "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
];
const CLOSE_BUTTON =
  '[data-sonner-toast][data-mounted="true"][data-front="true"] [data-close-button]';
const BACK_TOASTS =
  '[data-sonner-toast][data-mounted="true"][data-front="false"]';
// The header's icon buttons get a 44px hit area on touch
// (`mobile-shell-touch-targets.css`), centred on a 40px row, so it overhangs
// the row's bottom edge by 2px.
const HEADER_HIT_OVERHANG_PX = 2;
// Sonner's 20px close glyph, grown to a 44px hit area on touch.
const TOUCH_HIT_AREA_PX = 44;

test.use({
  launchOptions: chromeLaunchOptions(MOUSE_INPUT_ARGS),
  viewport: { width: 1200, height: 800 },
  deviceScaleFactor: 1,
});

interface CloseButtonReading {
  readonly touchQuery: boolean;
  readonly hoverQuery: boolean;
  readonly position: string;
  readonly opacity: string;
  readonly pointerEvents: string;
  readonly glyphWidth: number;
  readonly hitAreaWidth: number;
  readonly hitAreaHeight: number;
  readonly hitAreaTop: number;
  readonly hitNearCorner: boolean;
  readonly toastCenter: { readonly x: number; readonly y: number };
  readonly toasterTop: number;
  readonly rootFontPx: number;
}

interface CollapsedStackReading {
  readonly count: number;
  readonly collapsed: boolean;
  readonly pointerEvents: readonly string[];
  readonly hitCount: number;
  readonly firstHits: readonly (readonly [number, number])[];
}

/**
 * Loads the fixture and waits for its toast to be on screen and at rest.
 * Sonner's enter transition is the thing waited out, by asking the document
 * whether anything is still animating rather than for a fixed time.
 */
async function openToast(page: Page, search: string): Promise<void> {
  await page.goto(`${fixture("toast-close-button-touch")}${search}`);
  await expect(page.locator(CLOSE_BUTTON)).toHaveCount(1);
  await settleAnimations(page);
}

async function settleAnimations(page: Page): Promise<void> {
  await page.waitForFunction("document.getAnimations().length === 0");
}

function readCloseButton(page: Page): Promise<CloseButtonReading> {
  return page.evaluate(
    (args: { readonly selector: string; readonly touchQuery: string }) => {
      const button = document.querySelector(args.selector);
      if (!(button instanceof HTMLElement)) {
        throw new Error("the toast close button is missing");
      }
      const toast = button.closest("[data-sonner-toast]");
      const toaster = button.closest("[data-sonner-toaster]");
      if (
        !(toast instanceof HTMLElement) ||
        !(toaster instanceof HTMLElement)
      ) {
        throw new Error("the close button has no toast or toaster around it");
      }
      const style = getComputedStyle(button);
      const after = getComputedStyle(button, "::after");
      const glyph = button.getBoundingClientRect();
      const toastRect = toast.getBoundingClientRect();
      const hitAreaHeight = parseFloat(after.height) || 0;
      const centerX = glyph.left + glyph.width / 2;
      const centerY = glyph.top + glyph.height / 2;
      // Inside a 44px square around the glyph, outside the 20px glyph.
      const probe = document.elementFromPoint(centerX + 18, centerY + 18);
      return {
        touchQuery: matchMedia(args.touchQuery).matches,
        hoverQuery: matchMedia("(hover: hover)").matches,
        position: `${toaster.dataset.yPosition ?? ""}-${toaster.dataset.xPosition ?? ""}`,
        opacity: style.opacity,
        pointerEvents: style.pointerEvents,
        glyphWidth: glyph.width,
        hitAreaWidth: parseFloat(after.width) || 0,
        hitAreaHeight,
        hitAreaTop: centerY - hitAreaHeight / 2,
        hitNearCorner:
          probe !== null && probe.closest("[data-close-button]") === button,
        toastCenter: {
          x: toastRect.left + toastRect.width / 2,
          y: toastRect.top + toastRect.height / 2,
        },
        toasterTop: toaster.getBoundingClientRect().top,
        rootFontPx: parseFloat(
          getComputedStyle(document.documentElement).fontSize,
        ),
      };
    },
    { selector: CLOSE_BUTTON, touchQuery: TOUCH_QUERY },
  );
}

/**
 * Stacks two newer toasts in front of the first and reads whether the back
 * toasts' close buttons - invisible, because sonner hides a collapsed stack's
 * back toasts with `opacity: 0` alone - take taps anywhere, including the
 * strip where they peek out past the front toast.
 */
async function readCollapsedStack(page: Page): Promise<CollapsedStackReading> {
  await page.evaluate("window.__probeStackToasts()");
  await expect(page.locator(BACK_TOASTS)).toHaveCount(2);
  await settleAnimations(page);
  return page.evaluate(() => {
    const back = Array.from(
      document.querySelectorAll(
        '[data-sonner-toast][data-front="false"] [data-close-button]',
      ),
    );
    const hits: [number, number][] = [];
    for (const button of back) {
      const rect = button.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      for (let dx = -24; dx <= 24; dx += 3) {
        for (let dy = -24; dy <= 24; dy += 3) {
          const hit = document
            .elementFromPoint(centerX + dx, centerY + dy)
            ?.closest("[data-close-button]");
          if (hit !== undefined && hit !== null && back.includes(hit)) {
            hits.push([Math.round(centerX + dx), Math.round(centerY + dy)]);
          }
        }
      }
    }
    return {
      count: back.length,
      collapsed: back.every(
        (button) =>
          button
            .closest("[data-sonner-toast]")
            ?.getAttribute("data-expanded") === "false",
      ),
      pointerEvents: back.map(
        (button) => getComputedStyle(button).pointerEvents,
      ),
      hitCount: hits.length,
      firstHits: hits.slice(0, 5),
    };
  });
}

function expectCollapsedStackInert(
  stack: CollapsedStackReading,
  label: string,
): void {
  expect(stack.count, `two back toasts at ${label}`).toBe(2);
  expect(stack.collapsed, `the stack must be collapsed at ${label}`).toBe(true);
  expect(
    stack.pointerEvents,
    `back toasts' close buttons must take no taps at ${label}`,
  ).toEqual(["none", "none"]);
  expect(
    stack.hitCount,
    `a tap must never land on a hidden back toast's close button at ${label} (hits at ${JSON.stringify(stack.firstHits)})`,
  ).toBe(0);
}

// --- Desktop: hidden until hover, exactly as before. ---

test("desktop: the close button is hidden until hover and takes no clicks", async ({
  page,
}) => {
  await openToast(page, "");
  await page.mouse.move(5, 5);
  await expect(
    page.locator(CLOSE_BUTTON),
    "desktop close button must be hidden until hover",
  ).toHaveCSS("opacity", "0");

  const desktop = await readCloseButton(page);
  expect(
    desktop.hoverQuery,
    "desktop arm premise: Chrome must report a hovering pointer",
  ).toBe(true);
  expect(desktop.touchQuery, "desktop arm must not match the touch query").toBe(
    false,
  );
  expect(desktop.position, "desktop toaster must keep its default anchor").toBe(
    "bottom-right",
  );
  expect(
    desktop.opacity,
    "desktop close button must be hidden until hover",
  ).toBe("0");
  expect(
    desktop.pointerEvents,
    "a hidden desktop close button must not take clicks",
  ).toBe("none");
  expect(
    desktop.hitNearCorner,
    "desktop close button must not grow a touch hit area",
  ).toBe(false);
});

test("desktop: hovering the toast reveals a close button that takes clicks and carries no touch hit area", async ({
  page,
}) => {
  await openToast(page, "");
  await page.mouse.move(5, 5);
  const desktop = await readCloseButton(page);
  expect(
    desktop.hoverQuery,
    "desktop arm premise: Chrome must report a hovering pointer",
  ).toBe(true);

  await page.mouse.move(desktop.toastCenter.x, desktop.toastCenter.y);
  await expect(
    page.locator(CLOSE_BUTTON),
    "hovering the toast must reveal the close button",
  ).toHaveCSS("opacity", "1");
  await expect(
    page.locator(CLOSE_BUTTON),
    "a revealed close button must take clicks",
  ).toHaveCSS("pointer-events", "auto");
  const hovered = await readCloseButton(page);
  expect(
    hovered.opacity,
    "hovering the toast must reveal the close button",
  ).toBe("1");
  expect(
    hovered.pointerEvents,
    "a revealed close button must take clicks",
  ).toBe("auto");
  // The resting desktop reading cannot tell: pointer-events none hides any
  // hit area from the probe. Revealed, a leaked touch hit area would show.
  expect(
    hovered.hitNearCorner,
    "a revealed desktop close button must not carry the touch hit area",
  ).toBe(false);
});

// --- Touch: sonner's own always-visible default stands. ---

test.describe("touch at 1200x800", () => {
  test.use({ hasTouch: true });

  test("the close button is visible and tappable without hover", async ({
    page,
  }) => {
    await openToast(page, "");
    const touch = await readCloseButton(page);
    expect(touch.touchQuery, `touch emulation must match ${TOUCH_QUERY}`).toBe(
      true,
    );
    expect(
      touch.opacity,
      "the close button must be visible without hover on touch",
    ).toBe("1");
    expect(
      touch.pointerEvents,
      "the close button must be tappable on touch",
    ).toBe("auto");
  });

  test("the close button grows a 44px hit area and a tap just outside the glyph lands on it", async ({
    page,
  }) => {
    await openToast(page, "");
    const touch = await readCloseButton(page);
    expect(touch.touchQuery, `touch emulation must match ${TOUCH_QUERY}`).toBe(
      true,
    );
    expect(touch.hitAreaWidth, "touch hit area width").toBe(TOUCH_HIT_AREA_PX);
    expect(touch.hitAreaHeight, "touch hit area height").toBe(
      TOUCH_HIT_AREA_PX,
    );
    expect(
      touch.hitNearCorner,
      "a tap just outside the glyph must land on the close button",
    ).toBe(true);
  });

  test("a collapsed stack's back toasts take no taps", async ({ page }) => {
    await openToast(page, "");
    expect(
      (await readCloseButton(page)).touchQuery,
      `touch emulation must match ${TOUCH_QUERY}`,
    ).toBe(true);
    expectCollapsedStackInert(await readCollapsedStack(page), "1200x800 touch");
  });
});

test("flipping touch emulation live keeps the glyph's size and, turned off again, restores the hover-only close button", async ({
  page,
}) => {
  await openToast(page, "");
  await page.mouse.move(5, 5);
  const desktop = await readCloseButton(page);
  expect(desktop.touchQuery, "desktop arm must not match the touch query").toBe(
    false,
  );

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 5,
  });
  await expect
    .poll(async () => (await readCloseButton(page)).touchQuery, {
      message: `touch emulation must match ${TOUCH_QUERY}`,
    })
    .toBe(true);
  await settleAnimations(page);
  const touch = await readCloseButton(page);
  expect(
    touch.glyphWidth,
    "the touch hit area must not change the glyph's size",
  ).toBe(desktop.glyphWidth);

  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await expect(
    page.locator(CLOSE_BUTTON),
    "leaving touch must restore the hover-only close button",
  ).toHaveCSS("opacity", "0");
  const desktopAgain = await readCloseButton(page);
  expect(
    desktopAgain.opacity,
    "leaving touch must restore the hover-only close button",
  ).toBe("0");
});

// --- Installed mobile app: top-center, below the header. ---

const MOBILE_VIEWPORTS = [
  // Portrait reads sonner's `mobileOffset` (<=600px) ...
  { width: 390, height: 844 },
  // ... and landscape its `offset`, so both must carry the header offset.
  { width: 844, height: 390 },
] as const;

for (const viewport of MOBILE_VIEWPORTS) {
  const label = `${String(viewport.width)}x${String(viewport.height)}`;

  test.describe(`installed mobile app at ${label}`, () => {
    test.use({ viewport, isMobile: true, hasTouch: true });

    test("the toaster sits top-center below the header, its close button visible and clear of it", async ({
      page,
    }) => {
      await openToast(page, "?mobile-app=1");
      const mobile = await readCloseButton(page);
      expect(
        mobile.touchQuery,
        `touch emulation must match ${TOUCH_QUERY} at ${label}`,
      ).toBe(true);
      expect(mobile.position, `mobile app toaster anchor at ${label}`).toBe(
        "top-center",
      );
      // No device insets headless, so the header's bottom edge is its 2.5rem
      // height and the toaster's top is that plus the 1.5rem gap.
      expect(mobile.toasterTop, `mobile app toaster top at ${label}`).toBe(
        mobile.rootFontPx * 4,
      );
      expect(
        mobile.hitAreaTop >= mobile.rootFontPx * 2.5 + HEADER_HIT_OVERHANG_PX,
        `the close button's hit area must stay clear of the header at ${label} (hit area top ${String(mobile.hitAreaTop)})`,
      ).toBe(true);
      expect(
        mobile.opacity,
        `mobile app close button visible at ${label}`,
      ).toBe("1");
    });

    test("a collapsed stack's back toasts take no taps", async ({ page }) => {
      await openToast(page, "?mobile-app=1");
      expectCollapsedStackInert(await readCollapsedStack(page), label);
    });
  });
}
