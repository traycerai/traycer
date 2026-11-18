import { expect, test, type Page } from "@playwright/test";
import {
  STRICT_BOTTOM_PX,
  readView,
  settle,
  transcriptMounted,
} from "./support/chat-scroll-oracle";
import { fixture, nextFrames, wheelsDelivered } from "./support/fixtures";

/**
 * The list reports "the reader moved" (`onReaderMoved`) when, and only when,
 * a reader's own gesture could move it. A surface holding a pending jump
 * drops the jump on that report, so a report the list raises by itself
 * (the correction after a streamed reply grew, a held range arriving above
 * the view) would drop a jump nobody abandoned.
 *
 * Every test runs on `?dock=none`, the list drawn with no composer dock, the
 * way a read-only transcript is. The count is the page's own
 * (`readerMovedReports`); a negative claim is read after a completion the
 * test awaited, never after a wait of its own.
 */

const SCROLL = '[data-testid="chat-messages-scroll"]';
const PLACEHOLDER = '[data-testid="chat-transcript-placeholder-row"]';
const STREAM_INTERVAL_MS = 40;
const WHEEL_AWAY = { deltaX: 0, deltaY: -100 };
const WHEEL_TOWARD_END = { deltaX: 0, deltaY: 100 };

function callProbe(
  page: Page,
  name: string,
  args: ReadonlyArray<number | string | boolean | object | null>,
): Promise<void> {
  return page.evaluate(
    ({ method, values }) => {
      const probe = window.__chatScrollProbe;
      const fn: unknown = Reflect.get(probe, method);
      if (typeof fn !== "function")
        throw new Error(`no ${method} on the probe`);
      Reflect.apply(fn, probe, values);
    },
    { method: name, values: args },
  );
}

function readerMovedReports(page: Page): Promise<number> {
  return page.evaluate(() => {
    const probe = window.__chatScrollProbe;
    const fn: unknown = Reflect.get(probe, "readerMovedReports");
    if (typeof fn !== "function") throw new Error("no reader-moved counter");
    const count: unknown = Reflect.apply(fn, probe, []);
    if (typeof count !== "number") throw new Error("the counter is no number");
    return count;
  });
}

async function open(page: Page, query: string): Promise<void> {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(
    `${fixture("chat-scroll-model")}?line=windowed&dock=none${query}`,
  );
  await page.waitForFunction(
    () =>
      "__chatScrollProbe" in window &&
      window.__chatScrollProbe.windowState()?.skeletonComplete === true,
    undefined,
    { polling: "raf" },
  );
  await transcriptMounted(page);
}

type ColdRow = "far above the tail" | "next to the hot tail";

/**
 * A cold row: far above the hot tail, as a jump to an old message names one,
 * or the one just below the lowest row of the hydrated span that holds the
 * tail. It must start cold.
 */
async function coldOrdinal(page: Page, which: ColdRow): Promise<number> {
  const ordinal = await page.evaluate((wanted) => {
    const probe = window.__chatScrollProbe;
    const state = probe.windowState();
    if (state === null) throw new Error("no window state");
    if (wanted === "far above the tail")
      return Math.floor(state.skeletonLength / 2);
    const tail = state.skeletonLength - 1;
    const span = state.spans.find(
      (candidate) =>
        candidate.fromOrdinal <= tail && tail < candidate.toOrdinal,
    );
    if (span === undefined) throw new Error("no hydrated span holds the tail");
    return span.fromOrdinal - 1;
  }, which);
  expect(
    ordinal,
    "a cold row exists below the hot tail",
  ).toBeGreaterThanOrEqual(0);
  const covered = await page.evaluate(
    (wanted) =>
      window.__chatScrollProbe
        .hydratedRange()
        ?.spans.some(
          (span) => span.fromOrdinal <= wanted && wanted < span.toOrdinal,
        ) ?? null,
    ordinal,
  );
  expect(covered, "the held ordinal starts cold").toBe(false);
  return ordinal;
}

interface RowInContent {
  readonly id: string;
  /** The row's top in the scroller's content: its top from the scroller's
   *  top plus the scroll offset. It moves only when something above the row
   *  changes height. */
  readonly top: number;
}

/** The mounted, hydrated row just above the streaming tail row. */
function rowAboveTail(page: Page): Promise<RowInContent> {
  return page.evaluate((selector) => {
    const node = document.querySelector<HTMLElement>(selector);
    if (node === null) throw new Error("no scroll node");
    const rows = Array.from(
      node.querySelectorAll<HTMLElement>("[data-message-id]"),
    ).sort(
      (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top,
    );
    const row = rows.at(-2);
    const id = row?.dataset.messageId;
    if (row === undefined || id === undefined)
      throw new Error("no hydrated row above the tail is mounted");
    return {
      id,
      top:
        row.getBoundingClientRect().top -
        node.getBoundingClientRect().top +
        node.scrollTop,
    };
  }, SCROLL);
}

/** The same row again; a row that left the document is a test error. */
function rowInContent(page: Page, id: string): Promise<RowInContent> {
  return page.evaluate(
    ({ selector, wanted }) => {
      const node = document.querySelector<HTMLElement>(selector);
      if (node === null) throw new Error("no scroll node");
      const row = node.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(wanted)}"]`,
      );
      if (row === null) throw new Error(`row ${wanted} is no longer mounted`);
      return {
        id: wanted,
        top:
          row.getBoundingClientRect().top -
          node.getBoundingClientRect().top +
          node.scrollTop,
      };
    },
    { selector: SCROLL, wanted: id },
  );
}

async function pointAtTranscript(page: Page): Promise<void> {
  const box = await page.locator(SCROLL).boundingBox();
  if (box === null) throw new Error("no scroll node");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

/**
 * Holds every range request from now on, names `ordinal` as a pending jump
 * does, and resolves once the host has recorded the request that covers it:
 * the request is out and unanswered.
 */
async function holdRangeAt(page: Page, ordinal: number): Promise<void> {
  await callProbe(page, "holdRanges", []);
  await callProbe(page, "holdOrdinal", [ordinal]);
  await page.waitForFunction(
    (wanted) =>
      window.__chatScrollProbe.frameLog().some((line) => {
        const match = /loadRange \S+ \[(\d+),(\d+)\]/.exec(line);
        return (
          match !== null &&
          Number(match[1]) <= wanted &&
          wanted <= Number(match[2])
        );
      }),
    ordinal,
    { polling: "raf", timeout: 8_000 },
  );
}

/** Resolves once the range holding `ordinal` is in the store and its row is
 *  no placeholder. */
async function rangeDrawn(page: Page, ordinal: number): Promise<void> {
  await page.waitForFunction(
    ({ wanted, placeholder }) =>
      (window.__chatScrollProbe
        .hydratedRange()
        ?.spans.some(
          (span) => span.fromOrdinal <= wanted && wanted < span.toOrdinal,
        ) ??
        false) &&
      document.querySelector(
        `${placeholder}[data-ordinal="${String(wanted)}"]`,
      ) === null,
    { wanted: ordinal, placeholder: PLACEHOLDER },
    { polling: "raf", timeout: 8_000 },
  );
  await nextFrames(page, 4);
}

/**
 * Releases the held ranges on the first painted frame where a following list
 * sits off its strict bottom: a streamed reply has grown and the correction
 * has not yet run. The release is the probe's `releaseRanges`, called in the
 * same frame callback that read the geometry, so the view it resolves with is
 * the view at delivery: the host answers each range and the session store
 * takes it in that call, with no timer or promise between. The list's own
 * render of the arrived rows comes after the callback returns. The probe's
 * type does not declare the member (it belongs to this fixture alone), so it
 * is called by name.
 */
function releaseOffTheBottom(
  page: Page,
): Promise<{ readonly fromEnd: number; readonly mode: string | null }> {
  return page.evaluate(
    () =>
      new Promise<{ fromEnd: number; mode: string | null }>(
        (resolve, reject) => {
          const started = performance.now();
          const tick = (): void => {
            const probe = window.__chatScrollProbe;
            const geometry = probe.geometry();
            const mode = probe.mode();
            if (geometry !== null && mode === "following-end") {
              const fromEnd =
                geometry.scrollHeight -
                geometry.clientHeight -
                geometry.scrollTop;
              if (fromEnd > 1) {
                const release: unknown = Reflect.get(probe, "releaseRanges");
                if (typeof release !== "function")
                  throw new Error("no releaseRanges on the probe");
                Reflect.apply(release, probe, []);
                resolve({ fromEnd, mode });
                return;
              }
            }
            if (performance.now() - started > 8_000) {
              reject(
                new Error("the following list was never off its strict bottom"),
              );
              return;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        },
      ),
  );
}

async function expectFollowingAtEnd(page: Page): Promise<void> {
  const view = await settle(page, 10);
  expect(view.mode).toBe("following-end");
  expect(view.pill).toBe(false);
  expect(view.fromEnd).toBeLessThanOrEqual(STRICT_BOTTOM_PX);
}

test.describe("the list's reader-moved report", () => {
  // The arriving range must move layout above the view, or zero reports
  // shows nothing: the witness is a mounted row above the tail whose place
  // in the content changes between the held request and the drawn range.
  // The held row is the cold one nearest the hot tail: a range far above the
  // view hydrates rows that are not mounted and need not move anything near
  // it.
  test("a held range next to the hot tail, arriving while the list follows a stream, reports nothing", async ({
    page,
  }) => {
    await open(page, "&shape=longTail&turns=100");
    const ordinal = await coldOrdinal(page, "next to the hot tail");
    await callProbe(page, "startStream", [STREAM_INTERVAL_MS]);
    await holdRangeAt(page, ordinal);
    const before = await rowAboveTail(page);
    const caught = await releaseOffTheBottom(page);
    expect(caught.fromEnd).toBeGreaterThan(STRICT_BOTTOM_PX);
    await rangeDrawn(page, ordinal);
    const after = await rowInContent(page, before.id);
    expect(
      Math.abs(after.top - before.top),
      `row ${before.id} moved in the content`,
    ).toBeGreaterThan(0.5);
    await callProbe(page, "stopStream", []);
    await expectFollowingAtEnd(page);
    expect(await readerMovedReports(page)).toBe(0);
  });

  test("a wheel away from the end while that range is held reports the reader", async ({
    page,
  }) => {
    await open(page, "");
    const ordinal = await coldOrdinal(page, "far above the tail");
    await callProbe(page, "startStream", [STREAM_INTERVAL_MS]);
    await holdRangeAt(page, ordinal);
    await pointAtTranscript(page);
    expect(await readerMovedReports(page)).toBe(0);
    await wheelsDelivered(page, [WHEEL_AWAY], 0);
    await expect.poll(() => readerMovedReports(page)).toBeGreaterThanOrEqual(1);
    await callProbe(page, "stopStream", []);
  });

  test("at the strict bottom a wheel toward the end reports nothing, and a wheel away reports", async ({
    page,
  }) => {
    await open(page, "");
    await expectFollowingAtEnd(page);
    expect((await readView(page)).fromEnd).toBeLessThanOrEqual(
      STRICT_BOTTOM_PX,
    );
    await pointAtTranscript(page);
    await wheelsDelivered(page, [WHEEL_TOWARD_END], 0);
    await nextFrames(page, 4);
    expect(await readerMovedReports(page)).toBe(0);
    await wheelsDelivered(page, [WHEEL_AWAY], 0);
    await expect.poll(() => readerMovedReports(page)).toBeGreaterThanOrEqual(1);
  });
});
