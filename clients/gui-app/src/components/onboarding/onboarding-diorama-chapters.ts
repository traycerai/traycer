/**
 * A region of the mockup a chapter can light up. `browser` is the pane that
 * only exists from chapter 2's second beat on; every other id is present for
 * the whole run.
 */
export type DioramaRegionId =
  | "tabs"
  | "rail"
  | "agents"
  | "browsers"
  | "artifacts"
  | "canvas"
  | "browser";

/**
 * How far the canvas has got. It only ever moves forward inside a chapter, and
 * it is the ONE source of truth for the split: a state that has to persist
 * across chapters cannot be a delayed keyframe, because every remount and every
 * chapter switch silently rewinds one.
 */
export type DioramaStage = "single" | "tiled" | "browsing";

/** Which sidebar panel the icon rail is showing. */
export type DioramaPanelId = "chats" | "terminals" | "git" | "pulls" | "files";

/**
 * A chapter is a short timeline, not a single pose: the spotlight moves when
 * the demonstration does. "Open" drags onto the canvas and then clicks in the
 * sidebar; "Panels" walks the whole rail. Everything a beat changes is state
 * the component renders, so the CSS choreography stays declarative and the
 * beat boundaries stay readable as numbers.
 */
export type DioramaBeat = {
  /** Offset from the chapter's start. The first beat of a chapter is 0. */
  readonly atMs: number;
  /** Regions that stay at full opacity; everything else drops to .6. */
  readonly lit: readonly DioramaRegionId[];
  /** The one region that wears the spotlight ring. */
  readonly ring: DioramaRegionId;
  readonly panel: DioramaPanelId;
  readonly stage: DioramaStage;
};

export type DioramaChapter = {
  readonly id: string;
  /** Chapter-strip label. */
  readonly label: string;
  /** The label card's headline, and the strip segment's caption. */
  readonly title: string;
  readonly line: string;
  readonly durationMs: number;
  readonly beats: readonly DioramaBeat[];
  /** Which window edge the pin sits on, and where along it. */
  readonly place: "top" | "left" | "right";
  readonly x: string;
  readonly y: string;
};

/**
 * Every beat of "Panels" holds one spotlight and changes only the panel under
 * it. `browser` is lit there for a reason that is easy to undo by accident:
 * the canvas is dimmed, and a dim inside a dim composites to .36.
 */
const PANEL_SPOTLIGHT: Pick<DioramaBeat, "lit" | "ring" | "stage"> = {
  lit: ["rail", "agents", "browsers", "artifacts", "browser"],
  ring: "rail",
  stage: "browsing",
};

/**
 * The tour's script. Each chapter's slot is its choreography plus a hold long
 * enough to read the label card - never under 4.5s. After the last chapter the
 * tour loops back to the first.
 */
export const DIORAMA_CHAPTERS: readonly DioramaChapter[] = [
  {
    id: "tabs",
    label: "Tabs",
    title: "Tasks live in tabs.",
    line: "Every task keeps its own agents, browsers and artifacts.",
    durationMs: 4500,
    beats: [
      { atMs: 0, lit: ["tabs"], ring: "tabs", panel: "chats", stage: "single" },
    ],
    place: "top",
    x: "30%",
    y: "0%",
  },
  {
    id: "open",
    label: "Open",
    title: "Drag or click to open.",
    line: "Tile anything from the sidebar, or click it to open in place.",
    durationMs: 6000,
    beats: [
      // The drag: the canvas is where the artifact is going.
      {
        atMs: 0,
        lit: ["artifacts", "canvas", "browser"],
        ring: "canvas",
        panel: "chats",
        stage: "single",
      },
      // The drop, on the frame the ghost settles: the canvas splits and keeps
      // the split for the rest of the tour.
      {
        atMs: 2350,
        lit: ["artifacts", "canvas", "browser"],
        ring: "canvas",
        panel: "chats",
        stage: "tiled",
      },
      // The ring moves 600ms before the cursor arrives, so the eye is already
      // on the row the click is going to land on.
      {
        atMs: 3200,
        lit: ["browsers", "canvas", "browser"],
        ring: "browsers",
        panel: "chats",
        stage: "tiled",
      },
      // The click: the right tile gains a second tab and switches to it.
      {
        atMs: 3900,
        lit: ["browsers", "canvas", "browser"],
        ring: "browsers",
        panel: "chats",
        stage: "browsing",
      },
    ],
    place: "left",
    x: "0%",
    y: "68%",
  },
  {
    id: "panels",
    label: "Panels",
    title: "Switch panels.",
    line: "Chats, terminals, git, pull requests and files, all for this task.",
    durationMs: 5500,
    beats: [
      { atMs: 0, ...PANEL_SPOTLIGHT, panel: "chats" },
      { atMs: 800, ...PANEL_SPOTLIGHT, panel: "terminals" },
      { atMs: 1600, ...PANEL_SPOTLIGHT, panel: "git" },
      { atMs: 2400, ...PANEL_SPOTLIGHT, panel: "pulls" },
      { atMs: 3200, ...PANEL_SPOTLIGHT, panel: "files" },
      // Back where it started, so "Browse" opens on the sidebar it has always
      // opened on rather than snapping back between chapters.
      { atMs: 4400, ...PANEL_SPOTLIGHT, panel: "chats" },
    ],
    place: "left",
    x: "0%",
    y: "12%",
  },
  {
    id: "browse",
    label: "Browse",
    title: "Agents share the page.",
    line: "Claude and Codex work in the same browser.",
    durationMs: 4500,
    beats: [
      {
        atMs: 0,
        lit: ["canvas", "browser"],
        ring: "browser",
        panel: "chats",
        stage: "browsing",
      },
    ],
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

/** The beat in effect `elapsedMs` into the chapter. */
export function dioramaBeatAt(
  chapter: DioramaChapter,
  elapsedMs: number,
): number {
  let index = 0;
  chapter.beats.forEach((beat, position) => {
    if (beat.atMs <= elapsedMs) index = position;
  });
  return index;
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
