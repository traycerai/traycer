import { expect, type Page } from "@playwright/test";
import { fixture } from "./fixtures.ts";
/**
 * Driving and reading the chat tree's row motion fixture
 * (`src/__tests__/browser/chat-tree-motion.tsx`): the REAL `ChatTreePanelBody`
 * over a seeded store, whose probe records every drawn row's box and opacity
 * once per animation frame across a change.
 */
export interface Shape {
  readonly roots: readonly string[];
  readonly children: Readonly<Record<string, readonly string[]>>;
  /** An id's activity time, 1 when unlisted: newer sorts first, ties by id. */
  readonly updatedAt: Readonly<Record<string, number>> | undefined;
}
/** A cloud chat of the task; `parentId` makes it a subagent of that cloud chat. */
export interface CloudSpec {
  readonly id: string;
  readonly parentId: string | null;
}
/**
 * A row's box and drawn opacity. A group rail is `rail:` and the row key of
 * the row that owns it (`rail:local:b` for local chat `b`).
 */
export interface RowSample {
  readonly id: string;
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly opacity: number;
}
/** One entry per frame; the first is sampled before the change. */
export type Recording = RowSample[][];
interface Probe {
  readonly ready: boolean;
  readonly errors: string[];
  readonly setShape: (shape: Shape) => void;
  readonly recordShape: (shape: Shape, frames: number) => Promise<Recording>;
  readonly recordHide: (
    shape: Shape,
    kept: readonly string[],
    frames: number,
  ) => Promise<Recording>;
  readonly recordScroll: (top: number, frames: number) => Promise<Recording>;
  readonly recordChevron: (id: string, frames: number) => Promise<Recording>;
  readonly scrollTo: (top: number) => void;
  readonly scrollTop: () => number;
  readonly viewport: () => { readonly top: number; readonly bottom: number };
  readonly seedCloudChats: (specs: readonly CloudSpec[]) => void;
  readonly replaceCloudChats: (specs: readonly CloudSpec[]) => number;
  readonly recordCloud: (
    specs: readonly CloudSpec[],
    frames: number,
  ) => Promise<Recording>;
}
declare global {
  interface Window {
    __chatTreeMotion?: Probe;
  }
}
export const ROOTS: readonly string[] = [
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
];
/** Eight roots, the second an open branch of three. */
export const BASE: Shape = {
  roots: ROOTS,
  children: { b: ["b1", "b2", "b3"] },
  updatedAt: undefined,
};
/** One row with its gap: where the next row begins. */
export const ROW_PITCH = 30;
/** What a group of `rows` rows takes: the first has no gap before it. */
export function groupHeight(rows: number): number {
  return ROW_PITCH * rows - 2;
}
/** Roots drawn above and below the rows a test is about, when it runs scrolled. */
export const FILLER_ROWS = 30;
function fillerIds(prefix: string): string[] {
  return Array.from(
    { length: FILLER_ROWS },
    (_, i) => `${prefix}${String(i).padStart(2, "0")}`,
  );
}
/**
 * `shape` between two runs of filler roots (ids sort digits first, `z` last),
 * for a test that runs with the list scrolled so that `shape`'s first row is
 * the one at the top of the viewport (`SCROLLED_TOP`).
 */
export function padded(shape: Shape): Shape {
  return {
    ...shape,
    roots: [...fillerIds("0"), ...shape.roots, ...fillerIds("z")],
  };
}
/** The scroll that puts the first row after the leading fillers at the top. */
export const SCROLLED_TOP = FILLER_ROWS * ROW_PITCH;
/**
 * The fewest frames a recording takes. It is a floor: the fixture keeps
 * sampling until its time window, which covers a fade and the slide after it,
 * has also passed, so a faster display records more frames, not less motion.
 */
export const FRAMES = 40;
/**
 * Loads the fixture and settles `shape` as the tree, then scrolls the list to
 * `scrollTop` (0: not at all) and waits for the row `shown` to be drawn there.
 */
export async function openTree(
  page: Page,
  shape: Shape,
  scrollTop: number,
  shown: string,
): Promise<void> {
  await page.goto(fixture("chat-tree-motion"));
  await page.waitForFunction(() => window.__chatTreeMotion?.ready === true);
  await page.evaluate((s) => {
    const probe = window.__chatTreeMotion;
    if (probe === undefined) throw new Error("no probe");
    probe.setShape(s);
  }, shape);
  await expect(
    page.getByTestId(`epic-sidebar-item-${shape.roots[0]}`),
  ).toBeVisible();
  if (scrollTop > 0) {
    await page.evaluate((top) => {
      const probe = window.__chatTreeMotion;
      if (probe === undefined) throw new Error("no probe");
      probe.scrollTo(top);
    }, scrollTop);
    await page.waitForFunction(
      (top) => window.__chatTreeMotion?.scrollTop() === top,
      scrollTop,
    );
  }
  await expect(page.getByTestId(`epic-sidebar-item-${shown}`)).toBeVisible();
  await settled(page);
}

/**
 * Waits until every motion in the tree has come to rest: no element under the
 * tree carries an inline transform, and no row or rail is drawn at less than
 * full opacity (its own times every ancestor's). Playwright's timeout bounds
 * it; there is no frame count.
 */
export async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const tree = document.querySelector('[role="tree"]');
    if (tree === null) return false;
    for (const element of tree.querySelectorAll<HTMLElement>("*")) {
      const { transform } = element.style;
      if (transform !== "" && transform !== "none") return false;
    }
    const drawnParts = tree.querySelectorAll<HTMLElement>(
      '[data-testid^="epic-sidebar-item-"], [data-testid^="epic-sidebar-cloud-item-"], [data-tree-guide-for]',
    );
    for (const part of drawnParts) {
      let opacity = 1;
      for (
        let el: HTMLElement | null = part;
        el !== null && el !== document.body;
        el = el.parentElement
      ) {
        opacity *= Number(getComputedStyle(el).opacity);
      }
      if (opacity < 1) return false;
    }
    return true;
  });
}

/** The scroller's box, where the rows in view lie. */
export interface View {
  readonly top: number;
  readonly bottom: number;
}
export function viewOf(page: Page): Promise<View> {
  return page.evaluate(() => {
    const probe = window.__chatTreeMotion;
    if (probe === undefined) throw new Error("no probe");
    return probe.viewport();
  });
}
/** The scroll offset the list is at. */
export function scrollTopOf(page: Page): Promise<number> {
  return page.evaluate(() => window.__chatTreeMotion?.scrollTop() ?? -1);
}

/** The ids of the rows wholly inside `view` before the change. */
export function rowsInView(recording: Recording, view: View): string[] {
  return recording[0]
    .filter(
      (row) =>
        !row.id.startsWith("rail:") &&
        row.top >= view.top &&
        row.bottom <= view.bottom,
    )
    .map((row) => row.id);
}

/** `specs` as the task's cloud chats; the rows follow once the list is fetched. */
export async function seedCloud(
  page: Page,
  specs: readonly CloudSpec[],
): Promise<void> {
  await page.evaluate((list) => {
    const probe = window.__chatTreeMotion;
    if (probe === undefined) throw new Error("no probe");
    probe.seedCloudChats(list);
  }, specs);
}

/** `specs` as the task's cloud chats, written into the cached list at once. */
export function recordCloud(
  page: Page,
  specs: readonly CloudSpec[],
): Promise<Recording> {
  return page.evaluate(
    ([list, frames]) => {
      const probe = window.__chatTreeMotion;
      if (probe === undefined) throw new Error("no probe");
      return probe.recordCloud(list, frames);
    },
    [specs, FRAMES] as const,
  );
}
export function recordShape(page: Page, next: Shape): Promise<Recording> {
  return page.evaluate(
    ([shape, frames]) => {
      const probe = window.__chatTreeMotion;
      if (probe === undefined) throw new Error("no probe");
      return probe.recordShape(shape, frames);
    },
    [next, FRAMES] as const,
  );
}
/** `next` with `kept` still in the store: what a filter or the archive does. */
export function recordHide(
  page: Page,
  next: Shape,
  kept: readonly string[],
): Promise<Recording> {
  return page.evaluate(
    ([shape, ids, frames]) => {
      const probe = window.__chatTreeMotion;
      if (probe === undefined) throw new Error("no probe");
      return probe.recordHide(shape, ids, frames);
    },
    [next, kept, FRAMES] as const,
  );
}
export function recordChevron(page: Page, id: string): Promise<Recording> {
  return page.evaluate(
    ([target, frames]) => {
      const probe = window.__chatTreeMotion;
      if (probe === undefined) throw new Error("no probe");
      return probe.recordChevron(target, frames);
    },
    [id, FRAMES] as const,
  );
}
export function recordScroll(page: Page, top: number): Promise<Recording> {
  return page.evaluate(
    ([offset, frames]) => {
      const probe = window.__chatTreeMotion;
      if (probe === undefined) throw new Error("no probe");
      return probe.recordScroll(offset, frames);
    },
    [top, FRAMES] as const,
  );
}
/** Errors the page raised, the fixture's own and the browser's. */
export async function pageErrors(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => window.__chatTreeMotion?.errors ?? []);
}
/** Sub-pixel layout rounding, not motion. */
const SUBPIXEL_PX = 1;
/** An opacity this low is a row that has faded out. */
const FADED = 0.05;
/** Every sample of row `id`, with the frame it was drawn in. */
export interface Drawn extends RowSample {
  readonly frame: number;
}
export function drawn(recording: Recording, id: string): Drawn[] {
  return recording.flatMap((rows, frame) =>
    rows.filter((row) => row.id === id).map((row) => ({ ...row, frame })),
  );
}
/** The row's top before the change. */
export function startTop(recording: Recording, id: string): number {
  const first = recording[0].find((row) => row.id === id);
  if (first === undefined) throw new Error(`row ${id} is not drawn before`);
  return first.top;
}
function distinct(values: readonly number[]): number[] {
  const out: number[] = [];
  for (const value of values) {
    if (!out.some((seen) => Math.abs(seen - value) <= 0.05)) out.push(value);
  }
  return out;
}
/** How many different places the row was drawn at. */
export function placesOf(recording: Recording, id: string): number {
  return distinct(drawn(recording, id).map((row) => row.top)).length;
}
/** The row's top once the recording ends. */
export function endTop(recording: Recording, id: string): number {
  const rows = drawn(recording, id);
  if (rows.length === 0) throw new Error(`row ${id} is never drawn`);
  return rows[rows.length - 1].top;
}
/** The first frame after the change where the row is not where it began. */
export function firstMoveFrame(recording: Recording, id: string): number {
  const start = startTop(recording, id);
  const moved = drawn(recording, id).find(
    (row) => Math.abs(row.top - start) > SUBPIXEL_PX,
  );
  if (moved === undefined) throw new Error(`row ${id} never moves`);
  return moved.frame;
}
/** The first frame the row is drawn at most half as opaque as it was. */
export function halfFadedFrame(recording: Recording, id: string): number {
  const faded = drawn(recording, id).find((row) => row.opacity <= 0.5);
  if (faded === undefined) throw new Error(`row ${id} never fades`);
  return faded.frame;
}
/** The last frame the row is drawn in: the frame its copy leaves the page. */
export function lastDrawnFrame(recording: Recording, id: string): number {
  const last = drawn(recording, id).at(-1);
  if (last === undefined) throw new Error(`row ${id} is never drawn`);
  expect(last.frame, `${id} leaves the page`).toBeLessThan(
    recording.length - 1,
  );
  return last.frame;
}
/** The row stays exactly where it began, at full opacity, throughout. */
export function expectHeld(recording: Recording, id: string): void {
  const start = startTop(recording, id);
  const rows = drawn(recording, id);
  expect(rows.length, `${id} is drawn`).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.top, `${id} frame ${String(row.frame)}`).toBeCloseTo(start, 0);
    expect(row.opacity, `${id} frame ${String(row.frame)}`).toBeGreaterThan(
      0.99,
    );
  }
}
/**
 * The row glides from where it began to `delta` px away: it is drawn in
 * between, on the way and in one direction, and it ends there.
 */
export function expectSlides(
  recording: Recording,
  id: string,
  delta: number,
): void {
  const start = startTop(recording, id);
  const end = start + delta;
  const rows = drawn(recording, id);
  expect(rows.length, `${id} is drawn`).toBeGreaterThan(0);
  expect(rows[rows.length - 1].top, `${id} ends`).toBeCloseTo(end, 0);
  const between = distinct(
    rows
      .map((row) => row.top)
      .filter(
        (top) =>
          Math.abs(top - start) > SUBPIXEL_PX &&
          Math.abs(top - end) > SUBPIXEL_PX,
      ),
  );
  expect(
    between.length,
    `${id} is drawn between its two places`,
  ).toBeGreaterThanOrEqual(2);
  const direction = Math.sign(delta);
  for (let i = 1; i < rows.length; i += 1) {
    expect(
      (rows[i].top - rows[i - 1].top) * direction,
      `${id} never turns back (frame ${String(rows[i].frame)})`,
    ).toBeGreaterThanOrEqual(-SUBPIXEL_PX);
  }
}
/** The row goes from where it began to `delta` px away in one step. */
export function expectSnaps(
  recording: Recording,
  id: string,
  delta: number,
): void {
  const start = startTop(recording, id);
  const rows = drawn(recording, id);
  expect(rows.length, `${id} is drawn`).toBeGreaterThan(0);
  expect(rows[rows.length - 1].top, `${id} ends`).toBeCloseTo(start + delta, 0);
  expect(placesOf(recording, id), `${id}'s places`).toBe(2);
}
/** The row is drawn from the first frame after the change and never moves. */
export function expectAppearsAtOnce(recording: Recording, id: string): void {
  const rows = drawn(recording, id);
  expect(rows.length, `${id} is drawn`).toBeGreaterThan(0);
  expect(rows[0].frame, `${id}'s first frame`).toBe(1);
  expect(placesOf(recording, id), `${id}'s places`).toBe(1);
  for (const row of rows) {
    expect(row.opacity, `${id} frame ${String(row.frame)}`).toBeGreaterThan(
      0.99,
    );
  }
}
/** The row was there before the change and is in no frame after it. */
export function expectVanishesAtOnce(recording: Recording, id: string): void {
  startTop(recording, id);
  expect(
    drawn(recording, id).filter((row) => row.frame > 0),
    `${id} after the change`,
  ).toEqual([]);
}
/**
 * The row fades where it stood: it stays at its place while its opacity falls
 * to nothing and its box drifts left, and then it is gone.
 */
export function expectFadesInPlace(recording: Recording, id: string): void {
  const start = startTop(recording, id);
  const rows = drawn(recording, id).filter((row) => row.frame > 0);
  expect(rows.length, `${id} is drawn after the change`).toBeGreaterThanOrEqual(
    3,
  );
  for (const row of rows) {
    expect(row.top, `${id} frame ${String(row.frame)}`).toBeCloseTo(start, 0);
  }
  expect(
    Math.min(...rows.map((row) => row.opacity)),
    `${id}'s faintest`,
  ).toBeLessThanOrEqual(FADED);
  for (let i = 1; i < rows.length; i += 1) {
    expect(
      rows[i].opacity,
      `${id} never brightens (frame ${String(rows[i].frame)})`,
    ).toBeLessThanOrEqual(rows[i - 1].opacity + 0.02);
  }
  const before = drawn(recording, id)[0].left;
  expect(
    Math.min(...rows.map((row) => row.left)),
    `${id} drifts left`,
  ).toBeLessThan(before - 2);
  const last = drawn(recording, id).at(-1)?.frame ?? 0;
  expect(last, `${id} is gone before the recording ends`).toBeLessThan(
    recording.length - 1,
  );
}

/** The row's top and bottom, frame by frame, for reading a recording by eye. */
export function trackOf(
  recording: Recording,
  id: string,
): { frame: number; top: number; bottom: number; opacity: number }[] {
  return drawn(recording, id).map(({ frame, top, bottom, opacity }) => ({
    frame,
    top,
    bottom,
    opacity,
  }));
}

/** The row is there before the change, solid whenever it is drawn, and gone by `byFrame`. */
export function expectVanishesWithoutFade(
  recording: Recording,
  id: string,
  byFrame: number,
): void {
  const start = startTop(recording, id);
  const rows = drawn(recording, id);
  for (const row of rows) {
    expect(row.opacity, `${id} frame ${String(row.frame)}`).toBeGreaterThan(
      0.99,
    );
    expect(row.top, `${id} frame ${String(row.frame)}`).toBeCloseTo(start, 0);
  }
  expect(
    rows.filter((row) => row.frame > byFrame),
    `${id} after frame ${String(byFrame)}`,
  ).toEqual([]);
}

function railId(ownerId: string): string {
  return `rail:local:${ownerId}`;
}
/** Every sample of the rail of local row `ownerId`; it must be drawn. */
export function railOf(recording: Recording, ownerId: string): Drawn[] {
  const rows = drawn(recording, railId(ownerId));
  expect(rows.length, `the rail of ${ownerId} is drawn`).toBeGreaterThan(0);
  return rows;
}
function spread(values: readonly number[]): number {
  return Math.max(...values) - Math.min(...values);
}
/** How many different values `key` of the rail takes. */
export function railPlaces(
  recording: Recording,
  ownerId: string,
  key: "top" | "bottom",
): number {
  return distinct(railOf(recording, ownerId).map((row) => row[key])).length;
}

/**
 * The rail keeps its length and starts at its owner row's bottom on every
 * frame both are drawn: it moves with the row, it does not trail or jump.
 */
export function expectRailFollowsOwner(
  recording: Recording,
  ownerId: string,
): void {
  const rail = railOf(recording, ownerId);
  const owner = drawn(recording, ownerId);
  for (const row of rail) {
    const at = owner.find((o) => o.frame === row.frame);
    if (at === undefined) continue;
    expect(
      Math.abs(row.top - at.bottom),
      `rail of ${ownerId} frame ${String(row.frame)}: top ${String(row.top)}, owner's bottom ${String(at.bottom)}`,
    ).toBeLessThanOrEqual(SUBPIXEL_PX);
  }
  expect(
    spread(rail.map((row) => row.bottom - row.top)),
    `the rail of ${ownerId} keeps its length`,
  ).toBeLessThanOrEqual(SUBPIXEL_PX);
}

/** The rail is as faint as its owner row on every frame both are drawn, and goes with it. */
export function expectRailFadesWithOwner(
  recording: Recording,
  ownerId: string,
): void {
  const rail = railOf(recording, ownerId);
  const owner = drawn(recording, ownerId);
  const start = rail[0].top;
  for (const row of rail) {
    expect(
      row.top,
      `rail frame ${String(row.frame)} stays in place`,
    ).toBeCloseTo(start, 0);
    const at = owner.find((o) => o.frame === row.frame);
    if (at === undefined) continue;
    expect(
      Math.abs(row.opacity - at.opacity),
      `rail frame ${String(row.frame)}: ${String(row.opacity)} against its owner's ${String(at.opacity)}`,
    ).toBeLessThanOrEqual(0.1);
  }
  expect(
    Math.min(...rail.map((row) => row.opacity)),
    "the rail's faintest",
  ).toBeLessThanOrEqual(FADED);
  expect(
    rail[rail.length - 1].frame,
    "the rail is gone before the recording ends",
  ).toBeLessThan(recording.length - 1);
}

/** The rail is fully opaque on every frame it is drawn, and drawn on every frame. */
export function expectRailSolid(recording: Recording, ownerId: string): void {
  const rail = railOf(recording, ownerId);
  expect(rail.length, "the rail is drawn on every frame").toBe(
    recording.length,
  );
  for (const row of rail) {
    expect(row.opacity, `rail frame ${String(row.frame)}`).toBeGreaterThan(
      0.99,
    );
  }
}

/** The rail's `key` moves from where it began to `delta` px away in one frame, with no frame between. */
export function expectRailSteps(
  recording: Recording,
  ownerId: string,
  key: "top" | "bottom",
  delta: number,
): { readonly stepFrame: number } {
  const rail = railOf(recording, ownerId);
  const start = rail[0][key];
  expect(rail[rail.length - 1][key], `rail ${key} ends`).toBeCloseTo(
    start + delta,
    0,
  );
  expect(
    railPlaces(recording, ownerId, key),
    `rail ${key} takes two values: it does not glide`,
  ).toBe(2);
  const stepped = rail.find((row) => Math.abs(row[key] - start) > SUBPIXEL_PX);
  if (stepped === undefined) throw new Error(`rail ${key} never moves`);
  return { stepFrame: stepped.frame };
}

/** The rail's `key` never changes. */
export function expectRailHolds(
  recording: Recording,
  ownerId: string,
  key: "top" | "bottom",
): void {
  expect(railPlaces(recording, ownerId, key), `rail ${key} places`).toBe(1);
}

/**
 * From `afterFrame` on, the row eases from about `from` to `to` in steps no
 * bigger than `maxStep`, all in one direction: it glides, it does not jump.
 * Frames before `afterFrame` are not looked at.
 */
interface Glide {
  readonly from: number;
  readonly to: number;
  readonly maxStep: number;
  readonly afterFrame: number;
}
export function expectSlidesBack(
  recording: Recording,
  id: string,
  glide: Glide,
): void {
  const { from, to, maxStep, afterFrame } = glide;
  const rows = drawn(recording, id).filter((row) => row.frame >= afterFrame);
  expect(
    rows.length,
    `${id} is drawn after frame ${String(afterFrame)}`,
  ).toBeGreaterThan(0);
  // The glide may already have begun by the first frame looked at, by one step.
  expect(
    Math.abs(rows[0].top - from),
    `${id} starts the slide at ${String(from)}`,
  ).toBeLessThanOrEqual(maxStep);
  expect(rows[rows.length - 1].top, `${id} ends the slide at`).toBeCloseTo(
    to,
    0,
  );
  const direction = Math.sign(to - from);
  for (let i = 1; i < rows.length; i += 1) {
    const step = rows[i].top - rows[i - 1].top;
    expect(
      Math.abs(step),
      `${id} frame ${String(rows[i].frame)}: ${String(rows[i - 1].top)} -> ${String(rows[i].top)}`,
    ).toBeLessThanOrEqual(maxStep);
    expect(
      step * direction,
      `${id} never turns back (frame ${String(rows[i].frame)})`,
    ).toBeGreaterThanOrEqual(-SUBPIXEL_PX);
  }
}
