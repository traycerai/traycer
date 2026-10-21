import { NodeToolbar, Position } from "@xyflow/react";
import type { CSSProperties } from "react";
import type { CanvasNote } from "@traycer/protocol/persistence/epic/canvas-layout";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useCanvasNodeActions } from "./canvas-node-context";

const TEXT_SIZES = [
  { label: "S", name: "Small text", sticky: 14, title: 20 },
  { label: "M", name: "Medium text", sticky: 18, title: 30 },
  { label: "L", name: "Large text", sticky: 24, title: 40 },
  { label: "XL", name: "Extra large text", sticky: 32, title: 56 },
] as const;
const NOTE_COLORS = [
  { name: "Default", value: "var(--card)" },
  { name: "Yellow", value: "#fff3a3" },
  { name: "Pink", value: "#ffd7df" },
  { name: "Blue", value: "#dbeafe" },
  { name: "Green", value: "#d1fae5" },
  { name: "Purple", value: "#e9ddff" },
] as const;
const INK_COLORS = [
  { name: "Default", value: "var(--foreground)" },
  { name: "Grey", value: "#808080" },
  { name: "Red", value: "#e45454" },
  { name: "Blue", value: "#5086e8" },
  { name: "Green", value: "#37976b" },
  { name: "Purple", value: "#a879d9" },
] as const;

function isTextNote(note: CanvasNote): boolean {
  return (
    note.type === undefined || note.type === "sticky" || note.type === "title"
  );
}

function noteColorLabel(note: CanvasNote): string {
  if (note.type === undefined || note.type === "sticky") return "Note colour";
  if (note.type === "title") return "Text colour";
  return "Stroke colour";
}

function CanvasNoteSizes({
  id,
  note,
}: {
  readonly id: string;
  readonly note: CanvasNote;
}) {
  const actions = useCanvasNodeActions();
  const title = note.type === "title";
  const size = note.size ?? (title ? 30 : 14);
  return (
    <div
      role="group"
      aria-label="Text size"
      className="flex items-center gap-0.5"
    >
      {TEXT_SIZES.map((preset) => {
        const value = title ? preset.title : preset.sticky;
        return (
          <TooltipWrapper
            key={preset.label}
            label={preset.name}
            side="top"
            sideOffset={4}
            align="center"
          >
            <Button
              type="button"
              size="segment"
              variant="ghost"
              aria-label={preset.name}
              aria-pressed={size === value}
              disabled={actions.viewOnly}
              onClick={() => actions.updateNote(id, { size: value })}
            >
              {preset.label}
            </Button>
          </TooltipWrapper>
        );
      })}
    </div>
  );
}

function CanvasNoteColors({
  id,
  note,
}: {
  readonly id: string;
  readonly note: CanvasNote;
}) {
  const actions = useCanvasNodeActions();
  const sticky = note.type === undefined || note.type === "sticky";
  const label = noteColorLabel(note);
  const colors = sticky ? NOTE_COLORS : INK_COLORS;
  const color = note.color ?? colors[0].value;
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-wrap items-center gap-0.5"
    >
      {colors.map((swatch) => (
        <TooltipWrapper
          key={swatch.name}
          label={swatch.name}
          side="top"
          sideOffset={4}
          align="center"
        >
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={`${label}: ${swatch.name}`}
            aria-pressed={color === swatch.value}
            disabled={actions.viewOnly}
            onClick={() => actions.updateNote(id, { color: swatch.value })}
          >
            <span
              aria-hidden="true"
              className="size-3.5 rounded-full border border-foreground/20 bg-(--canvas-note-swatch)"
              style={{ "--canvas-note-swatch": swatch.value } as CSSProperties}
            />
          </Button>
        </TooltipWrapper>
      ))}
    </div>
  );
}

export function CanvasNoteToolbar({
  id,
  note,
  visible,
}: {
  readonly id: string;
  readonly note: CanvasNote;
  readonly visible: boolean;
}) {
  if (!isTextNote(note)) return null;
  return (
    <NodeToolbar isVisible={visible} position={Position.Top} offset={12}>
      <div
        role="toolbar"
        tabIndex={-1}
        aria-label="Note formatting"
        data-canvas-note-controls=""
        className="touch-auto canvas-nopan canvas-nowheel flex items-center gap-1 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
        // Keep the caret in the note while applying its formatting.
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <CanvasNoteSizes id={id} note={note} />
        <div className="border-l pl-1">
          <CanvasNoteColors id={id} note={note} />
        </div>
      </div>
    </NodeToolbar>
  );
}

export function CanvasNoteProperties({
  id,
  note,
}: {
  readonly id: string;
  readonly note: CanvasNote;
}) {
  if (note.type === "image") return null;
  return (
    <div
      role="group"
      aria-label="Note properties"
      data-canvas-note-controls=""
      className="flex flex-col gap-4"
    >
      {isTextNote(note) ? (
        <div className="space-y-2">
          <p className="text-ui-xs text-muted-foreground">Text size</p>
          <CanvasNoteSizes id={id} note={note} />
        </div>
      ) : null}
      <div className="space-y-2">
        <p className="text-ui-xs text-muted-foreground">
          {noteColorLabel(note)}
        </p>
        <CanvasNoteColors id={id} note={note} />
      </div>
    </div>
  );
}
