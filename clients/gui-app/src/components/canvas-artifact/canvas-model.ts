import type {
  CanvasBoard,
  CanvasBoardFrame,
  CanvasLayoutSnapshot,
  CanvasNote,
} from "@traycer/protocol/persistence/epic/canvas-layout";

export const CANVAS_LOCAL_ORIGIN = Symbol("canvas-local");
export const LIVE_BOARD_SLOT_BUDGET = 24;
/** The selection/board inspector is parked, not removed: the panels stay in
 * the tree behind this flag until the inspector earns its place in the UI. */
export const CANVAS_INSPECTOR_ENABLED: boolean = false;
export const BOARD_HEADER_HEIGHT = 36;
export type CanvasTool =
  | "select"
  | "hand"
  | "comment"
  | "sticky"
  | "rect"
  | "oval"
  | "line"
  | "arrow"
  | "pen"
  | "title";
export interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}
export interface CanvasPageItems {
  readonly boards: readonly [string, CanvasBoard][];
  readonly notes: readonly [string, CanvasNote][];
}
const TOOL_KEYS: Readonly<Record<string, CanvasTool>> = {
  v: "select",
  h: "hand",
  c: "comment",
  n: "sticky",
  r: "rect",
  o: "oval",
  l: "line",
  a: "arrow",
  p: "pen",
  t: "title",
  escape: "select",
};
export function canvasToolForKey(key: string): CanvasTool | null {
  return Object.hasOwn(TOOL_KEYS, key.toLowerCase())
    ? TOOL_KEYS[key.toLowerCase()]
    : null;
}
export function boardFrame(board: CanvasBoard): CanvasBoardFrame {
  return {
    x: board.x ?? 0,
    y: board.y ?? 0,
    w: Math.max(80, board.w ?? 1280),
    h: Math.max(60, board.h ?? 800),
  };
}
/**
 * `files` holds the committed manifest's paths. `canvas.json` can name a
 * board whose file was never committed, and such a board is left off the
 * page rather than drawn as a frame with nothing to load; its place in the
 * layout is kept. `null`, before any manifest is known, keeps every board.
 */
export function canvasPageItems(
  snapshot: CanvasLayoutSnapshot,
  page: string,
  files: ReadonlySet<string> | null,
): CanvasPageItems {
  const first = snapshot.pages.at(0)?.id ?? "";
  const onPage = (item: CanvasBoard | CanvasNote): boolean =>
    (item.page ?? first) === page;
  return {
    boards: snapshot.order.flatMap((path) => {
      const board = snapshot.boards[path];
      return Object.hasOwn(snapshot.boards, path) &&
        onPage(board) &&
        (files === null || files.has(path))
        ? [[path, board] as [string, CanvasBoard]]
        : [];
    }),
    notes: Object.entries(snapshot.notes).filter(([, note]) => onPage(note)),
  };
}
/** The boards fullscreen steps through: the reading order, pages included. */
export function fullscreenBoardSequence(
  snapshot: CanvasLayoutSnapshot,
): readonly string[] {
  return snapshot.order.filter((path) => Object.hasOwn(snapshot.boards, path));
}
/** The board one step before or after `path` in the reading order. */
export function adjacentFullscreenBoard(
  snapshot: CanvasLayoutSnapshot,
  path: string,
  direction: -1 | 1,
): string | null {
  const sequence = fullscreenBoardSequence(snapshot);
  const index = sequence.indexOf(path);
  return index < 0 ? null : (sequence[index + direction] ?? null);
}
/** Insertion order is also the mount order, so visible boards load first. */
export function selectLiveBoards({
  boards,
  pageBoards,
  byteLengths,
  viewport,
  fullscreenBoard,
  playingBoard,
  recentBoards,
  slotBudget,
}: {
  readonly boards: Readonly<Record<string, CanvasBoard>>;
  readonly pageBoards: readonly string[];
  readonly byteLengths: Readonly<Record<string, number>> | null;
  readonly viewport: CanvasBoardFrame;
  readonly fullscreenBoard: string | null;
  readonly playingBoard: string | null;
  readonly recentBoards: readonly string[];
  readonly slotBudget: number;
}): ReadonlySet<string> {
  const live = new Set<string>();
  if (slotBudget <= 0) return live;
  const available = (path: string): boolean =>
    Object.hasOwn(boards, path) &&
    (byteLengths === null || Object.hasOwn(byteLengths, path));
  const nearest = pageBoards
    .filter(available)
    .map((path, order) => {
      const frame = boardFrame(boards[path]);
      return {
        path,
        order,
        visible:
          frame.x < viewport.x + viewport.w &&
          frame.x + frame.w > viewport.x &&
          frame.y < viewport.y + viewport.h &&
          frame.y + frame.h > viewport.y,
        distance:
          (frame.x + frame.w / 2 - viewport.x - viewport.w / 2) ** 2 +
          (frame.y + frame.h / 2 - viewport.y - viewport.h / 2) ** 2,
      };
    })
    .sort((a, b) => a.distance - b.distance || a.order - b.order);
  const candidates = new Set([
    ...(fullscreenBoard === null ? [] : [fullscreenBoard]),
    ...(playingBoard === null ? [] : [playingBoard]),
    ...nearest.filter((board) => board.visible).map((board) => board.path),
    ...recentBoards,
    ...nearest.map((board) => board.path),
  ]);
  let used = 0;
  for (const path of candidates) {
    if (!available(path)) continue;
    const weight = 1 + Math.floor((byteLengths?.[path] ?? 0) / (40 * 1024));
    // Even an unusually large board must be viewable when it has priority.
    if (live.size > 0 && used + weight > slotBudget) continue;
    live.add(path);
    used += weight;
  }
  return live;
}
export interface CursorThrottle<T> {
  readonly push: (value: T) => void;
  readonly cancel: () => void;
}
/** Leading + trailing; leaving cancels the queued position before clearing awareness. */
export function createCursorThrottle<T>(
  publish: (value: T) => void,
): CursorThrottle<T> {
  let last = -Infinity;
  let timer: number | null = null;
  let pending: { value: T } | null = null;
  const interval = 1000 / 30;
  const flush = (): void => {
    timer = null;
    if (pending === null) return;
    const { value } = pending;
    pending = null;
    last = Date.now();
    publish(value);
  };
  return {
    push(value) {
      pending = { value };
      const remaining = interval - (Date.now() - last);
      if (remaining <= 0) {
        if (timer !== null) window.clearTimeout(timer);
        flush();
      } else if (timer === null) timer = window.setTimeout(flush, remaining);
    },
    cancel() {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      pending = null;
      last = -Infinity;
    },
  };
}
export function isCanvasTextInput(
  target: EventTarget | null,
  surface: HTMLElement,
): boolean {
  if (!(target instanceof Element)) return false;
  // React portals bubble through the surface, but their controls own focus.
  if (!surface.contains(target)) return true;
  const control = target.closest(
    "input,textarea,select,[contenteditable=true],[role=textbox],[role=menu],[role=dialog],[data-canvas-note-controls]",
  );
  // A settings dialog containing the whole canvas is not a canvas input.
  return control !== null && surface.contains(control);
}
export function noteDimensions(note: CanvasNote): {
  width: number;
  height: number;
} {
  if (note.type === "line" || note.type === "arrow")
    return {
      width: Math.max(
        12,
        Math.abs((note.x2 ?? (note.x ?? 0) + (note.w ?? 200)) - (note.x ?? 0)),
      ),
      height: Math.max(
        12,
        Math.abs((note.y2 ?? (note.y ?? 0) + (note.h ?? 160)) - (note.y ?? 0)),
      ),
    };
  return {
    width: Math.max(
      12,
      note.w ?? note.maxW ?? (note.type === "title" ? 320 : 200),
    ),
    height: Math.max(12, note.h ?? (note.type === "title" ? 64 : 160)),
  };
}
/** "boards/sign-in.html" reads as "sign-in" when the agent gave no title. */
export function boardName(path: string): string {
  return (path.split("/").at(-1) ?? path).replace(/\.html?$/i, "");
}
