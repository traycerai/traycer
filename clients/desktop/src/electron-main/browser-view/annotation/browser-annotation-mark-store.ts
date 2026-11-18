/**
 * The overlay's live mark stack: the marks themselves, their DOM nodes, and the
 * per-element identity keys. Owns node attach/detach so callers never leak an
 * outline, badge or ink path.
 */
import type { StrokePoint } from "./browser-annotation-overlay-ink";
import type { OverlayMarkModel } from "./browser-annotation-overlay-logic";

export interface LiveMark {
  model: OverlayMarkModel;
  element: Element | null;
  points: StrokePoint[] | null;
  outline: HTMLElement | null;
  badge: HTMLElement | null;
  haloPath: SVGPathElement | null;
  haloDarkPath: SVGPathElement | null;
  inkPath: SVGPathElement | null;
  invalid: boolean;
}

export interface MarkStore {
  readonly entries: readonly LiveMark[];
  /** Stable per-element key, minted on first sight. */
  readonly keyOf: (el: Element) => string;
  readonly push: (entry: LiveMark) => void;
  readonly remove: (entry: LiveMark) => void;
  readonly removeById: (id: string) => void;
  /** Drops every mark and its nodes without notifying. */
  readonly clear: () => void;
  readonly findElement: (key: string) => LiveMark | null;
  readonly elementCount: () => number;
  readonly clearInvalid: () => void;
}

function destroyMarkNodes(entry: LiveMark): void {
  entry.outline?.remove();
  entry.badge?.remove();
  entry.haloPath?.remove();
  entry.haloDarkPath?.remove();
  entry.inkPath?.remove();
}

export function createMarkStore(input: {
  readonly layer: HTMLElement;
  readonly paint: (entry: LiveMark) => void;
  readonly onChanged: () => void;
}): MarkStore {
  const marks: LiveMark[] = [];
  const elementKeys = new WeakMap<Element, string>();
  let keySeq = 0;

  function removeAt(index: number): void {
    const entry = marks[index];
    if (entry === undefined) return;
    destroyMarkNodes(entry);
    marks.splice(index, 1);
    input.onChanged();
  }

  return {
    entries: marks,
    keyOf: (el) => {
      const existing = elementKeys.get(el);
      if (existing !== undefined) return existing;
      keySeq += 1;
      const key = "el-" + String(keySeq);
      elementKeys.set(el, key);
      return key;
    },
    push: (entry) => {
      marks.push(entry);
      if (entry.outline) input.layer.appendChild(entry.outline);
      if (entry.badge) input.layer.appendChild(entry.badge);
      input.onChanged();
    },
    remove: (entry) => {
      removeAt(marks.indexOf(entry));
    },
    removeById: (id) => {
      removeAt(marks.findIndex((entry) => entry.model.id === id));
    },
    clear: () => {
      for (const entry of marks) destroyMarkNodes(entry);
      marks.length = 0;
    },
    findElement: (key) => {
      for (const entry of marks) {
        if (entry.model.kind === "element" && entry.model.elementKey === key) {
          return entry;
        }
      }
      return null;
    },
    elementCount: () => {
      let count = 0;
      for (const entry of marks) {
        if (entry.model.kind === "element") count += 1;
      }
      return count;
    },
    clearInvalid: () => {
      for (const entry of marks) {
        if (!entry.invalid) continue;
        entry.invalid = false;
        input.paint(entry);
      }
    },
  };
}
