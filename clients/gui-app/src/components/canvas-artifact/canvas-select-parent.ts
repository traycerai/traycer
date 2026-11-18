import type { CanvasFrameRegistry } from "./canvas-frame-registry";
import {
  isCanvasBoardRoot,
  useCanvasSelectionStore,
  type CanvasSelection,
} from "./canvas-selection-store";
import { canvasSelectionIsCurrent } from "./use-canvas-edit-action";
import { frameLocator } from "./canvas-structure-identity";

/**
 * Moves the selection to the selected element's nearest literal ancestor, the
 * way Shift+Enter does in design tools. The hit test picks the deepest element
 * under the pointer, so this is how a reader reaches the container it sits in.
 * Resolves `false` when the page changed underneath the request.
 */
export async function selectCanvasParentElement(
  selection: CanvasSelection,
  registry: CanvasFrameRegistry,
): Promise<boolean> {
  const bridge = registry.get(selection.boardPath).bridge;
  if (bridge === null) return false;
  const generation = useCanvasSelectionStore.getState().generation;
  try {
    const element = await bridge.literalAncestor(
      frameLocator(selection.element) ?? {
        selector: selection.element.selector,
      },
    );
    if (
      registry.get(selection.boardPath).bridge !== bridge ||
      useCanvasSelectionStore.getState().generation !== generation ||
      !canvasSelectionIsCurrent(selection)
    )
      return false;
    if (element === null || isCanvasBoardRoot(element))
      useCanvasSelectionStore.getState().clear();
    else
      useCanvasSelectionStore.getState().select({
        ...selection,
        element,
        textRange: null,
      });
    return true;
  } catch {
    return false;
  }
}
