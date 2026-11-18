import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  setAttribute,
  setStyleDeclaration,
  type EditResult,
  type ElementLocator,
} from "@traycer/html-source";
import type { ArtboardEdit } from "@traycer/protocol/host/epic/artboard-edit";
import { CanvasCodeTab } from "@/components/canvas-artifact/canvas-code-tab";
import "@/index.css";

/**
 * THE CODE TAB OVER A REAL SOURCE EDIT, PAINTED BY CHROME.
 *
 * The real `CanvasCodeTab` (real `browserSupportsCss`, so Chrome's own
 * `CSS.supports` validates what is typed) emits its edit, and this page applies
 * it to a small HTML source with the real `@traycer/html-source` and renders the
 * result into `#board`. `browser-tests/canvas-editing.spec.ts` then reads the
 * rendered element's computed style: whether a shorthand written before or
 * after a longhand wins is Chrome's cascade, which jsdom resolves wrongly.
 *
 * Both edit kinds are applied (`set-attribute` and the older per-property
 * `set-style`), so a code tab that went back to planning per-property edits
 * would change the rendered result and fail the spec.
 *
 * `?hold` keeps every save pending until the "Settle save" button answers it,
 * which is how the spec observes the tab while the host is still answering.
 */
const INITIAL_STYLE = "margin-left:5px; margin:10px";
const ELEMENT_ID = "target";
const LOCATOR: ElementLocator = {
  kind: "position",
  startTagOffset: 0,
  tagName: "div",
};
const HOLD_SAVES = new URLSearchParams(window.location.search).has("hold");

function sourceWithStyle(style: string): string {
  return `<div id="${ELEMENT_ID}" style="${style}">Styled</div>`;
}

function styleOf(source: string): string {
  return (
    new DOMParser()
      .parseFromString(source, "text/html")
      .getElementById(ELEMENT_ID)
      ?.getAttribute("style") ?? ""
  );
}

function applyEdit(source: string, edit: ArtboardEdit): EditResult | null {
  switch (edit.kind) {
    case "set-attribute":
      return setAttribute(source, LOCATOR, edit.name, edit.value);
    case "set-style":
      return setStyleDeclaration(source, LOCATOR, edit.property, edit.value);
    default:
      return null;
  }
}

export function CanvasEditingFixture() {
  const [source, setSource] = useState(() => sourceWithStyle(INITIAL_STYLE));
  const [pending, setPending] = useState(false);
  const [saves, setSaves] = useState(0);
  const board = useRef<HTMLDivElement>(null);
  const sourceRef = useRef(source);
  const settle = useRef<(() => void) | null>(null);

  // The board is the edited source painted as the document it is.
  useEffect(() => {
    if (board.current !== null) board.current.innerHTML = source;
  }, [source]);

  const onApply = async (edits: readonly ArtboardEdit[]): Promise<boolean> => {
    setPending(true);
    setSaves((count) => count + 1);
    if (HOLD_SAVES) {
      await new Promise<void>((resolve) => {
        settle.current = resolve;
      });
    }
    let next = sourceRef.current;
    for (const edit of edits) {
      const result = applyEdit(next, edit);
      if (result === null || !result.ok) {
        setPending(false);
        return false;
      }
      next = result.text;
    }
    sourceRef.current = next;
    setSource(next);
    setPending(false);
    return true;
  };

  return (
    <div className="grid w-full max-w-sm gap-3 p-4">
      <div id="board" ref={board} />
      <CanvasCodeTab
        inlineStyle={styleOf(source)}
        disabled={false}
        pending={pending}
        onApply={onApply}
        onMessage={() => undefined}
      />
      <button
        type="button"
        onClick={() => {
          settle.current?.();
          settle.current = null;
        }}
      >
        Settle save
      </button>
      <output data-testid="counters">{`saves=${saves} pending=${pending}`}</output>
    </div>
  );
}

const container = document.querySelector("#root");
if (container === null) throw new Error("fixture root missing");
createRoot(container).render(<CanvasEditingFixture />);
