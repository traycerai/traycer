import { useState } from "react";
import type { ArtboardEdit } from "@traycer/protocol/host/epic/artboard-edit";
import { useArtboardEdit } from "./use-artboard-edit";
import { isCanvasStructureEdit } from "./canvas-structure-identity";
import {
  sameCanvasElement,
  useCanvasSelectionStore,
  type CanvasSelection,
} from "./canvas-selection-store";

export function canvasSelectionIsCurrent(target: CanvasSelection): boolean {
  const state = useCanvasSelectionStore.getState();
  const current = state.selection;
  return (
    state.pendingPick === null &&
    current !== null &&
    current.artifactId === target.artifactId &&
    current.boardPath === target.boardPath &&
    current.servedSha256 === target.servedSha256 &&
    sameCanvasElement(current.element, target.element)
  );
}
export function useCanvasEditAction(artifactId: string) {
  // An edit committed on blur often outlives its field (clicking away closes
  // it), so the save runs even after unmount; only its message is then moot.
  const mutation = useArtboardEdit(artifactId);
  const [message, setMessage] = useState<string | null>(null);
  const apply = async (
    selection: CanvasSelection,
    edit: ArtboardEdit,
  ): Promise<boolean> => {
    if (selection.element.generated) {
      setMessage("Ask the agent to change this element.");
      return false;
    }
    try {
      setMessage(null);
      const result = await mutation.mutateAsync({
        selection,
        edit,
        ...(isCanvasStructureEdit(edit)
          ? {
              structureGeneration:
                useCanvasSelectionStore.getState().generation,
            }
          : {}),
      });
      if (!result.ok) setMessage(result.detail);
      return result.ok;
    } catch {
      setMessage("The change could not be saved. Try again.");
      return false;
    }
  };
  return { apply, message, setMessage, pending: mutation.isPending };
}
