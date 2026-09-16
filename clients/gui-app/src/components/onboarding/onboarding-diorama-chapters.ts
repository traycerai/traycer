/**
 * A region of the mockup a chapter can light up. `browser` is the pane that
 * only exists from chapter 3 on; every other id is present for the whole run.
 */
export type DioramaRegionId =
  | "tabs"
  | "agents"
  | "browsers"
  | "artifacts"
  | "canvas"
  | "browser";

export type DioramaChapter = {
  readonly id: string;
  /** Chapter-strip label. */
  readonly label: string;
  /** The label card's headline, and the strip segment's caption. */
  readonly title: string;
  readonly line: string;
  readonly durationMs: number;
  /** Regions that stay at full opacity; everything else drops to .6. */
  readonly lit: readonly DioramaRegionId[];
  /** The one region that wears the spotlight ring. */
  readonly ring: DioramaRegionId;
  /** Which window edge the pin sits on, and where along it. */
  readonly place: "top" | "left" | "right";
  readonly x: string;
  readonly y: string;
};

/**
 * The tour's script. Every chapter runs the same 4.5s: the choreography inside
 * it is unchanged - the longest (the drag, at ~2.8s; the two browser cursors,
 * at ~3.7s) still runs at its own speed - and the rest of the slot is a hold,
 * so the label card is readable before the scene moves on. After the last
 * chapter the tour loops back to the first.
 */
export const DIORAMA_CHAPTERS: readonly DioramaChapter[] = [
  {
    id: "tabs",
    label: "Tabs",
    title: "Tasks live in tabs.",
    line: "Every task keeps its own agents, browsers and artifacts.",
    durationMs: 4500,
    lit: ["tabs"],
    ring: "tabs",
    place: "top",
    x: "30%",
    y: "0%",
  },
  {
    id: "tile",
    label: "Tile",
    title: "Drag to tile.",
    line: "Drop anything from the sidebar onto the canvas.",
    durationMs: 4500,
    lit: ["artifacts", "canvas", "browser"],
    ring: "canvas",
    place: "left",
    x: "0%",
    y: "77%",
  },
  {
    id: "open",
    label: "Open",
    title: "Click to open.",
    line: "Browsers and artifacts open in place.",
    durationMs: 4500,
    lit: ["browsers", "canvas", "browser"],
    ring: "browsers",
    place: "left",
    x: "0%",
    y: "50%",
  },
  {
    id: "browse",
    label: "Browse",
    title: "Agents share the page.",
    line: "Claude and Codex work in the same browser.",
    durationMs: 4500,
    lit: ["canvas", "browser"],
    ring: "browser",
    place: "right",
    x: "100%",
    y: "45%",
  },
];

/** Cumulative start time of each chapter, in ms from the scene's mount. */
export function dioramaChapterStarts(
  chapters: readonly DioramaChapter[],
): readonly number[] {
  let elapsed = 0;
  return chapters.map((chapter) => {
    const start = elapsed;
    elapsed += chapter.durationMs;
    return start;
  });
}

/** Moves along the strip, wrapping at both ends - autoplay and the arrow keys. */
export function stepDioramaChapter(index: number, delta: number): number {
  const count = DIORAMA_CHAPTERS.length;
  return (index + delta + count) % count;
}

/**
 * The autoplay clock. A rAF loop reads elapsed time off it rather than
 * chaining timeouts, so a pause freezes the progress fill exactly where it
 * stood and a resume costs nothing.
 */
export type DioramaClock = {
  /** When the chapter started, already shifted forward by any paused time. */
  readonly startedAt: number;
  /** When the clock was frozen, or null while it runs. */
  readonly pausedAt: number | null;
};

/** Run time of the current chapter, frozen while the clock is paused. */
export function dioramaElapsedMs(clock: DioramaClock, now: number): number {
  return (clock.pausedAt ?? now) - clock.startedAt;
}

/** Freezes the clock, or resumes it by moving the start past the paused span. */
export function setDioramaPaused(
  clock: DioramaClock,
  paused: boolean,
  now: number,
): DioramaClock {
  const pausedAt = clock.pausedAt;
  if (paused) {
    if (pausedAt !== null) return clock;
    return { startedAt: clock.startedAt, pausedAt: now };
  }
  if (pausedAt === null) return clock;
  return { startedAt: clock.startedAt + (now - pausedAt), pausedAt: null };
}
