import { useState, type CSSProperties, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { CanvasNote } from "@traycer/protocol/persistence/epic/canvas-layout";
import { CanvasNoteContent } from "@/components/canvas-artifact/canvas-note-content";
import { cn } from "@/lib/utils";
import "@/index.css";

/**
 * The real `CanvasNoteContent`, in its production wrapper, at a live-resizable
 * pixel width - proof a real browser has to give, since jsdom's `offsetWidth`
 * and `clientWidth` are always 0.
 *
 * Query: `type` (`title`, default, or `sticky`), `text` (initial note text,
 * `\n` for a literal newline), `viewOnly`, `h` (initial box height).
 */

const params = new URLSearchParams(window.location.search);
const type = params.get("type") === "sticky" ? "sticky" : "title";
const initialText = params.get("text") ?? "A perfectly reasonable board title";
const viewOnly = params.has("viewOnly");
const defaultHeightForType = type === "title" ? 64 : 160;
const initialHeight = params.has("h")
  ? Number(params.get("h"))
  : defaultHeightForType;

export function NoteFitFixture(): ReactNode {
  const [text, setText] = useState(initialText);
  const [width, setWidth] = useState(400);
  const [height, setHeight] = useState(initialHeight);
  const [editing, setEditing] = useState(false);
  const [growCount, setGrowCount] = useState(0);

  const note: CanvasNote = { type, text };

  return (
    <div style={{ padding: 24 }}>
      <div
        data-testid="note-box"
        style={{ width, height, outline: "1px solid #999" }}
      >
        <div
          className={cn(
            "relative h-full w-full",
            type === "sticky" &&
              "rounded-sm border border-border bg-(--canvas-note-fill) p-3 shadow-sm",
            type === "title" && "p-1",
          )}
          style={
            {
              "--canvas-note-fill": "var(--card)",
            } as CSSProperties
          }
        >
          <CanvasNoteContent
            note={note}
            imageSource={null}
            viewOnly={viewOnly}
            editing={editing}
            onEdit={() => setEditing(true)}
            onCommit={(next) => {
              setText(next);
              setEditing(false);
            }}
            onGrow={(measuredHeight) => {
              setGrowCount((count) => count + 1);
              const padding = type === "title" ? 8 : 26;
              const next = Math.ceil(measuredHeight + padding);
              if (measuredHeight > 0 && next > height) setHeight(next);
            }}
          />
        </div>
      </div>

      <div style={{ marginTop: 16, display: "grid", gap: 8, maxWidth: 400 }}>
        <label>
          Box width: {width}px
          <input
            id="note-width"
            type="range"
            min={80}
            max={640}
            step={1}
            value={width}
            onChange={(event) => setWidth(Number(event.currentTarget.value))}
          />
        </label>
        <button type="button" onClick={() => setEditing((current) => !current)}>
          {editing ? "Stop editing" : "Edit note"}
        </button>
        <output data-testid="grow-count">{growCount}</output>
      </div>
    </div>
  );
}

const container = document.querySelector("#root");
if (container === null) throw new Error("fixture root missing");
createRoot(container).render(<NoteFitFixture />);
