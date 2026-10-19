import { useId, useLayoutEffect, useRef, type CSSProperties } from "react";
import { parse, wcagContrast } from "culori";
import type { CanvasNote } from "@traycer/protocol/persistence/epic/canvas-layout";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
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
  viewOnly,
  editing,
  onEdit,
  onCommit,
  onGrow,
}: {
  readonly note: CanvasNote;
  readonly viewOnly: boolean | undefined;
  readonly editing: boolean | undefined;
  readonly onEdit: (() => void) | undefined;
  readonly onCommit: (text: string) => void;
  readonly onGrow: ((height: number) => void) | undefined;
}) {
  const title = note.type === "title";
  const content = useRef<HTMLDivElement>(null);
  const measured = useRef<{
    element: HTMLElement;
    height: number;
  } | null>(null);
  useLayoutEffect(() => {
    const element = content.current?.querySelector("[data-canvas-note-text]");
    if (!(element instanceof HTMLElement) || onGrow === undefined || viewOnly)
      return;
    const measure = (): void => {
      const height = element.scrollHeight;
      if (
        measured.current?.element === element &&
        measured.current.height === height
      )
        return;
      measured.current = { element, height };
      onGrow(height);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [onGrow, editing, viewOnly]);
  return (
    <div
      ref={content}
      className={cn(
        "h-full w-full text-(--canvas-note-color) text-(length:--canvas-note-size) leading-normal",
        title && "font-heading font-semibold",
      )}
      style={
        {
          "--canvas-note-color": title
            ? (note.color ?? "var(--foreground)")
            : stickyTextColor(note.color),
          "--canvas-note-size": `${note.size ?? (title ? 30 : 14)}px`,
        } as CSSProperties
      }
    >
      {editing && !viewOnly ? (
        <CanvasTextNoteEditor note={note} onCommit={onCommit} onGrow={onGrow} />
      ) : (
        <CanvasTextNoteDisplay
          note={note}
          viewOnly={viewOnly}
          onEdit={onEdit}
        />
      )}
    </div>
  );
}
function CanvasTextNoteDisplay({
  note,
  viewOnly,
  onEdit,
}: {
  readonly note: CanvasNote;
  readonly viewOnly: boolean | undefined;
  readonly onEdit: (() => void) | undefined;
}) {
  const label = note.type === "title" ? "Edit title" : "Edit sticky note";
  return (
    <div
      role={viewOnly ? undefined : "button"}
      tabIndex={viewOnly ? undefined : 0}
      aria-label={viewOnly ? undefined : label}
      className="min-h-full w-full whitespace-pre-wrap break-words"
      onDoubleClick={() => {
        if (!viewOnly) onEdit?.();
      }}
      onKeyDown={(event) => {
        if (!viewOnly && event.code === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          onEdit?.();
        }
      }}
    >
      {/* Measure intrinsic text, never the minimum height inherited from the note. */}
      <div data-canvas-note-text="">
        {note.text || <span className="opacity-50">Type something</span>}
      </div>
    </div>
  );
}
function stickyTextColor(color: string | undefined): string {
  const parsed = color === undefined ? undefined : parse(color);
  if (parsed === undefined) return "var(--card-foreground)";
  return wcagContrast(parsed, "#202020") >= wcagContrast(parsed, "#ffffff")
    ? "#202020"
    : "#ffffff";
}
function CanvasTextNoteEditor({
  note,
  onCommit,
  onGrow,
}: {
  readonly note: CanvasNote;
  readonly onCommit: (text: string) => void;
  readonly onGrow: ((height: number) => void) | undefined;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = input.current;
    if (element === null) return;
    element.focus({ preventScroll: true });
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);
  return (
    <textarea
      ref={input}
      data-canvas-note-text=""
      aria-label={note.type === "title" ? "Title text" : "Sticky note text"}
      placeholder="Type something"
      defaultValue={note.text ?? ""}
      rows={1}
      // Canvas typography is document content, not the app's form-control scale.
      className="touch-auto canvas-nopan canvas-nowheel field-sizing-content block w-full resize-none overflow-hidden border-0 bg-transparent p-0 whitespace-pre-wrap break-words outline-none placeholder:text-current placeholder:opacity-50"
      onInput={(event) => onGrow?.(event.currentTarget.scrollHeight)}
      onBlur={(event) => onCommit(event.currentTarget.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.code === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
      onKeyUp={(event) => event.stopPropagation()}
    />
  );
}
export function CanvasNoteContent({
  note,
  imageSource,
  viewOnly,
  editing,
  onEdit,
  onCommit,
  onGrow,
}: {
  readonly note: CanvasNote;
  readonly viewOnly?: boolean;
  readonly editing?: boolean;
  readonly onEdit?: () => void;
  readonly onGrow?: (height: number) => void;
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
    return (
      <CanvasTextNote
        viewOnly={viewOnly}
        editing={editing}
        onEdit={onEdit}
        note={note}
        onCommit={onCommit}
        onGrow={onGrow}
      />
    );
  return <CanvasShape note={note} />;
}
