import { useLayoutEffect, useRef, useState } from "react";
import type { ArtboardEdit } from "@traycer/protocol/host/epic/artboard-edit";
import type { CanvasSiblingLayout } from "@/lib/sandbox/canvas-layout-bridge";
import type { CanvasFrameRegistry } from "./canvas-frame-registry";
import {
  CANVAS_LAYOUT_CHANGED_NOTE,
  frameLocator,
} from "./canvas-structure-identity";
import {
  useCanvasSelectionStore,
  type CanvasSelection,
} from "./canvas-selection-store";
import {
  canvasSelectionIsCurrent,
  useCanvasEditAction,
} from "./use-canvas-edit-action";

export function useCanvasStructureAction(
  selection: CanvasSelection,
  registry: CanvasFrameRegistry,
  layout: CanvasSiblingLayout | null,
) {
  const action = useCanvasEditAction(selection.artifactId);
  const active = useRef(false);
  const busy = useRef(false);
  const [checking, setChecking] = useState(false);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const apply = async (edit: ArtboardEdit | null): Promise<void> => {
    const entry = registry.get(selection.boardPath);
    const bridge = entry.bridge;
    const locator = frameLocator(selection.element);
    if (
      edit === null ||
      layout === null ||
      bridge === null ||
      locator === null ||
      busy.current ||
      action.pending
    )
      return;
    const generation = useCanvasSelectionStore.getState().generation;
    const current = (): boolean =>
      active.current &&
      canvasSelectionIsCurrent(selection) &&
      useCanvasSelectionStore.getState().generation === generation &&
      registry.get(selection.boardPath).bridge === bridge &&
      registry.get(selection.boardPath).sha256 === selection.servedSha256;
    if (!current()) {
      action.setMessage(CANVAS_LAYOUT_CHANGED_NOTE);
      return;
    }
    busy.current = true;
    setChecking(true);
    action.setMessage(null);
    try {
      const fresh = await bridge.siblingLayout(locator);
      if (!current() || JSON.stringify(fresh) !== JSON.stringify(layout)) {
        if (active.current) action.setMessage(CANVAS_LAYOUT_CHANGED_NOTE);
        return;
      }
      await action.apply(selection, edit);
    } catch {
      if (active.current)
        action.setMessage("The layout could not be read. Try again.");
    } finally {
      busy.current = false;
      if (active.current) setChecking(false);
    }
  };
  return {
    apply,
    message: action.message,
    setMessage: action.setMessage,
    pending: action.pending || checking,
  };
}
