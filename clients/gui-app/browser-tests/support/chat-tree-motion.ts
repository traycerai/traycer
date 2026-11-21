import { expect, test, type Page } from "@playwright/test";
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
  /** When it was sampled, in ms after the change (0 before it). */
  readonly at: number;
}
/** One entry per frame; the first is sampled before the change. */
export type Recording = RowSample[][];
/** What one React commit rendered: rows again, rows new, the panel. */
export interface CommitCount {
  readonly rows: number;
  readonly mounted: number;
  readonly panel: number;
  /** When it committed, in ms after the change. */
  readonly at: number;
}
interface Probe {
  readonly ready: boolean;
  readonly startCommitCount: (row: string, panel: string) => void;
  readonly stopCommitCount: () => CommitCount[];
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

/** The components whose renders a commit count tells apart, by function name. */
const ROW_COMPONENT = "ChatRowButton";
const PANEL_COMPONENT = "ChatTreePanelBody";
/**
 * How many rows one commit after a change may mount: a window mount adds the
 * one row a change brought into view; a scroll brings in as many as it shows.
 */
type MountsPerCommit = "one" | "any";
/**
 * After the commit that makes the change, no commit renders a row that was
 * already there or the panel, and a commit mounts at most `mounts` rows. The
 * cause this holds off: a host query the mock host left unanswered was fetched
 * again whenever a row mounted into the window, and each failure re-rendered
 * every row in a long task, so the motion stalled and jumped.
 */
function expectOnlyMountsRender(
  commits: readonly CommitCount[],
  mounts: MountsPerCommit,
): void {
  expect(commits.length, "commits after the change").toBeGreaterThan(0);
  const trail = JSON.stringify(commits);
  commits.slice(1).forEach((commit, i) => {
    expect(
      commit.rows,
      `commit ${String(i + 1)} re-rendered rows (all commits: ${trail})`,
    ).toBe(0);
    expect(
      commit.panel,
      `commit ${String(i + 1)} re-rendered the panel (all commits: ${trail})`,
    ).toBe(0);
    if (mounts === "one") {
      expect(
        commit.mounted,
        `commit ${String(i + 1)} mounted rows (all commits: ${trail})`,
      ).toBeLessThanOrEqual(1);
    }
  });
}
/**
 * Every recording runs with the page's commits counted, from the commit of
 * the change it records on, and holds `expectOnlyMountsRender`: the guard for
 * every motion case, whatever else the case asserts.
 */
async function guarded(
  page: Page,
  mounts: MountsPerCommit,
  record: () => Promise<Recording>,
): Promise<Recording> {
  await page.evaluate(
    ([row, panel]) => {
      const probe = window.__chatTreeMotion;
      if (probe === undefined) throw new Error("no probe");
      probe.startCommitCount(row, panel);
    },
    [ROW_COMPONENT, PANEL_COMPONENT] as const,
  );
  const recording = await record();
  const commits = await page.evaluate(() => {
    const probe = window.__chatTreeMotion;
    if (probe === undefined) throw new Error("no probe");
    return probe.stopCommitCount();
  });
  expectOnlyMountsRender(commits, mounts);
  CHANGE_COMMITTED_AT.set(recording, commits[0].at);
  return recording;
}
/** When each recording's change committed, in ms after the change. */
const CHANGE_COMMITTED_AT = new WeakMap<Recording, number>();
/** When `recording`'s change committed: no motion it causes starts earlier. */
function changeCommittedAt(recording: Recording): number {
  const at = CHANGE_COMMITTED_AT.get(recording);
  if (at === undefined)
    throw new Error("the recording was not made by a recorder here");
  return at;
}

/** `specs` as the task's cloud chats, written into the cached list at once. */
export function recordCloud(
  page: Page,
  specs: readonly CloudSpec[],
): Promise<Recording> {
  return guarded(page, "one", () =>
    page.evaluate(
      ([list, frames]) => {
        const probe = window.__chatTreeMotion;
        if (probe === undefined) throw new Error("no probe");
        return probe.recordCloud(list, frames);
      },
      [specs, FRAMES] as const,
    ),
  );
}
export function recordShape(page: Page, next: Shape): Promise<Recording> {
  return guarded(page, "one", () =>
    page.evaluate(
      ([shape, frames]) => {
        const probe = window.__chatTreeMotion;
        if (probe === undefined) throw new Error("no probe");
        return probe.recordShape(shape, frames);
      },
      [next, FRAMES] as const,
    ),
  );
}
/** `next` with `kept` still in the store: what a filter or the archive does. */
export function recordHide(
  page: Page,
  next: Shape,
  kept: readonly string[],
): Promise<Recording> {
  return guarded(page, "one", () =>
    page.evaluate(
      ([shape, ids, frames]) => {
        const probe = window.__chatTreeMotion;
        if (probe === undefined) throw new Error("no probe");
        return probe.recordHide(shape, ids, frames);
      },
      [next, kept, FRAMES] as const,
    ),
  );
}
export function recordChevron(page: Page, id: string): Promise<Recording> {
  return guarded(page, "one", () =>
    page.evaluate(
      ([target, frames]) => {
        const probe = window.__chatTreeMotion;
        if (probe === undefined) throw new Error("no probe");
        return probe.recordChevron(target, frames);
      },
      [id, FRAMES] as const,
    ),
  );
}
export function recordScroll(page: Page, top: number): Promise<Recording> {
  return guarded(page, "any", () =>
    page.evaluate(
      ([offset, frames]) => {
        const probe = window.__chatTreeMotion;
        if (probe === undefined) throw new Error("no probe");
        return probe.recordScroll(offset, frames);
      },
      [top, FRAMES] as const,
    ),
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
/**
 * How far into the tree's 160 ms slide or fade (`useTreeRowMotion`) a row is
 * still on the way: its easing has covered under 95% of the distance by then.
 * The sampler reads a frame late, which only puts a sample earlier on its way.
 */
const MID_TRANSITION_MS = 90;
/**
 * A gap before a row's first moved sample longer than this can hide a whole
 * slide's middle: past 110 ms the easing is within a pixel of the end.
 */
const HIDING_GAP_MS = 110;
/** A gap between two samples this long is a stall, not a frame. */
const STALL_MS = 50;
/** A gap spanning a turn this long can swallow how far the row got. */
const TURN_GAP_MS = 80;
/**
 * Records, on the test, whether a time-window check ran or was skipped and
 * why, so a run shows how often a stall left a check nothing to look at.
 */
function noteWindow(check: string, id: string, outcome: string): void {
  test.info().annotations.push({
    type: "motion-window",
    description: `${check} ${id}: ${outcome}`,
  });
}
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
/** When frame `frame` of the recording was sampled. */
function sampledAt(recording: Recording, frame: number): number {
  const rows = recording[frame];
  if (rows.length === 0) throw new Error(`frame ${String(frame)} drew nothing`);
  return rows[0].at;
}
function isBetween(top: number, start: number, end: number): boolean {
  return (
    Math.abs(top - start) > SUBPIXEL_PX && Math.abs(top - end) > SUBPIXEL_PX
  );
}
/**
 * The row glides from where it began to `delta` px away, in one direction, and
 * ends there. Its glide cannot have begun before `anchor` ms:
 * - (i) no sample in the first `MID_TRANSITION_MS` from `anchor` is at the
 *   end yet: a snap or a rushed slide fails. `anchor` is the change's commit,
 *   or the leaving row's last drawn sample for a slide that closes its gap;
 * - (ii) at least one sample after `anchor` is between the two places, unless
 *   the gap before its first moved sample is over `HIDING_GAP_MS`.
 * A window a stall leaves empty is skipped, and the skip is noted; the commit
 * count every recording holds catches what causes such a stall.
 */
function expectGlide(
  recording: Recording,
  id: string,
  delta: number,
  anchor: number,
): void {
  const start = startTop(recording, id);
  const end = start + delta;
  const rows = drawn(recording, id);
  expect(rows.length, `${id} is drawn`).toBeGreaterThan(0);
  expect(rows[rows.length - 1].top, `${id} ends`).toBeCloseTo(end, 0);
  const direction = Math.sign(delta);
  for (let i = 1; i < rows.length; i += 1) {
    expect(
      (rows[i].top - rows[i - 1].top) * direction,
      `${id} never turns back (frame ${String(rows[i].frame)})`,
    ).toBeGreaterThanOrEqual(-SUBPIXEL_PX);
  }
  const after = rows.filter((row) => row.frame > 0 && row.at >= anchor);
  const early = after.filter((row) => row.at - anchor <= MID_TRANSITION_MS);
  if (early.length === 0) noteWindow("slide (i)", id, "skipped: empty window");
  else noteWindow("slide (i)", id, "evaluated");
  for (const row of early) {
    expect(
      Math.abs(row.top - end) > SUBPIXEL_PX,
      `${id} is not at its end yet at ${String(row.at)} ms (frame ${String(row.frame)}, top ${String(row.top)})`,
    ).toBe(true);
  }
  const moved = after.findIndex(
    (row) => Math.abs(row.top - start) > SUBPIXEL_PX,
  );
  expect(moved, `${id} leaves its place`).toBeGreaterThanOrEqual(0);
  const departed = after[moved];
  const before =
    moved > 0 ? after[moved - 1].at : sampledAt(recording, departed.frame - 1);
  if (departed.at - before > HIDING_GAP_MS) {
    noteWindow("slide (ii)", id, "skipped: gap before its first move");
    return;
  }
  noteWindow("slide (ii)", id, "evaluated");
  expect(
    after.some((row) => isBetween(row.top, start, end)),
    `${id} is drawn between its two places`,
  ).toBe(true);
}
/**
 * The row glides from where it began to `delta` px away, starting with the
 * change's commit; see `expectGlide`.
 */
export function expectSlides(
  recording: Recording,
  id: string,
  delta: number,
): void {
  expectGlide(recording, id, delta, changeCommittedAt(recording));
}
/**
 * The row glides `delta` px into the slot row `ghost` leaves, once `ghost`'s
 * copy is gone: its glide cannot begin before `ghost`'s last drawn sample.
 */
export function expectClosesGap(
  recording: Recording,
  id: string,
  delta: number,
  ghost: string,
): void {
  const last = drawn(recording, ghost).at(-1);
  if (last === undefined) throw new Error(`row ${ghost} is never drawn`);
  expectGlide(recording, id, delta, last.at);
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
 * The row fades where it stood: it stays at its place, never brightens, and is
 * gone before the recording ends. Its fade cannot begin before the change's
 * commit:
 * - (i) no sample in the first `MID_TRANSITION_MS` after that commit is faded
 *   out yet: a cut or a rushed fade fails;
 * - (ii) at least one sample is part faded, unless the gap before the row is
 *   gone or first fades is over `HIDING_GAP_MS`; then how faint it got and
 *   how far it drifted left are asserted too, unless a stall over `STALL_MS`
 *   came just before it went.
 * Each skip is noted.
 */
export function expectFadesInPlace(recording: Recording, id: string): void {
  const start = startTop(recording, id);
  const rows = drawn(recording, id).filter((row) => row.frame > 0);
  expect(rows.length, `${id} is drawn after the change`).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.top, `${id} frame ${String(row.frame)}`).toBeCloseTo(start, 0);
  }
  for (let i = 1; i < rows.length; i += 1) {
    expect(
      rows[i].opacity,
      `${id} never brightens (frame ${String(rows[i].frame)})`,
    ).toBeLessThanOrEqual(rows[i - 1].opacity + 0.02);
  }
  const last = rows[rows.length - 1];
  expect(last.frame, `${id} is gone before the recording ends`).toBeLessThan(
    recording.length - 1,
  );
  const committed = changeCommittedAt(recording);
  const early = rows.filter(
    (row) => row.at >= committed && row.at - committed <= MID_TRANSITION_MS,
  );
  if (early.length === 0) noteWindow("fade (i)", id, "skipped: empty window");
  else noteWindow("fade (i)", id, "evaluated");
  for (const row of early) {
    expect(
      row.opacity,
      `${id} is not faded out yet at ${String(row.at)} ms (frame ${String(row.frame)})`,
    ).toBeGreaterThan(FADED);
  }
  const fading = rows.findIndex((row) => row.opacity < 0.99);
  const gone = sampledAt(recording, last.frame + 1);
  const shown = fading === -1 ? last.at : rows[fading].at;
  const beforeShown =
    fading > 0 ? rows[fading - 1].at : sampledAt(recording, rows[0].frame - 1);
  if (
    fading === -1
      ? gone - last.at > HIDING_GAP_MS
      : shown - beforeShown > HIDING_GAP_MS
  ) {
    noteWindow("fade (ii)", id, "skipped: gap before the fade shows");
    return;
  }
  noteWindow("fade (ii)", id, "evaluated");
  expect(
    rows.some((row) => row.opacity > FADED && row.opacity < 0.99),
    `${id} is drawn part faded`,
  ).toBe(true);
  if (gone - last.at > STALL_MS) {
    noteWindow("fade end", id, "skipped: stall before it went");
    return;
  }
  noteWindow("fade end", id, "evaluated");
  expect(
    Math.min(...rows.map((row) => row.opacity)),
    `${id}'s faintest`,
  ).toBeLessThanOrEqual(FADED);
  expect(
    Math.min(...rows.map((row) => row.left)),
    `${id} drifts left`,
  ).toBeLessThan(drawn(recording, id)[0].left - 2);
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
 * From `afterFrame` on, the row goes from `from` to `to`, in one direction
 * only. How fast is not asserted: a frame's step depends on the frame rate
 * and the machine's load. Frames before `afterFrame` are not looked at.
 */
interface Glide {
  readonly from: number;
  readonly to: number;
  readonly afterFrame: number;
}
export function expectSlidesBack(
  recording: Recording,
  id: string,
  glide: Glide,
): void {
  const { from, to, afterFrame } = glide;
  const rows = drawn(recording, id).filter((row) => row.frame >= afterFrame);
  expect(
    rows.length,
    `${id} is drawn after frame ${String(afterFrame)}`,
  ).toBeGreaterThan(0);
  expect(rows[0].frame, `${id} is drawn on frame ${String(afterFrame)}`).toBe(
    afterFrame,
  );
  expect(
    Math.abs(rows[0].top - from),
    `${id} is still at ${String(from)} on frame ${String(afterFrame)}`,
  ).toBeLessThanOrEqual(SUBPIXEL_PX);
  expect(rows[rows.length - 1].top, `${id} ends the slide at`).toBeCloseTo(
    to,
    0,
  );
  const direction = Math.sign(to - from);
  for (let i = 1; i < rows.length; i += 1) {
    const step = rows[i].top - rows[i - 1].top;
    expect(
      step * direction,
      `${id} never turns back (frame ${String(rows[i].frame)})`,
    ).toBeGreaterThanOrEqual(-SUBPIXEL_PX);
  }
}

/**
 * The row moves out towards `from` until frame `afterFrame`, never turning
 * back, gets at least half a row of the way there, then moves back and ends
 * at `to`, never turning back either: a row that slides while another fades
 * and closes the gap once the fade ends. Where it is on `afterFrame` itself is
 * not asserted: the sampler can read the slide a frame late. How far it got
 * is not asserted when a gap over `TURN_GAP_MS` spans the turn; that is noted.
 */
export function expectOutAndBack(
  recording: Recording,
  id: string,
  glide: Glide,
): void {
  const { from, to, afterFrame } = glide;
  const rows = drawn(recording, id);
  const out = rows.filter((row) => row.frame <= afterFrame);
  const back = rows.filter((row) => row.frame >= afterFrame);
  expect(
    out.length,
    `${id} is drawn up to frame ${String(afterFrame)}`,
  ).toBeGreaterThan(0);
  expect(
    back.length,
    `${id} is drawn from frame ${String(afterFrame)}`,
  ).toBeGreaterThan(0);
  const outward = Math.sign(from - to);
  for (let i = 1; i < out.length; i += 1) {
    expect(
      (out[i].top - out[i - 1].top) * outward,
      `${id} moves out without turning (frame ${String(out[i].frame)})`,
    ).toBeGreaterThanOrEqual(-SUBPIXEL_PX);
  }
  for (let i = 1; i < back.length; i += 1) {
    expect(
      (back[i].top - back[i - 1].top) * outward,
      `${id} comes back without turning (frame ${String(back[i].frame)})`,
    ).toBeLessThanOrEqual(SUBPIXEL_PX);
  }
  const turn = out[out.length - 1];
  const next = back.find((row) => row.frame > afterFrame);
  if (next !== undefined && next.at - turn.at > TURN_GAP_MS) {
    noteWindow("turn", id, "skipped: gap spanning the turn");
  } else {
    noteWindow("turn", id, "evaluated");
    expect(
      (turn.top - (from - (outward * ROW_PITCH) / 2)) * outward,
      `${id} turns at ${String(turn.top)}, at least half a row towards ${String(from)}`,
    ).toBeGreaterThanOrEqual(0);
  }
  expect(back[back.length - 1].top, `${id} ends the slide at`).toBeCloseTo(
    to,
    0,
  );
}
