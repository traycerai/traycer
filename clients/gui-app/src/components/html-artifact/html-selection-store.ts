import { create } from "zustand";
import type {
  CanvasBox,
  CanvasElement,
  CanvasTextSelection,
} from "@/lib/sandbox/canvas-bridge";

export type HtmlSelection =
  | { readonly kind: "page" }
  | {
      readonly kind: "element";
      readonly element: CanvasElement;
      readonly servedSha256: string | null;
    }
  | {
      readonly kind: "text";
      readonly element: CanvasElement;
      readonly range: CanvasTextSelection;
      readonly servedSha256: string | null;
    };

interface HtmlSelectionEntry {
  readonly enabled: boolean;
  readonly selection: HtmlSelection | null;
  readonly generation: number;
  readonly pending: boolean;
}

interface HtmlSelectionState {
  readonly byArtifact: ReadonlyMap<string, HtmlSelectionEntry>;
  readonly setEnabled: (artifactId: string, enabled: boolean) => void;
  readonly clearSelection: (artifactId: string) => void;
  readonly beginPick: (artifactId: string) => number | null;
  readonly completePick: (
    artifactId: string,
    generation: number,
    element: CanvasElement | null,
    servedSha256: string | null,
  ) => void;
  readonly setTextRange: (
    artifactId: string,
    range: CanvasTextSelection | null,
  ) => void;
  readonly updateBox: (
    artifactId: string,
    generation: number,
    box: CanvasBox | null,
  ) => void;
}

function sameElement(a: CanvasElement, b: CanvasElement): boolean {
  if (a.tid !== null && b.tid !== null) return a.tid === b.tid;
  if (a.marker !== null || b.marker !== null) return a.marker === b.marker;
  return a.selector === b.selector;
}

/** Selection is local to this window and never changes the artifact itself. */
export const useHtmlSelectionStore = create<HtmlSelectionState>((set, get) => {
  const write = (artifactId: string, entry: HtmlSelectionEntry): void => {
    set((state) => ({
      byArtifact: new Map(state.byArtifact).set(artifactId, entry),
    }));
  };
  return {
    byArtifact: new Map(),
    setEnabled: (artifactId, enabled) => {
      const current = get().byArtifact.get(artifactId);
      write(artifactId, {
        enabled,
        selection: null,
        generation: (current?.generation ?? 0) + 1,
        pending: false,
      });
    },
    clearSelection: (artifactId) => {
      const current = get().byArtifact.get(artifactId);
      if (current === undefined) return;
      write(artifactId, {
        ...current,
        selection: null,
        generation: current.generation + 1,
        pending: false,
      });
    },
    beginPick: (artifactId) => {
      const current = get().byArtifact.get(artifactId);
      if (current?.enabled !== true) return null;
      const generation = current.generation + 1;
      write(artifactId, {
        ...current,
        selection: null,
        generation,
        pending: true,
      });
      return generation;
    },
    completePick: (artifactId, generation, element, servedSha256) => {
      const current = get().byArtifact.get(artifactId);
      if (
        !current?.enabled ||
        current.generation !== generation ||
        !current.pending
      )
        return;
      const tag = element?.tagName.toLowerCase();
      const selection: HtmlSelection =
        element === null || tag === "html" || tag === "body"
          ? { kind: "page" }
          : { kind: "element", element, servedSha256 };
      write(artifactId, { ...current, selection, pending: false });
    },
    setTextRange: (artifactId, range) => {
      const current = get().byArtifact.get(artifactId);
      const selected = current?.selection ?? null;
      if (
        !current?.enabled ||
        current.pending ||
        selected === null ||
        selected.kind === "page" ||
        (range !== null && !sameElement(selected.element, range.element))
      )
        return;
      const base = {
        element: selected.element,
        servedSha256: selected.servedSha256,
      };
      write(artifactId, {
        ...current,
        selection:
          range === null ||
          range.quote.length === 0 ||
          range.start === range.end
            ? { kind: "element", ...base }
            : { kind: "text", ...base, range },
      });
    },
    updateBox: (artifactId, generation, box) => {
      const current = get().byArtifact.get(artifactId);
      const selected = current?.selection ?? null;
      if (
        current === undefined ||
        current.generation !== generation ||
        current.pending ||
        selected === null ||
        selected.kind === "page"
      )
        return;
      if (box === null) {
        get().clearSelection(artifactId);
        return;
      }
      write(artifactId, {
        ...current,
        selection: { ...selected, element: { ...selected.element, box } },
      });
    },
  };
});
