export type ArtifactEditorBackgroundFocusPosition = "start" | "end" | number;

export interface ArtifactEditorBackgroundFocusEditor {
  readonly isDestroyed: boolean;
  readonly isEmpty: boolean;
  readonly view: {
    readonly dom: HTMLElement;
    posAtCoords(coords: {
      readonly left: number;
      readonly top: number;
    }): { readonly pos: number; readonly inside: number } | null;
  };
}

interface ShouldHandleArtifactEditorBackgroundFocusParams {
  readonly editor: ArtifactEditorBackgroundFocusEditor;
  readonly eventButton: number;
  readonly eventTarget: EventTarget;
  readonly rootElement: HTMLElement;
  readonly clientX: number;
}

const EDITOR_CHROME_SELECTOR =
  "button, a[href], input, textarea, select, [role='button'], " +
  ".tc-editor-toolbar, .tc-editor-bubble-menu, .tc-node-block-toolbar";

export function shouldHandleArtifactEditorBackgroundFocus(
  params: ShouldHandleArtifactEditorBackgroundFocusParams,
): boolean {
  if (params.eventButton !== 0) return false;
  if (params.editor.isDestroyed) return false;
  if (!(params.eventTarget instanceof Element)) return false;
  if (params.editor.view.dom.contains(params.eventTarget)) return false;
  if (
    params.eventTarget === params.rootElement &&
    isInVerticalScrollbarGutter(params.rootElement, params.clientX)
  ) {
    return false;
  }

  const chromeTarget = params.eventTarget.closest(EDITOR_CHROME_SELECTOR);
  return chromeTarget === null || !params.rootElement.contains(chromeTarget);
}

function isInVerticalScrollbarGutter(
  element: HTMLElement,
  clientX: number,
): boolean {
  if (element.scrollHeight <= element.clientHeight) return false;

  const rect = element.getBoundingClientRect();
  const scrollbarWidth = rect.width - element.clientWidth;
  if (scrollbarWidth <= 0) return false;

  return clientX >= rect.right - scrollbarWidth;
}

export function resolveArtifactEditorBackgroundFocusPosition(
  editor: ArtifactEditorBackgroundFocusEditor,
  clientX: number,
  clientY: number,
): ArtifactEditorBackgroundFocusPosition {
  if (editor.isEmpty) return "start";

  const mappedPosition = editor.view.posAtCoords({
    left: clientX,
    top: clientY,
  });
  if (mappedPosition !== null) return mappedPosition.pos;

  const editorRect = editor.view.dom.getBoundingClientRect();
  return clientY < editorRect.top ? "start" : "end";
}
