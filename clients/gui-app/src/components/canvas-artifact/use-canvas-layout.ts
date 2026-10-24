import { useMemo, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { useEpicArtifactFragment } from "@/lib/epic-selectors";
import {
  CanvasLayoutStore,
  type CanvasLayoutState,
} from "./canvas-layout-store";

export function useCanvasLayout(artifactId: string): CanvasLayoutStore | null {
  // The fragment accessor leases the body and returns its projection, including
  // all four layout roots. It never reads the root epic document.
  const fragment = useEpicArtifactFragment(artifactId);
  return useCanvasLayoutDocument(fragment?.doc ?? null, artifactId);
}
export function useCanvasLayoutDocument(
  doc: Y.Doc | null,
  artifactId: string,
): CanvasLayoutStore | null {
  return useMemo(
    () => (doc === null ? null : new CanvasLayoutStore(doc, artifactId)),
    [doc, artifactId],
  );
}
export function useCanvasLayoutState(
  store: CanvasLayoutStore,
): CanvasLayoutState {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}
