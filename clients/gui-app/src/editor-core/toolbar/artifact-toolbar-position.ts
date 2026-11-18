import type { Editor } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";

export const artifactToolbarPluginKey = new PluginKey("artifactToolbar");

export function createArtifactToolbarOptions(scrollTarget: HTMLElement | null) {
  const boundary = scrollTarget ?? undefined;
  return {
    scrollTarget: boundary,
    flip: { boundary, padding: 4 },
    shift: { boundary, padding: 4 },
    hide: { boundary },
  };
}

/** Hide the mounted selection toolbar without unregistering its plugin. */
export function hideArtifactToolbar(editor: Editor): void {
  if (artifactToolbarPluginKey.get(editor.state) === undefined) return;
  editor.view.dispatch(
    editor.state.tr.setMeta(artifactToolbarPluginKey, "hide"),
  );
}

/** Restore and position the mounted selection toolbar after suppression. */
export function showArtifactToolbar(editor: Editor): void {
  if (artifactToolbarPluginKey.get(editor.state) === undefined) return;
  editor.view.dispatch(
    editor.state.tr.setMeta(artifactToolbarPluginKey, "show"),
  );
  editor.view.dispatch(
    editor.state.tr.setMeta(artifactToolbarPluginKey, "updatePosition"),
  );
}

/** Reposition the selection toolbar immediately from a tile scroll event. */
export function updateArtifactToolbarPosition(editor: Editor): void {
  if (editor.state.selection.empty) return;
  if (artifactToolbarPluginKey.get(editor.state) === undefined) return;
  editor.view.dispatch(
    editor.state.tr.setMeta(artifactToolbarPluginKey, "updatePosition"),
  );
}
