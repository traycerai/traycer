import { useRef, useState } from "react";
import type { CanvasNote } from "@traycer/protocol/persistence/epic/canvas-layout";
import type { Viewport } from "@xyflow/react";
import type { CanvasPoint, CanvasTool } from "./canvas-model";
import { noteFromStroke, type CanvasStroke } from "./canvas-geometry";
export function CanvasDrawingLayer({
  tool,
  viewport,
  toCanvas,
  onCreate,
}: {
  readonly tool: CanvasTool;
  readonly viewport: Viewport;
  readonly toCanvas: (point: CanvasPoint) => CanvasPoint;
  readonly onCreate: (note: CanvasNote) => void;
}) {
  const active = useRef<CanvasStroke | null>(null);
  const [preview, setPreview] = useState<CanvasStroke | null>(null);
  const update = (stroke: CanvasStroke | null): void => {
    active.current = stroke;
    setPreview(stroke);
  };
  return (
    <div
      className="absolute inset-0 cursor-crosshair touch-none"
      aria-label={`Draw ${tool}`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const start = toCanvas({ x: event.clientX, y: event.clientY });
        event.currentTarget.setPointerCapture(event.pointerId);
        update({
          start,
          end: start,
          points: [[start.x, start.y, event.pressure || 0.5]],
        });
      }}
      onPointerMove={(event) => {
        const stroke = active.current;
        if (stroke === null) return;
        const end = toCanvas({ x: event.clientX, y: event.clientY });
        update({
          ...stroke,
          end,
          points:
            tool === "pen" && stroke.points.length < 20000
              ? [...stroke.points, [end.x, end.y, event.pressure || 0.5]]
              : stroke.points,
        });
      }}
      onPointerCancel={() => update(null)}
      onPointerUp={(event) => {
        const stroke = active.current;
        if (stroke === null) return;
        update(null);
        const end = toCanvas({ x: event.clientX, y: event.clientY });
        if (tool === "select" || tool === "hand") return;
        const points: readonly [number, number, number][] = [
          ...stroke.points.slice(0, 19999),
          [end.x, end.y, event.pressure || 0.5],
        ];
        const note = noteFromStroke(tool, { ...stroke, end, points });
        onCreate(note);
      }}
    >
      {preview === null ? null : (
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
          aria-hidden="true"
        >
          <g
            transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}
          >
            <StrokePreview tool={tool} preview={preview} />
          </g>
        </svg>
      )}
    </div>
  );
}

function StrokePreview({
  tool,
  preview,
}: {
  readonly tool: CanvasTool;
  readonly preview: CanvasStroke;
}) {
  if (tool === "pen")
    return (
      <polyline
        points={preview.points
          .map((point) => `${point[0]},${point[1]}`)
          .join(" ")}
        stroke="var(--foreground)"
        fill="none"
        strokeWidth="4"
      />
    );
  if (tool === "line" || tool === "arrow")
    return (
      <line
        x1={preview.start.x}
        y1={preview.start.y}
        x2={preview.end.x}
        y2={preview.end.y}
        stroke="var(--foreground)"
        strokeWidth="2"
      />
    );
  return (
    <rect
      x={Math.min(preview.start.x, preview.end.x)}
      y={Math.min(preview.start.y, preview.end.y)}
      width={Math.abs(preview.end.x - preview.start.x)}
      height={Math.abs(preview.end.y - preview.start.y)}
      fill="var(--primary)"
      fillOpacity="0.1"
      stroke="var(--primary)"
      strokeWidth="1"
    />
  );
}
