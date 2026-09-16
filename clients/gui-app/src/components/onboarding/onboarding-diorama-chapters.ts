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
  /** Chapter-dot label. */
  readonly label: string;
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
 * The tour's script. Durations are the spec's timeline: 0–2.4s, 2.4–6.2s,
 * 6.2–8.8s, 8.8–12.5s, then hold on the last chapter.
 */
export const DIORAMA_CHAPTERS: readonly DioramaChapter[] = [
  {
    id: "tabs",
    label: "Tabs",
    title: "Tasks live in tabs.",
    line: "Every task keeps its own agents, browsers and artifacts.",
    durationMs: 2400,
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
    durationMs: 3800,
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
    durationMs: 2600,
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
    durationMs: 3700,
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
