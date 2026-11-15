import { expect, test, type Page } from "@playwright/test";

import { fixture, nextFrames } from "./support/fixtures.ts";

// A structural commit arms the list's anchor lock, and while it is held a row
// that changes size has its compensating pass left for an animation frame. A
// reader's scroll in between writes the new size into the positions, so only
// the lock's position still says where the anchor stood. The patched list
// keeps a lock that pass waits on until a pass has compensated against it:
// releasing it first - a content-only commit, its expiry, `cancelPendingScroll`
// - left the content under the reader moved by the size change. The fixture is
// `src/__tests__/browser/legend-list-deferred-size-lock.tsx`.

type Release =
  | "none"
  | "content-commit"
  | "expire-lock"
  | "cancel-pending-scroll"
  | "unmount"
  | "replace-all"
  | "remove-anchor-row";

interface ArmPlan {
  readonly rowIndex: number;
  readonly readerDelta: number;
  readonly release: Release;
}

interface ListView {
  readonly lock: { readonly id: string } | null;
  readonly framePending: boolean;
}

declare global {
  interface Window {
    __structural?: () => void;
    __contentCommit?: () => void;
    __resizeRow?: (index: number, height: number) => void;
    __arm?: (plan: ArmPlan) => void;
    __readerScroll?: (delta: number) => Promise<void>;
    __listView?: () => ListView | null;
    __armed?: ListView | null;
    __released?: boolean;
  }
}

const SCROLLER = '[data-testid="list"]';
const ROW = 100;
// The view starts with row 30 at its top: the anchor the structural commit
// locks. Row 29, just above the view, is the row that shrinks.
const ANCHOR = "row-30";
const RESIZED = 29;
const SHRUNK_TO = 40;
const SHRINK = ROW - SHRUNK_TO;
const READER_DELTA = 60;

async function open(page: Page): Promise<void> {
  await page.goto(fixture("legend-list-deferred-size-lock"));
  await expect(page.locator('[data-row="row-0"]')).toBeAttached();
  await page.evaluate(
    ([selector, top]) => {
      const scroller = document.querySelector<HTMLElement>(selector);
      if (scroller === null) throw new Error("no scroller");
      scroller.scrollTop = top;
    },
    [SCROLLER, 30 * ROW] as const,
  );
  await expect.poll(() => anchorTop(page)).toBe(0);
  await nextFrames(page, 3);
}

/** Where the anchor row's top edge is, from the scroller's top. */
function anchorTop(page: Page): Promise<number | null> {
  return page.evaluate(
    ([selector, id]) => {
      const scroller = document.querySelector<HTMLElement>(selector);
      const row = document.querySelector<HTMLElement>(`[data-row="${id}"]`);
      if (scroller === null || row === null) return null;
      return Math.round(
        row.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
      );
    },
    [SCROLLER, ANCHOR] as const,
  );
}

function scrollTop(page: Page): Promise<number | null> {
  return page.evaluate(
    (selector) =>
      document.querySelector<HTMLElement>(selector)?.scrollTop ?? null,
    SCROLLER,
  );
}

/** The structural commit, the plan and the resize in one task, so the lock
 *  cannot lapse between them. */
function armAndResize(page: Page, plan: ArmPlan): Promise<void> {
  return page.evaluate(
    ([armed, index, height]) => {
      if (
        window.__structural === undefined ||
        window.__arm === undefined ||
        window.__resizeRow === undefined
      ) {
        throw new Error("no fixture");
      }
      window.__structural();
      window.__arm(armed);
      window.__resizeRow(index, height);
    },
    [plan, RESIZED, SHRUNK_TO] as const,
  );
}

/** The armed sequence released and the deferred frame no longer pending. */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      window.__released === true &&
      window.__listView?.()?.framePending === false,
  );
  await nextFrames(page, 3);
}

/** The release landed while the lock was held and its pass still deferred:
 *  without this the run would not exercise the deferral at all. */
async function expectDeferredUnderLock(page: Page): Promise<void> {
  const armed = await page.evaluate(() => window.__armed ?? null);
  expect(armed).toEqual({ lock: { id: ANCHOR }, framePending: true });
}

/** The shrink is compensated: the anchor moved by the reader's travel only. */
async function expectAnchorHeld(page: Page): Promise<void> {
  expect(await anchorTop(page)).toBe(READER_DELTA);
}

/** The release still happens once the owed pass has compensated. */
async function expectLockReleased(page: Page): Promise<void> {
  expect(await page.evaluate(() => window.__listView?.() ?? null)).toEqual({
    lock: null,
    framePending: false,
  });
}

test.describe("a deferred size pass when its anchor lock is released", () => {
  test("a content commit before the frame ends where the frame first does", async ({
    page,
  }) => {
    // The frame first: the deferred pass compensates under the lock, then
    // the reader scrolls and the content commit follows.
    await open(page);
    const start = await scrollTop(page);
    if (start === null) throw new Error("no scroller");
    await armAndResize(page, {
      rowIndex: RESIZED,
      readerDelta: 0,
      release: "none",
    });
    await page.waitForFunction(
      ([selector, target]) =>
        window.__released === true &&
        window.__listView?.()?.framePending === false &&
        document.querySelector<HTMLElement>(selector)?.scrollTop === target,
      [SCROLLER, start - SHRINK] as const,
    );
    await expectDeferredUnderLock(page);
    await page.evaluate(async (delta) => {
      if (
        window.__readerScroll === undefined ||
        window.__contentCommit === undefined
      ) {
        throw new Error("no fixture");
      }
      await window.__readerScroll(delta);
      window.__contentCommit();
    }, READER_DELTA);
    await nextFrames(page, 3);
    await expectAnchorHeld(page);
    const frameFirst = await scrollTop(page);

    // The content commit first: it lands after the reader's scroll and
    // before the deferred frame.
    await open(page);
    await armAndResize(page, {
      rowIndex: RESIZED,
      readerDelta: READER_DELTA,
      release: "content-commit",
    });
    await settle(page);
    await expectDeferredUnderLock(page);
    await expectAnchorHeld(page);
    await expectLockReleased(page);
    expect(await scrollTop(page)).toBe(frameFirst);
  });

  test("the lock expiring before the frame still compensates", async ({
    page,
  }) => {
    await open(page);
    await armAndResize(page, {
      rowIndex: RESIZED,
      readerDelta: READER_DELTA,
      release: "expire-lock",
    });
    await settle(page);
    await expectDeferredUnderLock(page);
    await expectAnchorHeld(page);
    await expectLockReleased(page);
  });

  test("cancelPendingScroll before the frame still compensates", async ({
    page,
  }) => {
    await open(page);
    await armAndResize(page, {
      rowIndex: RESIZED,
      readerDelta: READER_DELTA,
      release: "cancel-pending-scroll",
    });
    await settle(page);
    await expectDeferredUnderLock(page);
    await expectAnchorHeld(page);
    await expectLockReleased(page);
  });

  // The kept lock ends with its list and with its anchor row. These hold on
  // the unpatched list too: they pin that the patch never holds a lock past
  // either.
  test("unmounting with the pass deferred throws nothing", async ({ page }) => {
    const errors: Error[] = [];
    page.on("pageerror", (error) => errors.push(error));
    await open(page);
    await armAndResize(page, {
      rowIndex: RESIZED,
      readerDelta: 0,
      release: "unmount",
    });
    await page.waitForFunction(() => window.__released === true);
    await expectDeferredUnderLock(page);
    await expect(page.locator(SCROLLER)).toHaveCount(0);
    await nextFrames(page, 5);
    expect(errors).toEqual([]);
  });

  for (const release of ["replace-all", "remove-anchor-row"] as const) {
    test(`${release} with the pass deferred leaves no lock on the old anchor`, async ({
      page,
    }) => {
      const errors: Error[] = [];
      page.on("pageerror", (error) => errors.push(error));
      await open(page);
      await armAndResize(page, { rowIndex: RESIZED, readerDelta: 0, release });
      await settle(page);
      await expectDeferredUnderLock(page);
      const view = await page.evaluate(() => window.__listView?.() ?? null);
      // The new rows may arm a lock of their own; the old anchor's is gone.
      expect(view?.lock?.id).not.toBe(ANCHOR);
      expect(view?.framePending).toBe(false);
      expect(errors).toEqual([]);
    });
  }
});
