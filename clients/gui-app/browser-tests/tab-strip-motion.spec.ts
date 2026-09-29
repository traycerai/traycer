import {
  expect,
  test,
  type JSHandle,
  type Locator,
  type Page,
} from "@playwright/test";
import { z } from "zod";

import { fixture, nextFrames } from "./support/fixtures.ts";

// The top tab strip's motion (`src/components/layout/tabs/`): a reopened tab's
// slot grows from nothing instead of popping in (`use-strip-entrance.ts`), a
// closed tab's space is held by a spacer that shrinks away instead of jumping
// (`strip-exit-ghosts.ts`), the selected tab's sheet slides from the tab you
// left to the tab you chose (`strip-selection-travel.ts`), and a single reopen
// glows the join once it lands (`join-glow.ts`).
//
// jsdom cannot decide any of it: it lays nothing out and has no Web
// Animations, so a slot's width, the distance a survivor moves in the frame
// after a close and the traveller's box are all outside it. The claims here
// are about what a person SEES frame by frame, so each test records the
// strip's geometry on every animation frame across one gesture and asserts on
// the series. Nothing asserts a duration: a frame's width is compared with
// the width it ends at, and an ordering with the ordering it should keep, so
// a slow runner draws fewer frames of the same motion and still passes. The
// one time bound is a floor that only a starved runner can help: motion that
// took longer than a frame or two, which sparse frames stretch, never shrink.
//
// The strip is the production `TabStrip`, coordinator and recovery history,
// mounted by `tab-recovery.tsx` (which `scripts/tab-recovery-browser-
// regression.mjs` drives for recovery semantics); this spec drives its
// `window.__traycerTabRecovery` bridge for the gestures.

const STRIP = '[data-testid="tab-strip"]';
const SCROLLER = '[data-testid="header-tab-strip-scroll"]';
const TRAVELLER = '[data-testid="tab-selection-traveller"]';
const SELECTED_TAB = '[role="tab"][aria-selected="true"]';
const JOINED_BOX = '[data-sheet-joined="top"]';

// The sheet join, and so the traveller that carries it, only exists from md
// (48rem); this is comfortably past it and wide enough for several tabs.
test.use({ viewport: { width: 1300, height: 360 }, deviceScaleFactor: 1 });

/** Layout rounding and sub-pixel snapping, not motion. */
const SUBPIXEL_PX = 1;
/** The same, for a tab's progress as a fraction of its width. */
const PROGRESS_TOLERANCE = 0.03;
/**
 * The least time a slot may take to cross from 5% to 95% of the way. They take
 * about 150ms, and a pop-in a frame or two, so this sits between the two.
 */
const MIN_CROSSING_MS = 60;
/** Ten tabs are wider than the strip at the tab's narrowest (about 192px). */
const OVERFLOWING_TAB_COUNT = 10;
/** Twelve tabs shrunk to fit the strip, where they would overflow if scrolled. */
const SHRUNK_TAB_COUNT = 12;
/**
 * The stagger between reopened tabs is capped at 240ms, and a slot opens in
 * 320ms, so a batch this large has its last slots still shut when the first
 * is fully open. That is what holding the early ones at their width is for,
 * and a shorter batch is over too soon to tell.
 */
const SHRUNK_BATCH_SIZE = 9;
/**
 * `arrangement.taskTabLayout: "shrink"` in the layout store's persisted shape,
 * seeded before the page loads because the fixture has no setter for it. The
 * key and version are `layout-store.ts`'s (`persistKey(STORE_KEYS.layout)`,
 * `LAYOUT_PERSIST_VERSION`); if they drift the shrink test fails on its
 * premise (the strip's `data-tab-layout`), not silently on the scroll layout.
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

// ── Recording ─────────────────────────────────────────────────────────────

interface Member {
  readonly kind: "frame" | "ghost";
  readonly id: string;
  /** In the scroller's content coordinates, so a scroll is not a move. */
  readonly left: number;
  readonly width: number;
}

interface Sample {
  /**
   * The frame's own timestamp, which is the time animations are sampled at. A
   * starved page can run a frame late and catch its animations up, so the
   * clock at the callback would put the jump in the wrong place.
   */
  readonly time: number;
  readonly scrollLeft: number;
  readonly clientWidth: number;
  readonly members: ReadonlyArray<Member>;
  readonly travellerVisible: boolean;
  readonly travellerJoined: boolean;
  readonly travellerLeft: number;
  readonly glowing: boolean;
}

interface Recorder {
  readonly stop: () => Sample[];
}

/**
 * Starts sampling the strip: one sample now and one on every animation frame
 * until `stop()`. Sampling is page-side, so a gesture's frames are not lost to
 * the round trips of the test driving it.
 */
function startRecording(page: Page): Promise<JSHandle<Recorder>> {
  return page.evaluateHandle(
    (selectors: {
      readonly strip: string;
      readonly scroller: string;
      readonly traveller: string;
    }): Recorder => {
      const strip = document.querySelector(selectors.strip);
      const scroller = document.querySelector(selectors.scroller);
      if (!(strip instanceof HTMLElement) || !(scroller instanceof HTMLElement))
        throw new Error("the tab strip is missing");
      const identityOf = (
        child: HTMLElement,
      ): Pick<Member, "kind" | "id"> | null => {
        const { stripItemId, stripExitGhost } = child.dataset;
        if (stripItemId !== undefined)
          return { kind: "frame", id: stripItemId };
        if (stripExitGhost !== undefined)
          return { kind: "ghost", id: stripExitGhost };
        return null;
      };
      const samples: Sample[] = [];
      let recording = true;
      const capture = (time: number): void => {
        const view = scroller.getBoundingClientRect();
        const members: Member[] = [];
        for (const child of scroller.children) {
          if (!(child instanceof HTMLElement)) continue;
          const identity = identityOf(child);
          if (identity === null) continue;
          const box = child.getBoundingClientRect();
          members.push({
            ...identity,
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
          members,
          travellerVisible: !traveller.hidden && travellerBox.width > 0,
          travellerJoined:
            traveller.getAttribute("data-sheet-joined") === "top",
          travellerLeft: travellerBox.left - view.left + scroller.scrollLeft,
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
    { strip: STRIP, scroller: SCROLLER, traveller: TRAVELLER },
  );
}

function stopRecording(recorder: JSHandle<Recorder>): Promise<Sample[]> {
  return recorder.evaluate((handle) => handle.stop());
}

/**
 * Whether the strip holds `frames` tabs and has come to rest: no spacer, no
 * running animation (a slot that is opening, or held open for the rest of its
 * batch, is one) and no traveller in flight. It is the wait for a gesture's
 * motion to be over, and the proof the gesture landed at all.
 */
function isResting(page: Page, frames: number): Promise<boolean> {
  return page.evaluate(
    (input: {
      readonly scroller: string;
      readonly traveller: string;
      readonly frames: number;
    }) => {
      const scroller = document.querySelector(input.scroller);
      if (!(scroller instanceof HTMLElement)) return false;
      const traveller = scroller.querySelector(input.traveller);
      return (
        scroller.querySelectorAll(":scope > [data-strip-item-id]").length ===
          input.frames &&
        scroller.querySelector("[data-strip-exit-ghost]") === null &&
        scroller.getAnimations({ subtree: true }).length === 0 &&
        traveller instanceof HTMLElement &&
        traveller.hidden !== false
      );
    },
    { scroller: SCROLLER, traveller: TRAVELLER, frames },
  );
}

async function expectResting(page: Page, frames: number): Promise<void> {
  await expect
    .poll(() => isResting(page, frames), {
      message: `the strip must come to rest with ${String(frames)} tabs`,
    })
    .toBe(true);
}

// ── The fixture's bridge ──────────────────────────────────────────────────

const SnapshotSchema = z.object({
  headerTabs: z.array(
    z.object({ kind: z.string(), id: z.string(), name: z.string() }),
  ),
});

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
      if (typeof bridge !== "object" || bridge === null)
        throw new Error("the tab recovery bridge is missing");
      const operation: unknown = Reflect.get(bridge, call.method);
      if (typeof operation !== "function")
        throw new Error(`the bridge has no ${call.method}`);
      const result: unknown = await Reflect.apply(operation, bridge, [
        ...call.args,
      ]);
      return result;
    },
    { method, args },
  );
}

/** Loads the strip and opens `count` tasks named `Task 1` and on, the last active. */
async function openStrip(page: Page, count: number): Promise<string[]> {
  await page.goto(fixture("tab-recovery"));
  await page.waitForFunction(
    () => Reflect.get(window, "__traycerTabRecovery") !== undefined,
  );
  await callBridge(page, "reset", []);
  const tabIds: string[] = [];
  for (let number = 1; number <= count; number += 1) {
    tabIds.push(
      z
        .string()
        .parse(await callBridge(page, "createTask", [`Task ${number}`])),
    );
  }
  await expectResting(page, count);
  return tabIds;
}

function tabAt(tabIds: ReadonlyArray<string>, index: number): string {
  const tabId = tabIds.at(index);
  if (tabId === undefined) throw new Error(`no tab at ${String(index)}`);
  return tabId;
}

function frameOf(page: Page, tabId: string): Locator {
  return page
    .locator(`${SCROLLER} > [data-strip-item-id]`)
    .filter({ has: page.getByTestId(`tab-title-epic-${tabId}`) });
}

async function frameIdOf(page: Page, tabId: string): Promise<string> {
  const itemId = await frameOf(page, tabId).getAttribute("data-strip-item-id");
  if (itemId === null) throw new Error(`tab ${tabId} has no frame`);
  return itemId;
}

function closeTab(page: Page, tabId: string): Promise<unknown> {
  return callBridge(page, "closeTask", [tabId]);
}

/** Opens a tab overflowing the strip, resting on its last (active) tab. */
async function openOverflowingStrip(page: Page): Promise<string[]> {
  const tabIds = await openStrip(page, OVERFLOWING_TAB_COUNT);
  await expect
    .poll(
      () =>
        page.evaluate(
          (input: {
            readonly selector: string;
            readonly tolerance: number;
          }) => {
            const scroller = document.querySelector(input.selector);
            if (!(scroller instanceof HTMLElement)) return false;
            return (
              scroller.scrollWidth > scroller.clientWidth &&
              scroller.scrollLeft + scroller.clientWidth >=
                scroller.scrollWidth - input.tolerance
            );
          },
          { selector: SCROLLER, tolerance: SUBPIXEL_PX },
        ),
      {
        message:
          "the strip must overflow and rest scrolled to its last tab, or nothing below is about a scrolled strip",
      },
    )
    .toBe(true);
  return tabIds;
}

// ── Reading a series ──────────────────────────────────────────────────────

function frameIn(sample: Sample, id: string): Member | undefined {
  return sample.members.find(
    (member) => member.kind === "frame" && member.id === id,
  );
}

function ghostsIn(sample: Sample): ReadonlyArray<Member> {
  return sample.members.filter((member) => member.kind === "ghost");
}

/** The index of the first sample the closed tab's frame is gone from. */
function firstSampleWithoutFrame(
  samples: ReadonlyArray<Sample>,
  id: string,
): number {
  const index = samples.findIndex(
    (sample) => frameIn(sample, id) === undefined,
  );
  expect(
    index,
    "the recording must hold a sample from before the close and one from after",
  ).toBeGreaterThan(0);
  return index;
}

function sampleAt(samples: ReadonlyArray<Sample>, index: number): Sample {
  const sample = samples.at(index);
  if (sample === undefined) throw new Error(`no sample at ${String(index)}`);
  return sample;
}

/** The frames a gesture added, left to right as they end up. */
function openedFrameIds(samples: ReadonlyArray<Sample>): string[] {
  const before = new Set(
    sampleAt(samples, 0).members.map((member) => member.id),
  );
  const last = sampleAt(samples, -1);
  return last.members
    .filter((member) => member.kind === "frame" && !before.has(member.id))
    .toSorted((first, second) => first.left - second.left)
    .map((member) => member.id);
}

/** The one frame a single reopen adds. */
function reopenedFrameId(samples: ReadonlyArray<Sample>): string {
  const opened = openedFrameIds(samples);
  expect(opened, "a single reopen adds a single tab").toHaveLength(1);
  const reopenedId = opened.at(0);
  if (reopenedId === undefined) throw new Error("no tab was reopened");
  return reopenedId;
}

interface Reading {
  readonly time: number;
  readonly value: number;
}

/** A frame's width in every sample it appears in, in order. */
function widthSeriesOf(samples: ReadonlyArray<Sample>, id: string): Reading[] {
  return samples.flatMap((sample) => {
    const frame = frameIn(sample, id);
    return frame === undefined
      ? []
      : [{ time: sample.time, value: frame.width }];
  });
}

/**
 * How long a 0 to 1 series took to get from 5% to 95%: from the last frame
 * still short of the band to the first one past it. Sparse frames widen the
 * gap between the two, so a starved runner only ever makes this longer.
 */
function crossingMs(done: ReadonlyArray<Reading>): number {
  const short = done.findLast((reading) => reading.value <= 0.05);
  const past = done.find((reading) => reading.value >= 0.95);
  return short === undefined || past === undefined ? 0 : past.time - short.time;
}

function lastOf(values: ReadonlyArray<number>): number {
  const value = values.at(-1);
  if (value === undefined) throw new Error("no values");
  return value;
}

/**
 * What an opening slot must do: appear at nothing, only ever grow, never
 * pass the width it settles at (a slot that overshoots pushes its neighbours
 * out and back), and take several frames about it rather than popping.
 */
function expectGrowsToRest(
  series: ReadonlyArray<Reading>,
  label: string,
): void {
  const widths = series.map((reading) => reading.value);
  const settled = lastOf(widths);
  expect(settled, `${label} must end as a real tab`).toBeGreaterThan(40);
  expect(
    widths[0],
    `${label} must first be drawn at nothing (drawn at ${String(widths[0])}px of ${String(settled)}px)`,
  ).toBeLessThanOrEqual(SUBPIXEL_PX);
  expect(
    Math.max(...widths),
    `${label} must never pass the width it settles at`,
  ).toBeLessThanOrEqual(settled + SUBPIXEL_PX);
  widths.forEach((width, index) => {
    if (index === 0) return;
    expect(
      width,
      `${label} must only grow (frame ${String(index)}: ${String(widths[index - 1])}px then ${String(width)}px)`,
    ).toBeGreaterThanOrEqual((widths[index - 1] ?? 0) - SUBPIXEL_PX);
  });
  expect(
    crossingMs(
      series.map(({ time, value }) => ({ time, value: value / settled })),
    ),
    `${label} must take longer than a frame or two to open, not pop in`,
  ).toBeGreaterThanOrEqual(MIN_CROSSING_MS);
}

// ── Closing ───────────────────────────────────────────────────────────────

test("closing an inactive tab holds its space at first, then closes the gap", async ({
  page,
}) => {
  const tabIds = await openStrip(page, 5);
  const closedId = await frameIdOf(page, tabAt(tabIds, 2));
  const recorder = await startRecording(page);
  await closeTab(page, tabAt(tabIds, 2));
  await expectResting(page, 4);
  const samples = await stopRecording(recorder);

  const afterIndex = firstSampleWithoutFrame(samples, closedId);
  const before = sampleAt(samples, afterIndex - 1);
  const after = sampleAt(samples, afterIndex);
  const closed = frameIn(before, closedId);
  if (closed === undefined) throw new Error("the closed frame was not drawn");

  for (const survivor of after.members.filter(
    (member) => member.kind === "frame",
  )) {
    const was = frameIn(before, survivor.id);
    expect(
      Math.abs(survivor.left - (was?.left ?? Number.NaN)),
      `a survivor must not move in the first frame after the close (was ${String(was?.left)}px, now ${String(survivor.left)}px)`,
    ).toBeLessThanOrEqual(SUBPIXEL_PX);
  }
  const spacers = ghostsIn(after);
  expect(spacers, "one closed tab leaves one spacer").toHaveLength(1);
  const spacer = spacers.at(0);
  if (spacer === undefined) throw new Error("no spacer");
  expect(
    Math.abs(spacer.width - closed.width),
    `the spacer must be as wide as the closed tab (${String(spacer.width)}px, tab ${String(closed.width)}px)`,
  ).toBeLessThanOrEqual(SUBPIXEL_PX);
  expect(
    Math.abs(spacer.left - closed.left),
    "the spacer must sit where the closed tab was",
  ).toBeLessThanOrEqual(SUBPIXEL_PX);

  const spacerWidths = samples.flatMap((sample) =>
    ghostsIn(sample).map((ghost) => ghost.width),
  );
  spacerWidths.forEach((width, index) => {
    expect(width, "the spacer must only shrink").toBeLessThanOrEqual(
      (spacerWidths[index - 1] ?? width) + SUBPIXEL_PX,
    );
  });
  expect(
    crossingMs(
      samples.slice(afterIndex).map((sample) => ({
        time: sample.time,
        value: 1 - (ghostsIn(sample).at(0)?.width ?? 0) / closed.width,
      })),
    ),
    "the spacer must take longer than a frame or two to close, not vanish",
  ).toBeGreaterThanOrEqual(MIN_CROSSING_MS);

  const last = sampleAt(samples, -1);
  expect(
    ghostsIn(last),
    "the spacer must be gone once the gap is closed",
  ).toHaveLength(0);
  const neighbour = before.members.find(
    (member) => member.kind === "frame" && member.left > closed.left,
  );
  if (neighbour === undefined)
    throw new Error("the closed tab must have had a neighbour to its right");
  expect(
    Math.abs((frameIn(last, neighbour.id)?.left ?? Number.NaN) - closed.left),
    "the tab to the right must end where the closed tab began",
  ).toBeLessThanOrEqual(SUBPIXEL_PX);
});

// ── Reopening one tab ─────────────────────────────────────────────────────

/** The frame holding the selected tab: the one whose box the sheet joins. */
function selectedFrame(page: Page): Locator {
  return page
    .locator(`${SCROLLER} > [data-strip-item-id]`)
    .filter({ has: page.locator(SELECTED_TAB) });
}

async function selectedFrameId(page: Page): Promise<string> {
  const itemId = await selectedFrame(page).getAttribute("data-strip-item-id");
  if (itemId === null) throw new Error("no tab is selected");
  return itemId;
}

/** Opens five tabs and closes the third, which is not the selected one. */
async function openStripWithMiddleTabClosed(page: Page): Promise<void> {
  const tabIds = await openStrip(page, 5);
  await closeTab(page, tabAt(tabIds, 2));
  await expectResting(page, 4);
}

async function reopenAndRecord(
  page: Page,
  framesAfter: number,
): Promise<Sample[]> {
  const recorder = await startRecording(page);
  await callBridge(page, "reopen", []);
  await expectResting(page, framesAfter);
  return stopRecording(recorder);
}

test("a reopened tab grows from nothing to its width without passing it", async ({
  page,
}) => {
  await openStripWithMiddleTabClosed(page);
  const samples = await reopenAndRecord(page, 5);

  expectGrowsToRest(
    widthSeriesOf(samples, reopenedFrameId(samples)),
    "the reopened tab",
  );
});

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
  const flying = samples.filter((sample) => sample.travellerVisible);
  expect(
    flying.length,
    "the traveller must be visible for several frames of the switch",
  ).toBeGreaterThanOrEqual(3);
  expect(
    flying.every((sample) => sample.travellerJoined),
    'the traveller must carry data-sheet-joined="top" while it is visible',
  ).toBe(true);

  const start = sampleAt(samples, 0);
  const end = sampleAt(samples, -1);
  const source = frameIn(start, route.from)?.left ?? Number.NaN;
  const destination = frameIn(end, route.to)?.left ?? Number.NaN;
  const departed = flying[0]?.travellerLeft ?? Number.NaN;
  const arrived = flying.at(-1)?.travellerLeft ?? Number.NaN;
  expect(
    Math.abs(departed - source),
    `the traveller must set out from the tab the selection left (set out at ${String(departed)}px, tab at ${String(source)}px, destination at ${String(destination)}px)`,
  ).toBeLessThan(Math.abs(departed - destination));
  expect(
    Math.abs(arrived - destination),
    `the traveller must arrive at the tab that was chosen (arrived at ${String(arrived)}px, destination at ${String(destination)}px, source at ${String(source)}px)`,
  ).toBeLessThan(Math.abs(arrived - source));

  expect(end.travellerVisible, "the traveller must be hidden again").toBe(
    false,
  );
  await expect(
    selectedFrame(page),
    "the selection must have landed on the destination",
  ).toHaveAttribute("data-strip-item-id", route.to);
  await expect(
    page.locator(`${SCROLLER} ${JOINED_BOX}`),
    "exactly one joined box must remain, the destination's own",
  ).toHaveCount(1);
  await expect(selectedFrame(page).locator(JOINED_BOX)).toHaveCount(1);
}

test("a reopened tab is reached by the selection sliding to it, then joins the sheet itself", async ({
  page,
}) => {
  await openStripWithMiddleTabClosed(page);
  const leftFrameId = await selectedFrameId(page);
  const samples = await reopenAndRecord(page, 5);

  await expectSelectionTravelled(page, samples, {
    from: leftFrameId,
    to: reopenedFrameId(samples),
  });
});

test("a single reopen glows the join once it lands, then stops", async ({
  page,
}) => {
  await openStripWithMiddleTabClosed(page);
  const recorder = await startRecording(page);
  await callBridge(page, "reopen", []);
  await expectResting(page, 5);
  // The glow starts a frame after the selection lands, which is when the
  // strip comes to rest.
  await nextFrames(page, 5);
  const samples = await stopRecording(recorder);

  expect(
    samples.some((sample) => sample.glowing),
    "the strip must glow the join after a single reopen",
  ).toBe(true);
  await expect(
    page.locator(STRIP),
    "the glow must end on its own",
  ).not.toHaveAttribute("data-join-glow", "");
});

// ── Switching ─────────────────────────────────────────────────────────────

test("switching to another tab slides the selection to it", async ({
  page,
}) => {
  const tabIds = await openStrip(page, 5);
  const fromId = await selectedFrameId(page);
  const toId = await frameIdOf(page, tabAt(tabIds, 0));
  const recorder = await startRecording(page);
  await page.getByTestId(`tab-title-epic-${tabAt(tabIds, 0)}`).click();
  await expect(selectedFrame(page)).toHaveAttribute("data-strip-item-id", toId);
  await expectResting(page, 5);
  const samples = await stopRecording(recorder);

  await expectSelectionTravelled(page, samples, { from: fromId, to: toId });
});

// ── Reopening several tabs ────────────────────────────────────────────────

/**
 * Closes the last `batch` of `count` tabs in one gesture and reopens them,
 * recording the reopen. Closing several tabs at once is one recovery entry,
 * so one reopen brings the whole batch back together.
 */
async function reopenBatchAndRecord(
  page: Page,
  count: number,
  batch: number,
): Promise<Sample[]> {
  const snapshot = SnapshotSchema.parse(await callBridge(page, "snapshot", []));
  const refs = snapshot.headerTabs
    .slice(-batch)
    .map(({ kind, id }) => ({ kind, id }));
  await callBridge(page, "closeBulk", [refs]);
  await expectResting(page, count - batch);
  return reopenAndRecord(page, count);
}

/**
 * A batch opens left to right, a beat apart, and every slot is held at its
 * width until the last one is open. So each grows to rest without passing its
 * width, and at every frame the one before is at least as far along.
 */
function expectOpenedInTurn(
  samples: ReadonlyArray<Sample>,
  batch: number,
): void {
  const opened = openedFrameIds(samples);
  expect(
    opened,
    `the reopen must bring ${String(batch)} tabs back`,
  ).toHaveLength(batch);
  opened.forEach((id, index) => {
    expectGrowsToRest(
      widthSeriesOf(samples, id),
      `reopened tab ${String(index + 1)}`,
    );
  });

  const settled = opened.map(
    (id) => frameIn(sampleAt(samples, -1), id)?.width ?? Number.NaN,
  );
  const progressions = samples.flatMap((sample) => {
    const progress = opened.map(
      (id, index) =>
        (frameIn(sample, id)?.width ?? Number.NaN) / (settled[index] ?? 1),
    );
    return progress.some(Number.isNaN) ? [] : [progress];
  });
  expect(
    progressions.length,
    "the tabs must be drawn together for several frames",
  ).toBeGreaterThanOrEqual(3);
  for (const progress of progressions) {
    progress.forEach((ahead, index) => {
      const behind = progress.at(index + 1);
      if (behind === undefined) return;
      expect(
        ahead,
        `tab ${String(index + 1)} must be at least as far along as tab ${String(index + 2)} (${String(ahead)} against ${String(behind)})`,
      ).toBeGreaterThanOrEqual(behind - PROGRESS_TOLERANCE);
    });
  }
  const widestLead = Math.max(
    ...progressions.map((progress) => {
      const first = progress.at(0);
      const last = progress.at(-1);
      return (first ?? Number.NaN) - (last ?? Number.NaN);
    }),
  );
  expect(
    widestLead,
    "the tabs must open a beat apart, not all at once",
  ).toBeGreaterThanOrEqual(0.1);
}

test("a reopened batch opens left to right, and no slot passes its width", async ({
  page,
}) => {
  await openStrip(page, 6);
  expectOpenedInTurn(await reopenBatchAndRecord(page, 6, 3), 3);
});

test("a reopened batch opens the same way when the tabs shrink to fit", async ({
  page,
}) => {
  await page.addInitScript((record: { key: string; value: string }) => {
    window.localStorage.setItem(record.key, record.value);
  }, SHRINK_LAYOUT_RECORD);
  await openStrip(page, SHRUNK_TAB_COUNT);
  await expect(
    page.locator(STRIP),
    "the strip must be on the shrink layout",
  ).toHaveAttribute("data-tab-layout", "shrink");
  const fits = await page.evaluate((selector: string) => {
    const scroller = document.querySelector(selector);
    return (
      scroller instanceof HTMLElement &&
      scroller.scrollWidth <= scroller.clientWidth + 1
    );
  }, SCROLLER);
  expect(fits, "the tabs must shrink to fit instead of scrolling").toBe(true);

  expectOpenedInTurn(
    await reopenBatchAndRecord(page, SHRUNK_TAB_COUNT, SHRUNK_BATCH_SIZE),
    SHRUNK_BATCH_SIZE,
  );
});

// ── A scrolling strip ─────────────────────────────────────────────────────

test("closing the last tab of a strip scrolled to its end keeps the scroll offset", async ({
  page,
}) => {
  const tabIds = await openOverflowingStrip(page);
  const lastTabId = tabAt(tabIds, -1);
  const closedId = await frameIdOf(page, lastTabId);
  const recorder = await startRecording(page);
  await closeTab(page, lastTabId);
  await expectResting(page, OVERFLOWING_TAB_COUNT - 1);
  const samples = await stopRecording(recorder);

  const afterIndex = firstSampleWithoutFrame(samples, closedId);
  const before = sampleAt(samples, afterIndex - 1);
  const after = sampleAt(samples, afterIndex);
  expect(
    before.scrollLeft,
    "the strip must have been scrolled",
  ).toBeGreaterThan(0);
  expect(
    ghostsIn(after),
    "the close must leave a spacer holding the closed tab's space",
  ).toHaveLength(1);
  expect(
    Math.abs(after.scrollLeft - before.scrollLeft),
    `the first frame after the close must keep the scroll offset (was ${String(before.scrollLeft)}px, now ${String(after.scrollLeft)}px)`,
  ).toBeLessThanOrEqual(SUBPIXEL_PX);
});

test("a tab reopened at the end of a scrolling strip ends fully in view", async ({
  page,
}) => {
  const tabIds = await openOverflowingStrip(page);
  await closeTab(page, tabAt(tabIds, -1));
  await expectResting(page, OVERFLOWING_TAB_COUNT - 1);
  const samples = await reopenAndRecord(page, OVERFLOWING_TAB_COUNT);

  const end = sampleAt(samples, -1);
  const reopened = frameIn(end, reopenedFrameId(samples));
  if (reopened === undefined) throw new Error("the reopened tab is not drawn");
  expect(
    reopened.left,
    "the reopened tab must not end past the strip's left edge",
  ).toBeGreaterThanOrEqual(end.scrollLeft - SUBPIXEL_PX);
  expect(
    reopened.left + reopened.width,
    "the reopened tab must not end past the strip's right edge",
  ).toBeLessThanOrEqual(end.scrollLeft + end.clientWidth + SUBPIXEL_PX);
});

// ── Reduced motion ────────────────────────────────────────────────────────

test.describe("with reduced motion", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  test("switching to another tab never shows the traveller", async ({
    page,
  }) => {
    const tabIds = await openStrip(page, 5);
    const premise = await page.evaluate(
      () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    );
    expect(premise, "the page must be under reduced motion").toBe(true);
    const toId = await frameIdOf(page, tabAt(tabIds, 0));
    const recorder = await startRecording(page);
    await page.getByTestId(`tab-title-epic-${tabAt(tabIds, 0)}`).click();
    await expect(selectedFrame(page)).toHaveAttribute(
      "data-strip-item-id",
      toId,
    );
    await nextFrames(page, 5);
    const samples = await stopRecording(recorder);

    expect(
      samples.some((sample) => sample.travellerVisible),
      "the traveller must never be visible under reduced motion",
    ).toBe(false);
  });

  test("closing a tab leaves no spacer and closes the gap at once", async ({
    page,
  }) => {
    const tabIds = await openStrip(page, 5);
    const closedId = await frameIdOf(page, tabAt(tabIds, 2));
    const recorder = await startRecording(page);
    await closeTab(page, tabAt(tabIds, 2));
    await expectResting(page, 4);
    await nextFrames(page, 3);
    const samples = await stopRecording(recorder);

    const afterIndex = firstSampleWithoutFrame(samples, closedId);
    expect(
      samples.flatMap(ghostsIn),
      "no spacer may ever be drawn under reduced motion",
    ).toHaveLength(0);
    const before = sampleAt(samples, afterIndex - 1);
    const closed = frameIn(before, closedId);
    const neighbour = before.members.find(
      (member) =>
        member.kind === "frame" && member.left > (closed?.left ?? Infinity),
    );
    if (closed === undefined || neighbour === undefined)
      throw new Error("the closed tab must have had a neighbour to its right");
    expect(
      Math.abs(
        (frameIn(sampleAt(samples, afterIndex), neighbour.id)?.left ??
          Number.NaN) - closed.left,
      ),
      "the tab to the right must take the closed tab's place in the first frame",
    ).toBeLessThanOrEqual(SUBPIXEL_PX);
  });
});
