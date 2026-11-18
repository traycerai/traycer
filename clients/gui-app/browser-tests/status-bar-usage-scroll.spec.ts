import { expect, test, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// The status bar's usage cluster: it scrolls when it holds more readings than
// the strip is wide, fades only the edge that hides something, and never
// pushes the resource readout off the strip.
//
// jsdom cannot answer any of that. It lays nothing out, so `scrollWidth` and
// `clientWidth` are both 0 and "does this overflow" has no answer; and the
// fade is a mask utility whose class name a jsdom test can read but whose
// effect it cannot see - a class with no rule behind it passes every string
// assertion. This renders the strip's row with the production scroller,
// trigger, readings and resource segment against the real stylesheet, at a
// real width, and reads the layout back.

const SCROLLER = '[data-testid="status-bar-rate-limit-scroller"]';
const RESOURCES =
  '[data-testid="app-status-bar"] [data-testid="status-bar-resource-segment"]';
// A narrow window: six accounts cannot fit, and the readout on the right
// must still be whole.
const NARROW_WIDTH_PX = 480;
// A wide window: two accounts fit with room to spare, so nothing may fade.
const WIDE_WIDTH_PX = 1400;
const VIEWPORT_HEIGHT_PX = 300;

interface Layout {
  readonly scroller: {
    readonly scrollWidth: number;
    readonly clientWidth: number;
    readonly scrollLeft: number;
    readonly right: number;
    readonly className: string;
    readonly maskImage: string;
  };
  readonly fade: { readonly left: boolean; readonly right: boolean };
  readonly resources: {
    readonly left: number;
    readonly right: number;
    readonly width: number;
    readonly scrollWidth: number;
    readonly clientWidth: number;
  };
  readonly segmentCount: number;
  readonly foldedChip: boolean;
}

/** Loads the strip with `accounts` account segments and waits for it to mount. */
async function openStrip(page: Page, accounts: number): Promise<void> {
  await page.goto(
    `${fixture("status-bar-usage-scroll")}?accounts=${String(accounts)}`,
  );
  await expect(page.locator(SCROLLER)).toBeVisible();
  await expect(page.locator(RESOURCES)).toBeVisible();
}

function readLayout(page: Page): Promise<Layout> {
  return page.evaluate(
    (selectors: { readonly scroller: string; readonly resources: string }) => {
      const s = document.querySelector(selectors.scroller);
      const r = document.querySelector(selectors.resources);
      if (!(s instanceof HTMLElement) || !(r instanceof HTMLElement)) {
        throw new Error("the status bar strip is missing");
      }
      const sRect = s.getBoundingClientRect();
      const rRect = r.getBoundingClientRect();
      const className = s.className;
      return {
        scroller: {
          scrollWidth: s.scrollWidth,
          clientWidth: s.clientWidth,
          scrollLeft: s.scrollLeft,
          right: sRect.right,
          className,
          maskImage: getComputedStyle(s).maskImage,
        },
        fade: {
          left: className.includes("to_right,transparent,black_1.5rem"),
          right: className.includes("black_calc(100%-1.5rem),transparent"),
        },
        resources: {
          left: rRect.left,
          right: rRect.right,
          width: rRect.width,
          scrollWidth: r.scrollWidth,
          clientWidth: r.clientWidth,
        },
        segmentCount: s.querySelectorAll(
          '[data-testid^="status-bar-provider-segment-"]',
        ).length,
        foldedChip:
          s.querySelector('[data-testid="status-bar-folded-providers"]') !==
          null,
      };
    },
    { scroller: SCROLLER, resources: RESOURCES },
  );
}

/** Scroll the scroller to the end or the middle. */
async function scrollTo(page: Page, where: "end" | "middle"): Promise<void> {
  await page.evaluate(
    (args: { readonly selector: string; readonly where: string }) => {
      const s = document.querySelector(args.selector);
      if (!(s instanceof HTMLElement)) throw new Error("no scroller");
      const max = s.scrollWidth - s.clientWidth;
      s.scrollLeft = args.where === "end" ? max : Math.round(max / 2);
    },
    { selector: SCROLLER, where },
  );
}

/**
 * The resource segment has to be entirely inside the viewport and entirely
 * unclipped: the usage cluster is the box that gives way, never this one.
 */
function expectResourcesWhole(layout: Layout, viewportWidth: number): void {
  expect(
    layout.resources.left >= 0 && layout.resources.right <= viewportWidth,
    `the resource segment must sit inside the ${String(viewportWidth)}px strip (left ${String(layout.resources.left)}, right ${String(layout.resources.right)})`,
  ).toBe(true);
  expect(
    layout.resources.scrollWidth <= layout.resources.clientWidth,
    `the resource segment must not clip its own readings (scrollWidth ${String(layout.resources.scrollWidth)}, clientWidth ${String(layout.resources.clientWidth)})`,
  ).toBe(true);
  expect(
    layout.resources.left >= layout.scroller.right,
    `the resource segment must sit to the right of the scroller, not under it (scroller right ${String(layout.scroller.right)}, resources left ${String(layout.resources.left)})`,
  ).toBe(true);
}

// ── six accounts at 480px: overflow, right fade, resources whole ──────────

test.describe("six accounts at 480px", () => {
  test.use({
    viewport: { width: NARROW_WIDTH_PX, height: VIEWPORT_HEIGHT_PX },
  });

  test("overflow the scroller, start at the first account and are all drawn", async ({
    page,
  }) => {
    await openStrip(page, 6);
    // Polled, because the overflow needs fonts and layout settled; the
    // received value names both widths, as the driver's message did.
    await expect
      .poll(
        async () => {
          const { scroller } = await readLayout(page);
          return {
            overflows: scroller.scrollWidth > scroller.clientWidth,
            scrollWidth: scroller.scrollWidth,
            clientWidth: scroller.clientWidth,
          };
        },
        {
          message: `six accounts at ${String(NARROW_WIDTH_PX)}px must overflow the scroller`,
        },
      )
      .toMatchObject({ overflows: true });
    const start = await readLayout(page);
    expect(
      start.scroller.scrollLeft,
      "the scroller must start at the first account",
    ).toBe(0);
    // Every account is in the DOM, none folded away.
    expect(start.segmentCount, "all six segments must be drawn").toBe(6);
    expect(start.foldedChip, "nothing may be folded into a chip").toBe(false);
  });

  test("at the start only the right edge fades, through a real mask", async ({
    page,
  }) => {
    await openStrip(page, 6);
    await expect
      .poll(async () => (await readLayout(page)).fade, {
        message:
          "at the start only the right edge hides something (the fade is decided by ResizeObserver, so it lands after the first measurement)",
      })
      .toEqual({ left: false, right: true });
    const start = await readLayout(page);
    expect(
      start.scroller.maskImage,
      "the fade class must resolve to a real mask, not a name with no rule behind it",
    ).not.toBe("none");
  });

  test("the resource readout stays whole, right of the scroller", async ({
    page,
  }) => {
    await openStrip(page, 6);
    // Pure geometry: fonts loaded and a few frames of layout are all it needs.
    await nextFrames(page, 3);
    expectResourcesWhole(await readLayout(page), NARROW_WIDTH_PX);
  });

  test("scrolled to the end, only the left edge fades and the readout is still whole", async ({
    page,
  }) => {
    await openStrip(page, 6);
    // Fonts loaded and layout settled, so the scroll range is the final one.
    await nextFrames(page, 3);
    await scrollTo(page, "end");
    await expect
      .poll(async () => (await readLayout(page)).fade, {
        message:
          "at the end only the left edge hides something (a scroll event must re-decide the fade)",
      })
      .toEqual({ left: true, right: false });
    const end = await readLayout(page);
    expect(
      end.scroller.scrollLeft > 0,
      "scrolling to the end must move the scroller",
    ).toBe(true);
    expectResourcesWhole(end, NARROW_WIDTH_PX);
  });

  test("mid-scroll, both edges fade", async ({ page }) => {
    await openStrip(page, 6);
    // Fonts loaded and layout settled, so the scroll range is the final one.
    await nextFrames(page, 3);
    await scrollTo(page, "middle");
    await expect
      .poll(async () => (await readLayout(page)).fade, {
        message: "mid-scroll both edges hide something",
      })
      .toEqual({ left: true, right: true });
  });
});

// ── two accounts at 1400px: everything fits, nothing fades ────────────────

test.describe("two accounts at 1400px", () => {
  test.use({ viewport: { width: WIDE_WIDTH_PX, height: VIEWPORT_HEIGHT_PX } });

  test("everything fits and nothing fades", async ({ page }) => {
    await openStrip(page, 2);
    // A negative claim: "nothing fades" is also what the strip shows before
    // it has measured anything, so the reading waits for fonts and a few
    // frames of layout, in which ResizeObserver has delivered its first size.
    await nextFrames(page, 3);
    const wide = await readLayout(page);
    expect(wide.segmentCount, "both segments must be drawn").toBe(2);
    expect(
      wide.scroller.clientWidth > 0,
      "the scroller must have a laid-out box to measure",
    ).toBe(true);
    expect(
      wide.scroller.scrollWidth <= wide.scroller.clientWidth,
      `two accounts at ${String(WIDE_WIDTH_PX)}px must not overflow (scrollWidth ${String(wide.scroller.scrollWidth)}, clientWidth ${String(wide.scroller.clientWidth)})`,
    ).toBe(true);
    expect(
      wide.fade,
      `nothing fades when everything fits (classes: ${wide.scroller.className})`,
    ).toEqual({ left: false, right: false });
    expect(
      wide.scroller.maskImage,
      "no mask may be applied when nothing is cut off",
    ).toBe("none");
    expectResourcesWhole(wide, WIDE_WIDTH_PX);
  });
});
