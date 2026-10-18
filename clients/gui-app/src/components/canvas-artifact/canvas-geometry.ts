import { getStroke } from "perfect-freehand";
import { z } from "zod";
import type { CanvasNote } from "@traycer/protocol/persistence/epic/canvas-layout";
import type { CanvasPoint, CanvasTool } from "./canvas-model";

export interface CanvasStroke {
  readonly start: CanvasPoint;
  readonly end: CanvasPoint;
  readonly points: readonly [number, number, number][];
}
const pointsSchema = z
  .array(z.tuple([z.number(), z.number(), z.number()]))
  .max(20000);
export function penOutline(
  points: string | undefined,
  size: number,
): { path: string; width: number; height: number } {
  const empty = { path: "", width: 1, height: 1 };
  let raw: unknown;
  try {
    raw = JSON.parse(points ?? "[]");
  } catch {
    return empty;
  }
  const parsed = pointsSchema.safeParse(raw);
  if (!parsed.success || parsed.data.length === 0) return empty;
  const outline = getStroke(parsed.data, {
    size,
    thinning: 0.5,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: true,
  });
  return {
    path:
      outline.length === 0
        ? ""
        : `M ${outline.map((point) => point.join(",")).join(" L ")} Z`,
    width: Math.max(12, ...parsed.data.map((point) => point[0])),
    height: Math.max(12, ...parsed.data.map((point) => point[1])),
  };
}
export function noteFromStroke(
  tool: Exclude<CanvasTool, "select" | "hand" | "comment">,
  stroke: CanvasStroke,
): CanvasNote {
  if (tool === "pen") return penFromStroke(stroke);
  const x = Math.min(stroke.start.x, stroke.end.x),
    y = Math.min(stroke.start.y, stroke.end.y);
  const width = Math.abs(stroke.end.x - stroke.start.x),
    height = Math.abs(stroke.end.y - stroke.start.y);
  const defaultWidth = tool === "title" ? 320 : 200;
  const defaultHeight = tool === "title" ? 64 : 160;
  const note: CanvasNote = {
    type: tool,
    x,
    y,
    w: Math.max(12, width < 5 ? defaultWidth : width),
    h: Math.max(12, height < 5 ? defaultHeight : height),
  };
  if (tool === "line" || tool === "arrow")
    return {
      ...note,
      x: stroke.start.x,
      y: stroke.start.y,
      x2: stroke.end.x,
      y2: stroke.end.y,
      w: Math.max(12, width),
      h: Math.max(12, height),
    };
  if (tool === "sticky" || tool === "title")
    note.text = tool === "title" ? "Title" : "";
  return note;
}
function penFromStroke(stroke: CanvasStroke): CanvasNote {
  const x = Math.min(...stroke.points.map((point) => point[0])),
    y = Math.min(...stroke.points.map((point) => point[1]));
  const w = Math.max(
    12,
    Math.max(...stroke.points.map((point) => point[0])) - x,
  );
  const h = Math.max(
    12,
    Math.max(...stroke.points.map((point) => point[1])) - y,
  );
  return {
    type: "pen",
    x,
    y,
    w,
    h,
    size: 4,
    points: JSON.stringify(
      stroke.points.map((point) => [point[0] - x, point[1] - y, point[2]]),
    ),
  };
}
export interface NoteResizeFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
/** Endpoints are canvas coordinates; resizing preserves the arrow's direction. */
export function resizedNote(
  note: CanvasNote,
  frame: NoteResizeFrame,
): CanvasNote {
  const patch: CanvasNote = {
    x: frame.x,
    y: frame.y,
    w: frame.width,
    h: frame.height,
  };
  if (note.type !== "line" && note.type !== "arrow") return patch;
  const horizontal = resizeAxis(note.x ?? 0, note.x2, frame.x, frame.width);
  const vertical = resizeAxis(note.y ?? 0, note.y2, frame.y, frame.height);
  return {
    ...patch,
    x: horizontal.start,
    x2: horizontal.end,
    y: vertical.start,
    y2: vertical.end,
  };
}
function resizeAxis(
  start: number,
  end: number | undefined,
  origin: number,
  size: number,
): { start: number; end: number } {
  if (end === start) return { start: origin, end: origin };
  return (end ?? start + size) < start
    ? { start: origin + size, end: origin }
    : { start: origin, end: origin + size };
}
