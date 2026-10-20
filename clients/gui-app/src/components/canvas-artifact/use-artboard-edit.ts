import { isCanvasStructureEdit } from "./canvas-structure-identity";
import type { HostRpcRegistry } from "@traycer/protocol/host";
import type {
  ArtboardEdit,
  ArtboardElementLocator,
  EpicEditArtboardRequest,
} from "@traycer/protocol/host/epic/artboard-edit";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useEpicStore } from "@/hooks/use-epic-store";
import {
  sameCanvasElement,
  useCanvasSelectionStore,
  type CanvasSelection,
} from "./canvas-selection-store";

export interface CanvasEditVariables {
  readonly selection: CanvasSelection;
  readonly edit: ArtboardEdit;
  readonly structureGeneration?: number;
}
interface CanvasEditContext {
  readonly hostId: string | null;
}
function canReuseSelection(
  current: CanvasSelection | null,
  selection: CanvasSelection,
): current is CanvasSelection {
  return (
    current !== null &&
    current.artifactId === selection.artifactId &&
    current.boardPath === selection.boardPath &&
    sameCanvasElement(current.element, selection.element) &&
    (current.servedSha256 === selection.servedSha256 ||
      (selection.element.tid !== null &&
        current.element.tid === selection.element.tid))
  );
}
function structureSelectionIsCurrent(
  selection: CanvasSelection,
  generation: number | undefined,
): boolean {
  const state = useCanvasSelectionStore.getState();
  return (
    state.pendingPick === null &&
    state.generation === generation &&
    canReuseSelection(state.selection, selection) &&
    state.selection.servedSha256 === selection.servedSha256
  );
}

export function useArtboardEdit(artifactId: string) {
  const client = useTabHostClient();
  const epicId = useEpicStore((state) => state.epicId);
  return useHostMutation<
    HostRpcRegistry,
    "epic.editArtboard",
    CanvasEditContext,
    CanvasEditVariables
  >({
    client,
    method: "epic.editArtboard",
    mapVariables: ({
      selection,
      edit,
      structureGeneration,
    }): EpicEditArtboardRequest => {
      if (selection.artifactId !== artifactId)
        throw new Error("Select an element to edit.");
      const current = useCanvasSelectionStore.getState().selection;
      const structural = isCanvasStructureEdit(edit);
      if (
        structural &&
        !structureSelectionIsCurrent(selection, structureGeneration)
      )
        throw new Error("The selection changed. Select the elements again.");
      // A previous queued edit may have inserted its tid. Reuse that identity,
      // but never borrow a new selection's offset or its served revision.
      const element = canReuseSelection(current, selection)
        ? current.element
        : selection.element;
      let locator: ArtboardElementLocator | null = null;
      if (element.tid !== null && !structural)
        locator = { kind: "tid", tid: element.tid };
      else if (selection.element.marker !== null)
        locator = {
          kind: "position",
          startTagOffset: selection.element.marker,
          tagName: selection.element.tagName,
        };
      if (locator === null)
        throw new Error(
          "This element has no editable source. Ask the agent to change it.",
        );
      return {
        epicId,
        artifactId,
        boardPath: selection.boardPath,
        servedSha256: selection.servedSha256,
        locator,
        fallbackTid: element.tid,
        edit,
      };
    },
    options: {
      scope: {
        id: `canvas-edit:${client?.getActiveHostId() ?? ""}:${epicId}:${artifactId}`,
      },
      retry: false,
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: (
        result,
        { selection, edit, structureGeneration },
        context,
      ) => {
        if (!result.ok || context.hostId !== client?.getActiveHostId()) return;
        const state = useCanvasSelectionStore.getState();
        if (
          isCanvasStructureEdit(edit) &&
          state.generation !== structureGeneration
        )
          return;
        const current = state.selection;
        if (!canReuseSelection(current, selection)) return;
        if (edit.kind === "delete-element" || edit.kind === "unwrap-element")
          state.clear();
        else if (edit.kind === "wrap-elements" && result.tid !== null)
          // Adopt the new wrapper's identity; the next served frame supplies
          // its description and geometry. Added children stop being selected.
          state.select({
            ...current,
            element: { ...current.element, marker: null, tid: result.tid },
            textRange: null,
          });
        else if (result.tid !== null)
          state.updateTid(
            artifactId,
            selection.boardPath,
            selection.element.marker,
            result.tid,
          );
        // Keep servedSha256 frozen until the replacement frame supplies its
        // revision; subsequent edits can resolve via the acknowledged tid.
      },
      // Errors and normal refusals are rendered inline by the properties panel.
    },
  });
}
