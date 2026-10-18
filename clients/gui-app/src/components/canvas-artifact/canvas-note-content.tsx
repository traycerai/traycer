import { useId, useState, type CSSProperties } from "react";
import type { CanvasNote } from "@traycer/protocol/persistence/epic/canvas-layout";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { CanvasImage } from "./canvas-image";
import { penOutline } from "./canvas-geometry";
import { noteDimensions } from "./canvas-model";
function lineAxis(
  start: number,
  end: number | undefined,
  size: number,
): { start: number; end: number } {
  const endpoint = end ?? start + size;
  const origin = Math.min(start, endpoint);
  return { start: start - origin, end: endpoint - origin };
}
function CanvasLine({ note }: { readonly note: CanvasNote }) {
  const markerId = useId();
  const { width, height } = noteDimensions(note);
  const horizontal = lineAxis(note.x ?? 0, note.x2, note.w ?? 200);
  const vertical = lineAxis(note.y ?? 0, note.y2, note.h ?? 160);
  const color = note.color ?? "var(--foreground)";
  return (
    <svg
      className="h-full w-full overflow-visible"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-label={note.type}
    >
      <defs>
        <marker
          id={markerId}
          markerWidth="10"
          markerHeight="10"
          refX="8"
          refY="3"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M0,0 L0,6 L9,3 z" fill={color} />
        </marker>
      </defs>
      <line
        x1={horizontal.start}
        y1={vertical.start}
        x2={horizontal.end}
        y2={vertical.end}
        stroke={color}
        strokeWidth={note.size ?? 2}
        markerEnd={note.type === "arrow" ? `url(#${markerId})` : undefined}
      />
    </svg>
  );
}
function CanvasShape({ note }: { readonly note: CanvasNote }) {
  const { width, height } = noteDimensions(note);
  const color = note.color ?? "var(--foreground)";
  if (note.type === "line" || note.type === "arrow")
    return <CanvasLine note={note} />;
  if (note.type === "pen") {
    const pen = penOutline(note.points, note.size ?? 4);
    return (
      <svg
        className="h-full w-full overflow-visible"
        viewBox={`0 0 ${pen.width} ${pen.height}`}
        preserveAspectRatio="none"
        aria-label="Pen stroke"
      >
        <path d={pen.path} fill={color} />
      </svg>
    );
  }
  return (
    <svg
      className="h-full w-full overflow-visible"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-label={note.type}
    >
      {note.type === "rect" ? (
        <rect
          x="1"
          y="1"
          width={Math.max(1, width - 2)}
          height={Math.max(1, height - 2)}
          rx="4"
          fill="none"
          stroke={color}
          strokeWidth={note.size ?? 2}
        />
      ) : (
        <ellipse
          cx={width / 2}
          cy={height / 2}
          rx={Math.max(1, width / 2 - 2)}
          ry={Math.max(1, height / 2 - 2)}
          fill="none"
          stroke={color}
          strokeWidth={note.size ?? 2}
        />
      )}
    </svg>
  );
}
function CanvasTextNote({
  note,
  onCommit,
}: {
  readonly note: CanvasNote;
  readonly onCommit: (text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const text = note.text ?? "";
  if (editing)
    return (
      <div className="touch-auto overscroll-contain h-full">
        <Textarea
          variant="bare"
          size="sm"
          aria-label={note.type === "title" ? "Title text" : "Sticky note text"}
          defaultValue={text}
          ref={(node) => node?.focus()}
          onBlur={(event) => {
            onCommit(event.currentTarget.value);
            setEditing(false);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.code === "Escape") event.currentTarget.blur();
          }}
        />
      </div>
    );
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Edit ${note.type === "title" ? "title" : "sticky note"}`}
      className={cn(
        "h-full w-full whitespace-pre-wrap break-words text-(--canvas-note-color) text-(length:--canvas-note-size)",
        note.type === "title" && "font-heading font-semibold",
      )}
      style={
        {
          "--canvas-note-color": note.color ?? "var(--foreground)",
          "--canvas-note-size": `${note.size ?? (note.type === "title" ? 30 : 14)}px`,
        } as CSSProperties
      }
      onDoubleClick={() => setEditing(true)}
      onKeyDown={(event) => {
        if (event.code === "Enter") {
          event.stopPropagation();
          setEditing(true);
        }
      }}
    >
      {text || (note.type === "title" ? "Title" : "Write a note")}
    </div>
  );
}
export function CanvasNoteContent({
  note,
  imageSource,
  onCommit,
}: {
  readonly note: CanvasNote;
  readonly imageSource: SandboxSource | null;
  readonly onCommit: (text: string) => void;
}) {
  if (note.type === "image")
    return (
      <CanvasImage source={imageSource} label={note.text || "Canvas image"} />
    );
  if (
    note.type === undefined ||
    note.type === "sticky" ||
    note.type === "title"
  )
    return <CanvasTextNote note={note} onCommit={onCommit} />;
  return <CanvasShape note={note} />;
}
