import { expect, test, type Page } from "@playwright/test";

import { centreOf, fixture, nextFrames } from "./support/fixtures.ts";

// The epic canvas tile's VS Code-style tab strip (`TabStrip`,
// `src/components/epic-canvas/canvas/tab-strip.tsx`): a fixed h-9 tab item used
// to overflow the scroller's real 35px row by 1px, and because an
// `overflow-x-auto` scroller computes `overflow-y` to `auto`, a vertical mouse
// wheel over the strip - when there is no HORIZONTAL overflow, so
// `useHorizontalWheelScroll` returns early without `preventDefault()` - fell
// through to the browser's own native scroll-on-wheel action, which scrolled
// that 1px of vertical slack: the active tab's top accent bar and label
// wobbled up and down by a pixel. The fix drops the tab item's fixed height
// (it now stretches to the scroller's row) and adds `pt-px` so the icon/title
// sit on the same 18px centre line the old, clipped h-9 tab drew them on.
//
// jsdom cannot answer any of this. It lays nothing out, so `scrollHeight` and
// `clientHeight` are always 0 and "does this row have 1px of vertical
// overflow" has no answer there; and jsdom's `fireEvent.wheel` is a synthetic
// event with no native default action behind it, so it can never reach the
// mechanism the bug actually lived in - the BROWSER choosing which axis to
// scroll when a synthetic handler declines to call `preventDefault()`. Only a
// real layout engine plus a real, trusted wheel event can tell a 35px row with
// zero vertical slack apart from one with 1px of it.
//
// It also covers a second, narrower regression in the same fixed-height fix:
// `TabStripDropIndicator` (the vertical drop line a strip drag renders inside
// the hovered tab) was `inset-y-1` on the old fixed 36px tab, spanning
// 4px-32px from the tab's top; on the now-35px tab that same `inset-y-1`
// spans only 4px-31px, a 1px visible shrink. The fix reclaims it with
// `top-1 bottom-0.75`, and the drop-indicator test seeds a drop preview via
// the fixture's `?dropIndex=` param and measures the indicator back to
// 4px-32px.

const STRIP = '[data-testid="tab-strip"]';
const SCROLLER = '[data-testid="tab-strip-end"]';
const DROP_INDICATOR = '[data-testid="tab-strip-drop-indicator"]';
// Wide enough that a single ~100px blank tab never overflows it, narrow
// enough that twenty of them comfortably do.
const VIEWPORT_WIDTH_PX = 640;
const VIEWPORT_HEIGHT_PX = 200;
// Enough blank tabs to overflow `VIEWPORT_WIDTH_PX` several times over -
// twenty blank tabs at ~100px each is ~2000px of content in a 640px strip.
const OVERFLOW_TAB_COUNT = 20;
// Vertical wheel notches, dispatched as a real trusted wheel event - see the
// header for why this cannot be `fireEvent.wheel`.
const WHEEL_DELTA_PX = 120;
// "Look preserved" baseline: where the icon and title centres sat on the
// pre-fix layout (tab item `h-9`, no `pt-px`), measured by reverting
// `tab-strip.tsx` to it and running this driver. The fixed layout measures the
// same, so the fix moved nothing; a change here is a visible change.
const EXPECTED_ICON_CENTER_Y_FROM_STRIP_TOP_PX = 18;
const EXPECTED_TITLE_CENTER_Y_FROM_STRIP_TOP_PX = 18;
// Drop-indicator baseline: where `inset-y-1` placed the line on the old fixed
// 36px tab (4px from the top, 32px from the top - a 28px-tall line). The
// 35px tab's `top-1 bottom-0.75` fix reclaims exactly this span.
const EXPECTED_DROP_INDICATOR_TOP_FROM_TAB_TOP_PX = 4;
const EXPECTED_DROP_INDICATOR_BOTTOM_FROM_TAB_TOP_PX = 32;

test.use({
  viewport: { width: VIEWPORT_WIDTH_PX, height: VIEWPORT_HEIGHT_PX },
  deviceScaleFactor: 1,
});

interface StripState {
  readonly scroller: {
    readonly scrollHeight: number;
    readonly clientHeight: number;
    readonly scrollWidth: number;
    readonly clientWidth: number;
    readonly scrollTop: number;
    readonly scrollLeft: number;
  };
  readonly stripTop: number;
  readonly tabTop: number;
  readonly tabHeight: number;
  readonly iconCenterYFromStripTop: number;
  readonly titleCenterYFromStripTop: number;
  readonly accentTopFromStripTop: number;
}

/**
 * Loads the strip with `tabs` blank tabs, and a seeded drop preview at
 * `dropIndex` when one is given, then waits for every tab to be drawn and
 * layout (fonts, motion mounts) to settle.
 */
async function openStrip(
  page: Page,
  tabs: number,
  dropIndex: number | undefined,
): Promise<void> {
  const dropQuery =
    dropIndex === undefined ? "" : `&dropIndex=${String(dropIndex)}`;
  await page.goto(
    `${fixture("canvas-tab-strip-overflow")}?tabs=${String(tabs)}${dropQuery}`,
  );
  await expect(page.locator(SCROLLER)).toBeVisible();
  await expect(page.locator(`${STRIP} [role="tab"]`)).toHaveCount(tabs);
  await nextFrames(page, 3);
}

/**
 * The scroller's overflow/scroll state, the strip's top, and - for the
 * strip's FIRST (active + globally-active) tab - its own top, its icon and
 * title's vertical centres relative to the strip's top, and its accent bar's
 * top relative to the strip's top.
 */
function readStripState(page: Page): Promise<StripState> {
  return page.evaluate(
    (selectors: { readonly strip: string; readonly scroller: string }) => {
      const strip = document.querySelector(selectors.strip);
      const scroller = document.querySelector(selectors.scroller);
      if (
        !(strip instanceof HTMLElement) ||
        !(scroller instanceof HTMLElement)
      ) {
        throw new Error("the tab strip is missing");
      }
      const tab = strip.querySelector('[role="tab"]');
      if (tab === null) throw new Error("the tab strip has no tab");
      const icon = tab.querySelector("svg");
      const title = tab.querySelector('[data-testid^="tab-title-"]');
      const accent = tab.querySelector('[data-testid="tab-active-accent"]');
      if (icon === null || title === null || accent === null) {
        throw new Error("the first tab is missing its icon, title or accent");
      }
      const stripRect = strip.getBoundingClientRect();
      const tabRect = tab.getBoundingClientRect();
      const iconRect = icon.getBoundingClientRect();
      const titleRect = title.getBoundingClientRect();
      const accentRect = accent.getBoundingClientRect();
      return {
        scroller: {
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
          scrollWidth: scroller.scrollWidth,
          clientWidth: scroller.clientWidth,
          scrollTop: scroller.scrollTop,
          scrollLeft: scroller.scrollLeft,
        },
        stripTop: stripRect.top,
        tabTop: tabRect.top,
        tabHeight: tabRect.height,
        iconCenterYFromStripTop:
          iconRect.top + iconRect.height / 2 - stripRect.top,
        titleCenterYFromStripTop:
          titleRect.top + titleRect.height / 2 - stripRect.top,
        accentTopFromStripTop: accentRect.top - stripRect.top,
      };
    },
    { strip: STRIP, scroller: SCROLLER },
  );
}

function readScrollTop(page: Page): Promise<number> {
  return page.evaluate((selector: string) => {
    const scroller = document.querySelector(selector);
    if (!(scroller instanceof HTMLElement)) throw new Error("no scroller");
    return scroller.scrollTop;
  }, SCROLLER);
}

/**
 * The strip's first tab's `TabStripDropIndicator` rect relative to that tab's
 * top, or `null` for a side that is absent.
 */
function readDropIndicator(
  page: Page,
): Promise<{ readonly top: number | null; readonly bottom: number | null }> {
  return page.evaluate(
    (selectors: { readonly strip: string; readonly indicator: string }) => {
      const strip = document.querySelector(selectors.strip);
      const tab = strip === null ? null : strip.querySelector('[role="tab"]');
      const indicator =
        tab === null ? null : tab.querySelector(selectors.indicator);
      if (tab === null || indicator === null) {
        return { top: null, bottom: null };
      }
      const tabRect = tab.getBoundingClientRect();
      const indicatorRect = indicator.getBoundingClientRect();
      return {
        top: indicatorRect.top - tabRect.top,
        bottom: indicatorRect.bottom - tabRect.top,
      };
    },
    { strip: STRIP, indicator: DROP_INDICATOR },
  );
}

// ── (a): a single tab leaves no vertical scroll range ─────────────────────

test("a single tab leaves the scroller with no vertical scroll range and no horizontal overflow", async ({
  page,
}) => {
  await openStrip(page, 1, undefined);
  const single = await readStripState(page);
  expect(
    single.scroller.scrollHeight,
    `a single tab must leave the scroller with NO vertical scroll range ` +
      `(scrollHeight ${String(single.scroller.scrollHeight)}px, ` +
      `clientHeight ${String(single.scroller.clientHeight)}px)`,
  ).toBe(single.scroller.clientHeight);
  expect(
    single.scroller.scrollWidth <= single.scroller.clientWidth,
    `a single tab must not overflow horizontally either ` +
      `(scrollWidth ${String(single.scroller.scrollWidth)}px, ` +
      `clientWidth ${String(single.scroller.clientWidth)}px)`,
  ).toBe(true);

  // Assigning `scrollTop` directly must read back 0: there is no range to
  // move it into.
  await page.evaluate(`document.querySelector('${SCROLLER}').scrollTop = 5`);
  const afterAssign = await readScrollTop(page);
  expect(
    afterAssign,
    `assigning scrollTop = 5 on a strip with no vertical range must read ` +
      `back 0 (read ${String(afterAssign)})`,
  ).toBe(0);
});

// ── (b): a real vertical wheel over that strip moves nothing ──────────────

test("a real vertical wheel over a single-tab strip moves nothing, at any notch", async ({
  page,
}) => {
  await openStrip(page, 1, undefined);
  const singleStart = await readStripState(page);

  // Tracked page-side across the WHOLE sequence, not just at its end: a
  // down-then-up sequence can net-cancel back to scrollTop 0 on the BUGGY
  // (pre-fix) code too, which would make a final-value-only check pass on
  // both the broken and the fixed layout. The real invariant a zero-range
  // scroller must satisfy is that it never moves AT ALL, at any point in the
  // sequence, so `scrollTop` is sampled every frame and every scroll event
  // is counted. The wheel events are counted too: they are the positive proof
  // the gesture reached the page, which a "nothing moved" result needs.
  const probe = await page.evaluateHandle((selector: string) => {
    const scroller = document.querySelector(selector);
    if (!(scroller instanceof HTMLElement)) throw new Error("no scroller");
    let maxAbsScrollTop = Math.abs(scroller.scrollTop);
    let scrollEvents = 0;
    let wheelEvents = 0;
    scroller.addEventListener("scroll", () => {
      scrollEvents += 1;
    });
    document.addEventListener(
      "wheel",
      (event) => {
        if (event.isTrusted) wheelEvents += 1;
      },
      { capture: true, passive: true },
    );
    const sample = (): void => {
      maxAbsScrollTop = Math.max(maxAbsScrollTop, Math.abs(scroller.scrollTop));
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    return {
      read: () => ({
        maxAbsScrollTop,
        scrollEvents,
        wheelEvents,
        scrollTop: scroller.scrollTop,
      }),
    };
  }, SCROLLER);

  const centre = await centreOf(page.locator(SCROLLER));
  await page.mouse.move(centre.x, centre.y);
  const notches = [
    WHEEL_DELTA_PX,
    WHEEL_DELTA_PX,
    WHEEL_DELTA_PX,
    -WHEEL_DELTA_PX,
    -WHEEL_DELTA_PX,
  ];
  let delivered = 0;
  for (const deltaY of notches) {
    await page.mouse.wheel(0, deltaY);
    delivered += 1;
    await expect
      .poll(() => probe.evaluate((p) => p.read().wheelEvents), {
        message: `wheel notch ${String(delivered)} must reach the page as a trusted event`,
      })
      .toBe(delivered);
    // Let this notch's native scroll land before the next is dispatched, so
    // an intermediate wobble cannot be skipped over by two notches
    // coalescing into one paint. Frames, not milliseconds: the compositor
    // hands a native scroll to the main thread on the next frame.
    await nextFrames(page, 2);
  }
  await nextFrames(page, 3);

  const seen = await probe.evaluate((p) => p.read());
  const singleAfterWheel = await readStripState(page);
  expect(
    seen.maxAbsScrollTop,
    `scrollTop must never move off 0 at ANY point during the wheel ` +
      `sequence, not merely settle back to 0 at the end (max |scrollTop| ` +
      `seen mid-sequence ${String(seen.maxAbsScrollTop)}, final ` +
      `${String(singleAfterWheel.scroller.scrollTop)})`,
  ).toBe(0);
  expect(
    seen.scrollEvents,
    "the scroller must not fire a single scroll event under a wheel over a strip with no scroll range",
  ).toBe(0);
  expect(
    singleAfterWheel.scroller.scrollTop,
    `a real vertical wheel over a non-overflowing strip must not move ` +
      `scrollTop (read ${String(singleAfterWheel.scroller.scrollTop)})`,
  ).toBe(0);
  expect(
    singleAfterWheel.tabTop,
    `the tab's top must not move under the wheel (before ` +
      `${String(singleStart.tabTop)}px, after ${String(singleAfterWheel.tabTop)}px) - this ` +
      `is the 1px wobble the fix removes`,
  ).toBe(singleStart.tabTop);
  expect(
    singleAfterWheel.accentTopFromStripTop,
    `the active tab's top accent bar must not move under the wheel ` +
      `(before ${String(singleStart.accentTopFromStripTop)}px from the strip top, ` +
      `after ${String(singleAfterWheel.accentTopFromStripTop)}px)`,
  ).toBe(singleStart.accentTopFromStripTop);
});

// ── (d): the look is preserved ────────────────────────────────────────────

test("the tab item fills the scroller's row exactly and the accent bar sits flush with the strip's top", async ({
  page,
}) => {
  await openStrip(page, 1, undefined);
  const single = await readStripState(page);
  expect(
    single.tabHeight,
    `the tab item's height must equal the scroller's row height - a ` +
      `mismatch is exactly the 1px overflow the fix removes (tab ` +
      `${String(single.tabHeight)}px, scroller ${String(single.scroller.clientHeight)}px)`,
  ).toBe(single.scroller.clientHeight);
  expect(
    single.accentTopFromStripTop,
    `the active tab's top accent bar must sit flush with the strip's top ` +
      `(measured ${String(single.accentTopFromStripTop)}px from the strip top)`,
  ).toBe(0);
});

test("the tab's icon and title sit on the centre line the pre-fix layout drew them on", async ({
  page,
}) => {
  await openStrip(page, 1, undefined);
  const single = await readStripState(page);
  expect(
    single.iconCenterYFromStripTop,
    `the tab icon's vertical centre must sit where the pre-fix layout drew ` +
      `it, ${String(EXPECTED_ICON_CENTER_Y_FROM_STRIP_TOP_PX)}px from the strip's ` +
      `top (measured ${String(single.iconCenterYFromStripTop)}px)`,
  ).toBe(EXPECTED_ICON_CENTER_Y_FROM_STRIP_TOP_PX);
  expect(
    single.titleCenterYFromStripTop,
    `the tab title's vertical centre must sit where the pre-fix layout ` +
      `drew it, ${String(EXPECTED_TITLE_CENTER_Y_FROM_STRIP_TOP_PX)}px from the ` +
      `strip's top (measured ${String(single.titleCenterYFromStripTop)}px)`,
  ).toBe(EXPECTED_TITLE_CENTER_Y_FROM_STRIP_TOP_PX);
});

// ── (e): the strip drop indicator reclaims its pre-35px-tab span ──────────

test("the drop indicator spans 4px-32px of the tab, where it sat on the old fixed 36px tab", async ({
  page,
}) => {
  // A seeded `artifact-tab-strip` drop preview at index 0 (the fixture's
  // `?dropIndex=` param) mounts `TabStripDropIndicator` inside the single
  // tab with no real drag gesture needed.
  await openStrip(page, 1, 0);
  await expect(
    page.locator(`${STRIP} [role="tab"] ${DROP_INDICATOR}`),
  ).toHaveCount(1);
  // The indicator's 120ms mount animation (opacity/scaleY) must settle before
  // its rect means anything: each side is polled to its settled value.
  await expect
    .poll(async () => (await readDropIndicator(page)).top, {
      message:
        `the drop indicator's top must sit ` +
        `${String(EXPECTED_DROP_INDICATOR_TOP_FROM_TAB_TOP_PX)}px below the tab's top ` +
        `- where inset-y-1 placed it on the old fixed 36px tab`,
    })
    .toBe(EXPECTED_DROP_INDICATOR_TOP_FROM_TAB_TOP_PX);
  await expect
    .poll(async () => (await readDropIndicator(page)).bottom, {
      message:
        `the drop indicator's bottom must sit ` +
        `${String(EXPECTED_DROP_INDICATOR_BOTTOM_FROM_TAB_TOP_PX)}px below the tab's ` +
        `top (a ${String(
          EXPECTED_DROP_INDICATOR_BOTTOM_FROM_TAB_TOP_PX -
            EXPECTED_DROP_INDICATOR_TOP_FROM_TAB_TOP_PX,
        )}px-tall line) - the drop line sits where it did when the tab was a ` +
        `fixed 36px (inset-y-1 on 36px)`,
    })
    .toBe(EXPECTED_DROP_INDICATOR_BOTTOM_FROM_TAB_TOP_PX);
});

// ── (c): enough tabs to overflow, a vertical wheel scrolls horizontally ───

test("an overflowing strip has no vertical scroll range of its own and starts at its first tab", async ({
  page,
}) => {
  await openStrip(page, OVERFLOW_TAB_COUNT, undefined);
  const overflowStart = await readStripState(page);
  expect(
    overflowStart.scroller.scrollHeight,
    `an overflowing strip must still have NO vertical scroll range of its ` +
      `own (scrollHeight ${String(overflowStart.scroller.scrollHeight)}px, ` +
      `clientHeight ${String(overflowStart.scroller.clientHeight)}px)`,
  ).toBe(overflowStart.scroller.clientHeight);
  expect(
    overflowStart.scroller.scrollWidth > overflowStart.scroller.clientWidth,
    `${String(OVERFLOW_TAB_COUNT)} blank tabs at ${String(VIEWPORT_WIDTH_PX)}px must ` +
      `overflow the scroller horizontally (scrollWidth ` +
      `${String(overflowStart.scroller.scrollWidth)}px, clientWidth ` +
      `${String(overflowStart.scroller.clientWidth)}px)`,
  ).toBe(true);
  expect(
    overflowStart.scroller.scrollLeft,
    "the overflowing strip must start scrolled to its first tab",
  ).toBe(0);
});

test("a real vertical wheel over an overflowing strip scrolls it horizontally, never vertically", async ({
  page,
}) => {
  await openStrip(page, OVERFLOW_TAB_COUNT, undefined);
  const centre = await centreOf(page.locator(SCROLLER));
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.wheel(0, WHEEL_DELTA_PX);
  await expect
    .poll(async () => (await readStripState(page)).scroller.scrollLeft, {
      message:
        "a real vertical wheel over an overflowing strip must turn into horizontal scroll",
    })
    .toBeGreaterThan(0);
  // Horizontal scroll has been seen, so the wheel has been handled: any
  // native vertical scroll it would have caused has had its chance.
  await nextFrames(page, 2);
  const afterWheel = await readStripState(page);
  expect(
    afterWheel.scroller.scrollTop,
    `the same wheel must leave scrollTop at 0 - it is horizontal scroll, ` +
      `never vertical (read ${String(afterWheel.scroller.scrollTop)})`,
  ).toBe(0);
});
