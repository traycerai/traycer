import { expect, test, type Locator, type Page } from "@playwright/test";
import { z } from "zod";

import { fixture, nextFrames } from "./support/fixtures.ts";

// The top tab strip's motion (`src/components/layout/tabs/`): a reopened tab's
// slot grows from nothing, a closed tab's space is held by a spacer that then
// shrinks away, the selection's sheet slides to the tab you chose, and a
// single reopen glows the join once it lands.
//
// jsdom has no layout and no Web Animations, so these are browser claims about
// what a person SEES frame by frame: each test records the strip's geometry on
// every animation frame across a gesture and asserts on the series. Nothing
// asserts a duration. Widths are compared with where they settle and orderings
// with the order they should keep, so a slow runner draws fewer frames of the
// same motion and still passes. The one time bound, `MIN_CROSSING_MS`, is a
// floor that sparse frames can only help.
//
// The strip is the production `TabStrip`, mounted by `tab-recovery.tsx`, whose
// `window.__traycerTabRecovery` bridge performs the gestures.

const SELECTORS = {
  strip: '[data-testid="tab-strip"]',
  scroller: '[data-testid="header-tab-strip-scroll"]',
  traveller: '[data-testid="tab-selection-traveller"]',
} as const;
type Selectors = typeof SELECTORS;
const JOINED_BOX = '[data-sheet-joined="top"]';

// The sheet join, and so the traveller that carries it, only exists from md
// (48rem); this is comfortably past it and wide enough for several tabs.
test.use({ viewport: { width: 1300, height: 360 }, deviceScaleFactor: 1 });

/** Layout rounding, not motion. */
const SUBPIXEL_PX = 1;
/** The same, for a tab's progress as a fraction of its width. */
const PROGRESS_TOLERANCE = 0.03;
/**
 * The least time a slot may take to cross from 5% to 95% of the way. They take
 * about 150ms, and a pop-in a frame or two, so this sits between the two.
 */
const MIN_CROSSING_MS = 60;
/** Wider than the strip at the tab's narrowest (about 192px). */
const OVERFLOWING_TAB_COUNT = 10;
const SHRUNK_TAB_COUNT = 12;
/**
 * A slot opens in 320ms and reopened tabs are staggered up to 240ms apart, so
 * in a batch this large the last slots are still shut when the first is fully
 * open. That is what holding the early ones at their width is for.
 */
const SHRUNK_BATCH_SIZE = 9;
/**
 * `arrangement.taskTabLayout: "shrink"` as the layout store persists it, seeded
 * before load because the fixture has no setter. If the key or version drift,
 * the test fails on its premise (`data-tab-layout`), not on the wrong layout.
 */
const SHRINK_LAYOUT_RECORD = {
  key: "traycer-gui-app:layout",
  value: JSON.stringify({
    state: {
      basePreset: "default",
      overrides: {},
      arrangement: { taskTabLayout: "shrink" },
    },
    version: 7,
  }),
} as const;

interface Box {
  readonly id: string;
  /** In the scroller's content coordinates, so a scroll is not a move. */
  readonly left: number;
  readonly width: number;
}

interface Sample {
  /** The frame's own timestamp: a starved page runs a frame late and catches up. */
  readonly time: number;
  readonly scrollLeft: number;
  readonly clientWidth: number;
  /** The tabs' slots, and the spacers left where tabs were closed. */
  readonly frames: ReadonlyArray<Box>;
  readonly ghosts: ReadonlyArray<Box>;
  /** The selection's traveller while it is drawn, otherwise null. */
  readonly traveller: {
    readonly left: number;
    readonly joined: boolean;
  } | null;
  readonly glowing: boolean;
}

/**
 * Waits for the strip to hold `frames` tabs at rest: no spacer, no running
 * animation (a slot still opening, or held open for its batch, is one) and no
 * traveller in flight. It is also the proof a gesture landed at all.
 */
async function expectResting(page: Page, frames: number): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (input: Selectors & { readonly frames: number }) => {
            const scroller = document.querySelector(input.scroller);
            if (!(scroller instanceof HTMLElement)) return false;
            const traveller = scroller.querySelector(input.traveller);
            return (
              scroller.querySelectorAll(":scope > [data-strip-item-id]")
                .length === input.frames &&
              scroller.querySelector("[data-strip-exit-ghost]") === null &&
              scroller.getAnimations({ subtree: true }).length === 0 &&
              traveller instanceof HTMLElement &&
              traveller.hidden
            );
          },
          { ...SELECTORS, frames },
        ),
      { message: `the strip must come to rest with ${String(frames)} tabs` },
    )
    .toBe(true);
}

/**
 * Samples the strip now and on every animation frame while `gesture` runs and
 * the strip comes to rest with `tabsAtRest` tabs. Sampling is page-side, so the
 * frames are not lost to the round trips of the test. A few frames past rest
 * are kept because the join glow starts a frame after the selection lands.
 */
async function record(
  page: Page,
  tabsAtRest: number,
  gesture: () => Promise<unknown>,
): Promise<Sample[]> {
  const recorder = await page.evaluateHandle(
    (selectors: Selectors): { readonly stop: () => Sample[] } => {
      const strip = document.querySelector(selectors.strip);
      const scroller = document.querySelector(selectors.scroller);
      if (!(strip instanceof HTMLElement) || !(scroller instanceof HTMLElement))
        throw new Error("the tab strip is missing");
      const samples: Sample[] = [];
      let recording = true;
      const capture = (time: number): void => {
        const view = scroller.getBoundingClientRect();
        const frames: Box[] = [];
        const ghosts: Box[] = [];
        for (const child of scroller.children) {
          if (!(child instanceof HTMLElement)) continue;
          const { stripItemId, stripExitGhost } = child.dataset;
          const id = stripItemId ?? stripExitGhost;
          if (id === undefined) continue;
          const box = child.getBoundingClientRect();
          (stripItemId === undefined ? ghosts : frames).push({
            id,
            left: box.left - view.left + scroller.scrollLeft,
            width: box.width,
          });
        }
        const traveller = scroller.querySelector(selectors.traveller);
        if (!(traveller instanceof HTMLElement))
          throw new Error("the selection traveller is missing");
        const travellerBox = traveller.getBoundingClientRect();
        samples.push({
          time,
          scrollLeft: scroller.scrollLeft,
          clientWidth: scroller.clientWidth,
          frames,
          ghosts,
          traveller:
            traveller.hidden || travellerBox.width === 0
              ? null
              : {
                  left: travellerBox.left - view.left + scroller.scrollLeft,
                  joined: traveller.getAttribute("data-sheet-joined") === "top",
                },
          glowing: strip.hasAttribute("data-join-glow"),
        });
      };
      const tick = (frameTime: number): void => {
        if (!recording) return;
        capture(frameTime);
        requestAnimationFrame(tick);
      };
      capture(performance.now());
      requestAnimationFrame(tick);
      return {
        stop: () => {
          recording = false;
          capture(performance.now());
          return samples;
        },
      };
    },
    SELECTORS,
  );
  await gesture();
  await expectResting(page, tabsAtRest);
  await nextFrames(page, 5);
  return recorder.evaluate((handle) => handle.stop());
}

async function callBridge(
  page: Page,
  method: string,
  args: ReadonlyArray<unknown>,
): Promise<unknown> {
  return page.evaluate(
    async (call: {
      readonly method: string;
      readonly args: ReadonlyArray<unknown>;
    }): Promise<unknown> => {
      const bridge: unknown = Reflect.get(window, "__traycerTabRecovery");
      const operation: unknown =
        typeof bridge === "object" && bridge !== null
          ? Reflect.get(bridge, call.method)
          : undefined;
      if (typeof operation !== "function")
        throw new Error(`the tab recovery bridge has no ${call.method}`);
      const result: unknown = await Reflect.apply(operation, bridge, [
        ...call.args,
      ]);
      return result;
    },
    { method, args },
  );
}

/** Loads the strip and opens `count` tasks, the last active; returns their tab ids. */
async function openStrip(page: Page, count: number): Promise<string[]> {
  await page.goto(fixture("tab-recovery"));
  await page.waitForFunction(
    () => Reflect.get(window, "__traycerTabRecovery") !== undefined,
  );
  await callBridge(page, "reset", []);
  const tabIds: string[] = [];
  for (let number = 1; number <= count; number += 1) {
    const tabId = await callBridge(page, "createTask", [`Task ${number}`]);
    tabIds.push(z.string().parse(tabId));
  }
  await expectResting(page, count);
  return tabIds;
}

function readScroller(page: Page): Promise<{
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly scrollLeft: number;
}> {
  return page.locator(SELECTORS.scroller).evaluate((scroller) => ({
    scrollWidth: scroller.scrollWidth,
    clientWidth: scroller.clientWidth,
    scrollLeft: scroller.scrollLeft,
  }));
}

function frameHolding(page: Page, inside: Locator): Locator {
  return page
    .locator(`${SELECTORS.scroller} > [data-strip-item-id]`)
    .filter({ has: inside });
}

/** The frame holding the selected tab: the one whose box the sheet joins. */
function selectedFrame(page: Page): Locator {
  return frameHolding(page, page.locator('[role="tab"][aria-selected="true"]'));
}

async function itemIdOf(frame: Locator): Promise<string> {
  const itemId = await frame.getAttribute("data-strip-item-id");
  if (itemId === null) throw new Error(`${frame.toString()} matches no frame`);
  return itemId;
}

/**
 * Clicks a tab and records the selection sliding to it. `from` and `to` are the
 * frame ids of the tab the selection left and the one it went to.
 */
async function switchTo(
  page: Page,
  tabId: string,
  tabCount: number,
): Promise<{ from: string; to: string; samples: Sample[] }> {
  const from = await itemIdOf(selectedFrame(page));
  const title = page.getByTestId(`tab-title-epic-${tabId}`);
  const to = await itemIdOf(frameHolding(page, title));
  const samples = await record(page, tabCount, async () => {
    await title.click();
    await expect(selectedFrame(page)).toHaveAttribute("data-strip-item-id", to);
  });
  return { from, to, samples };
}

function itemAt<T>(items: ReadonlyArray<T>, index: number): T {
  const item = items.at(index);
  if (item === undefined) throw new Error(`nothing at ${String(index)}`);
  return item;
}

function onlyOne<T>(items: ReadonlyArray<T>, what: string): T {
  const [item, ...rest] = items;
  if (item === undefined || rest.length > 0)
    throw new Error(`expected one ${what}, found ${String(items.length)}`);
  return item;
}

function frameIn(sample: Sample, id: string): Box | undefined {
  return sample.frames.find((frame) => frame.id === id);
}

/** NaN when the frame is not drawn in the sample, which no comparison passes. */
function leftOf(sample: Sample, id: string): number {
  return frameIn(sample, id)?.left ?? Number.NaN;
}

function widthOf(sample: Sample, id: string): number {
  return frameIn(sample, id)?.width ?? Number.NaN;
}

function expectNear(actual: number, expected: number, claim: string): void {
  expect(Math.abs(actual - expected), claim).toBeLessThanOrEqual(SUBPIXEL_PX);
}

/** The frames a gesture added, left to right as they end up. */
function openedFrameIds(samples: ReadonlyArray<Sample>): string[] {
  const before = new Set(itemAt(samples, 0).frames.map((frame) => frame.id));
  return itemAt(samples, -1)
    .frames.filter((frame) => !before.has(frame.id))
    .toSorted((first, second) => first.left - second.left)
    .map((frame) => frame.id);
}

interface Closing {
  /** The closed tab's box before the gesture, and the samples either side of its frame going. */
  readonly closed: Box;
  readonly afterIndex: number;
  readonly before: Sample;
  readonly after: Sample;
}

function readClosing(samples: ReadonlyArray<Sample>): Closing {
  const last = itemAt(samples, -1);
  const closed = onlyOne(
    itemAt(samples, 0).frames.filter((frame) => !frameIn(last, frame.id)),
    "closed tab",
  );
  const afterIndex = samples.findIndex((sample) => !frameIn(sample, closed.id));
  return {
    closed,
    afterIndex,
    before: itemAt(samples, afterIndex - 1),
    after: itemAt(samples, afterIndex),
  };
}

/** Where, in `sample`, the tab that was right of the closed one is. */
function neighbourLeftIn(closing: Closing, sample: Sample): number {
  const neighbour = closing.before.frames.find(
    (frame) => frame.left > closing.closed.left,
  );
  return neighbour === undefined ? Number.NaN : leftOf(sample, neighbour.id);
}

/**
 * How long a 0 to 1 progress took to get from 5% to 95%: from the last sample
 * still short of the band to the first past it. Sparse frames widen the gap
 * between the two, so a starved runner only ever makes this longer.
 */
function crossingMs(
  samples: ReadonlyArray<Sample>,
  progressOf: (sample: Sample) => number,
): number {
  const short = samples.findLast((sample) => progressOf(sample) <= 0.05);
  const past = samples.find((sample) => progressOf(sample) >= 0.95);
  return short === undefined || past === undefined ? 0 : past.time - short.time;
}

/**
 * What an opening slot must do: appear at nothing, only ever grow, never pass
 * the width it settles at (a slot that overshoots pushes its neighbours out
 * and back), and take several frames about it rather than popping.
 */
function expectGrowsToRest(
  samples: ReadonlyArray<Sample>,
  id: string,
  label: string,
): void {
  const widths = samples.flatMap((sample) =>
    frameIn(sample, id) === undefined ? [] : [widthOf(sample, id)],
  );
  const settled = itemAt(widths, -1);
  expect(settled, `${label} ends as a real tab`).toBeGreaterThan(40);
  expect(widths[0], `${label} starts at nothing`).toBeLessThanOrEqual(
    SUBPIXEL_PX,
  );
  expect(
    Math.max(...widths),
    `${label} never passes its width`,
  ).toBeLessThanOrEqual(settled + SUBPIXEL_PX);
  expect(
    widths.filter(
      (width, index) => width < (widths[index - 1] ?? width) - SUBPIXEL_PX,
    ),
    `${label} only grows`,
  ).toEqual([]);
  expect(
    crossingMs(samples, (sample) => widthOf(sample, id) / settled),
    `${label} takes more than a frame or two, not a pop-in`,
  ).toBeGreaterThanOrEqual(MIN_CROSSING_MS);
}

/**
 * The traveller must be seen sliding from where the selection was to where it
 * went, wearing the join the whole way, and hand over to the destination's
 * own box (one joined box in the strip) when it lands.
 */
async function expectSelectionTravelled(
  page: Page,
  samples: ReadonlyArray<Sample>,
  route: { readonly from: string; readonly to: string },
): Promise<void> {
  const flight = samples.flatMap(({ traveller }) =>
    traveller === null ? [] : [traveller],
  );
  expect(
    flight.length,
    "traveller seen for several frames",
  ).toBeGreaterThanOrEqual(3);
  expect(
    flight.every(({ joined }) => joined),
    'traveller carries data-sheet-joined="top" throughout',
  ).toBe(true);
  const source = leftOf(itemAt(samples, 0), route.from);
  const destination = leftOf(itemAt(samples, -1), route.to);
  const departed = itemAt(flight, 0).left;
  const arrived = itemAt(flight, -1).left;
  expect(
    Math.abs(departed - source),
    "traveller sets out from the tab the selection left",
  ).toBeLessThan(Math.abs(departed - destination));
  expect(
    Math.abs(arrived - destination),
    "traveller arrives at the tab that was chosen",
  ).toBeLessThan(Math.abs(arrived - source));

  expect(itemAt(samples, -1).traveller, "traveller hidden again").toBeNull();
  await expect(
    selectedFrame(page),
    "selection landed on the destination",
  ).toHaveAttribute("data-strip-item-id", route.to);
  await expect(
    page.locator(`${SELECTORS.scroller} ${JOINED_BOX}`),
    "one joined box remains, the destination's own",
  ).toHaveCount(1);
  await expect(selectedFrame(page).locator(JOINED_BOX)).toHaveCount(1);
}

test("closing an inactive tab holds its space, then closes the gap", async ({
  page,
}) => {
  const tabIds = await openStrip(page, 5);
  const samples = await record(page, 4, () =>
    callBridge(page, "closeTask", [itemAt(tabIds, 2)]),
  );

  const closing = readClosing(samples);
  const { closed, afterIndex, before, after } = closing;
  for (const survivor of after.frames) {
    expectNear(
      survivor.left,
      leftOf(before, survivor.id),
      "no survivor moves in the first frame after the close",
    );
  }
  const spacer = onlyOne(after.ghosts, "spacer");
  expectNear(spacer.width, closed.width, "spacer as wide as the closed tab");
  expectNear(spacer.left, closed.left, "spacer where the closed tab was");

  const spacerWidths = samples.flatMap((sample) =>
    sample.ghosts.map((ghost) => ghost.width),
  );
  expect(
    spacerWidths.filter(
      (width, index) =>
        width > (spacerWidths[index - 1] ?? width) + SUBPIXEL_PX,
    ),
    "spacer only shrinks",
  ).toEqual([]);
  expect(
    crossingMs(
      samples.slice(afterIndex),
      (sample) => 1 - (sample.ghosts.at(0)?.width ?? 0) / closed.width,
    ),
    "spacer takes more than a frame or two to close, not a vanish",
  ).toBeGreaterThanOrEqual(MIN_CROSSING_MS);

  const last = itemAt(samples, -1);
  expect(last.ghosts, "spacer gone once the gap is closed").toHaveLength(0);
  expectNear(
    neighbourLeftIn(closing, last),
    closed.left,
    "the tab to the right ends where the closed tab began",
  );
});

test("a single reopen grows its slot from nothing without passing its width, slides the selection to it, and glows once it lands", async ({
  page,
}) => {
  const tabIds = await openStrip(page, 5);
  await callBridge(page, "closeTask", [itemAt(tabIds, 2)]);
  await expectResting(page, 4);
  const from = await itemIdOf(selectedFrame(page));
  const samples = await record(page, 5, () => callBridge(page, "reopen", []));
  const to = onlyOne(openedFrameIds(samples), "reopened tab");

  expectGrowsToRest(samples, to, "the reopened tab");
  await expectSelectionTravelled(page, samples, { from, to });
  expect(
    samples.some((sample) => sample.glowing),
    "the join glows after a single reopen",
  ).toBe(true);
  await expect(
    page.locator(SELECTORS.strip),
    "the glow ends on its own",
  ).not.toHaveAttribute("data-join-glow", "");
});

test("switching to another tab slides the selection to it", async ({
  page,
}) => {
  const tabIds = await openStrip(page, 5);
  const { from, to, samples } = await switchTo(page, itemAt(tabIds, 0), 5);

  await expectSelectionTravelled(page, samples, { from, to });
});

test("a reopened batch opens left to right and no slot passes its width, on the shrink layout", async ({
  page,
}) => {
  await page.addInitScript((record: { key: string; value: string }) => {
    window.localStorage.setItem(record.key, record.value);
  }, SHRINK_LAYOUT_RECORD);
  const tabIds = await openStrip(page, SHRUNK_TAB_COUNT);
  await expect(
    page.locator(SELECTORS.strip),
    "the strip is on the shrink layout",
  ).toHaveAttribute("data-tab-layout", "shrink");
  const { scrollWidth, clientWidth } = await readScroller(page);
  expect(
    scrollWidth,
    "the tabs shrink to fit instead of scrolling",
  ).toBeLessThanOrEqual(clientWidth + SUBPIXEL_PX);

  // Closing several tabs at once is one recovery entry, so one reopen brings
  // the whole batch back together.
  const batch = tabIds.slice(-SHRUNK_BATCH_SIZE).map((id) => ({
    kind: "epic",
    id,
  }));
  await callBridge(page, "closeBulk", [batch]);
  await expectResting(page, SHRUNK_TAB_COUNT - SHRUNK_BATCH_SIZE);
  const samples = await record(page, SHRUNK_TAB_COUNT, () =>
    callBridge(page, "reopen", []),
  );

  const opened = openedFrameIds(samples);
  expect(opened, "the whole batch comes back").toHaveLength(SHRUNK_BATCH_SIZE);
  opened.forEach((id, index) => {
    expectGrowsToRest(samples, id, `reopened tab ${String(index + 1)}`);
  });

  // A tab's progress is its width as a fraction of the width it settles at.
  const end = itemAt(samples, -1);
  const progressions = samples
    .map((sample) => opened.map((id) => widthOf(sample, id) / widthOf(end, id)))
    .filter((progress) => !progress.some(Number.isNaN));
  expect(
    progressions.length,
    "the tabs are drawn together for several frames",
  ).toBeGreaterThanOrEqual(3);
  expect(
    progressions.filter((progress) =>
      progress.some(
        (ahead, index) =>
          ahead < (progress[index + 1] ?? ahead) - PROGRESS_TOLERANCE,
      ),
    ),
    "each tab is at least as far along as the one after it",
  ).toEqual([]);
  expect(
    Math.max(
      ...progressions.map(
        (progress) => itemAt(progress, 0) - itemAt(progress, -1),
      ),
    ),
    "the tabs open a beat apart, not all at once",
  ).toBeGreaterThanOrEqual(0.1);
});

test("on a strip scrolled to its end, closing the last tab keeps the scroll offset and reopening it ends fully in view", async ({
  page,
}) => {
  const tabIds = await openStrip(page, OVERFLOWING_TAB_COUNT);
  await expect
    .poll(
      async () => {
        const { scrollWidth, clientWidth, scrollLeft } =
          await readScroller(page);
        return (
          scrollWidth > clientWidth &&
          scrollLeft + clientWidth >= scrollWidth - SUBPIXEL_PX
        );
      },
      { message: "the strip overflows and rests scrolled to its end" },
    )
    .toBe(true);

  const { before, after } = readClosing(
    await record(page, OVERFLOWING_TAB_COUNT - 1, () =>
      callBridge(page, "closeTask", [itemAt(tabIds, -1)]),
    ),
  );
  expect(before.scrollLeft, "the strip was scrolled").toBeGreaterThan(0);
  expect(after.ghosts, "the close leaves a spacer").toHaveLength(1);
  expectNear(
    after.scrollLeft,
    before.scrollLeft,
    "the first frame after the close keeps the scroll offset",
  );

  const reopening = await record(page, OVERFLOWING_TAB_COUNT, () =>
    callBridge(page, "reopen", []),
  );
  const end = itemAt(reopening, -1);
  const reopened = onlyOne(openedFrameIds(reopening), "reopened tab");
  const left = leftOf(end, reopened);
  expect(
    left,
    "the reopened tab is not past the left edge",
  ).toBeGreaterThanOrEqual(end.scrollLeft - SUBPIXEL_PX);
  expect(
    left + widthOf(end, reopened),
    "the reopened tab is not past the right edge",
  ).toBeLessThanOrEqual(end.scrollLeft + end.clientWidth + SUBPIXEL_PX);
});

test("under reduced motion, switching never shows the traveller, and closing a tab leaves no spacer and closes the gap at once", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const tabIds = await openStrip(page, 5);
  expect(
    await page.evaluate(
      () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
    "the page is under reduced motion",
  ).toBe(true);

  const switching = await switchTo(page, itemAt(tabIds, 0), 5);
  expect(
    switching.samples.every(({ traveller }) => traveller === null),
    "the traveller is never visible",
  ).toBe(true);

  const samples = await record(page, 4, () =>
    callBridge(page, "closeTask", [itemAt(tabIds, 2)]),
  );
  expect(
    samples.flatMap((sample) => sample.ghosts),
    "no spacer is ever drawn",
  ).toHaveLength(0);
  const closing = readClosing(samples);
  expectNear(
    neighbourLeftIn(closing, closing.after),
    closing.closed.left,
    "the tab to the right takes the closed tab's place in the first frame",
  );
});
