import type { Editor } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";

export const artifactToolbarPluginKey = new PluginKey("artifactToolbar");

/** Reposition the selection toolbar immediately from a tile scroll event. */
export function updateArtifactToolbarPosition(editor: Editor): void {
  if (editor.state.selection.empty) return;
  if (artifactToolbarPluginKey.get(editor.state) === undefined) return;
  editor.view.dispatch(
    editor.state.tr.setMeta(artifactToolbarPluginKey, "updatePosition"),
  );
}
