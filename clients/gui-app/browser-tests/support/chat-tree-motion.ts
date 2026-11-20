import { expect, type Page } from "@playwright/test";
import { fixture, nextFrames } from "./fixtures.ts";

/**
 * Driving and reading the chat tree's row motion fixture
 * (`src/__tests__/browser/chat-tree-motion.tsx`): the REAL `ChatTreePanelBody`
 * over a seeded store, whose probe records every drawn row's box and opacity
 * once per animation frame across a change.
 */
export interface Shape {
  readonly roots: readonly string[];
  readonly children: Readonly<Record<string, readonly string[]>>;
}
export interface RowSample {
  readonly id: string;
  readonly top: number;
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
};
/** Long enough for a fade and the slide after it, at any frame rate. */
export const FRAMES = 40;

/** Loads the fixture and settles `shape` as the tree. */
export async function openTree(page: Page, shape: Shape): Promise<void> {
  await page.goto(fixture("chat-tree-motion"));
  await page.waitForFunction(() => window.__chatTreeMotion?.ready === true);
  await page.evaluate((s) => {
    const probe = window.__chatTreeMotion;
    if (probe === undefined) throw new Error("no probe");
    probe.setShape(s);
  }, shape);
  await expect(page.getByTestId("epic-sidebar-item-a")).toBeVisible();
  await nextFrames(page, 20);
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
