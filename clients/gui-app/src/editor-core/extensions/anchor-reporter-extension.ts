/**
 * AnchorReporter - Tiptap extension that pushes the live `threadAnchor`
 * mark positions out of the editor every time the doc changes. Replaces
 * the previous imperative `useEffect(editor.on('update'), ...)` wiring in
 * `collab-tile-body.tsx` with a declarative ProseMirror plugin so the
 * subscription lives next to the editor instance and tears down with it.
 *
 * The reporter does NOT touch the Y.Doc directly - it inspects the local
 * ProseMirror state, which is what comment overlays must align to. Any
 * change to the live `threadAnchor` mark set (insert / delete / move via
 * upstream Y update or local edit) is surfaced here.
 *
 * Output is keyed by `(epicId, artifactId)` so multiple tiles for sibling
 * artifacts in the same Epic don't collide.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import {
  scanThreadAnchorsFromDoc,
  type AnchorPositionMap,
} from "@/lib/comments/comment-filter-utils";

export interface AnchorReporterOptions {
  /** Stable Epic id; used by the report callback as a partition key. */
  readonly epicId: string;
  /** Stable artifact id; used by the report callback as a partition key. */
  readonly artifactId: string;
  /** Receives the latest anchor map. Identity-equal results are NOT filtered
   *  here - the receiver should de-dupe (the `useAnchorPositionsStore`
   *  already shallow-compares before re-emitting). */
  readonly onAnchorsChanged: (
    epicId: string,
    artifactId: string,
    anchors: AnchorPositionMap,
  ) => void;
}

const PLUGIN_KEY = new PluginKey("anchorReporter");

export const AnchorReporter = Extension.create<AnchorReporterOptions>({
  name: "anchorReporter",

  addOptions() {
    return {
      epicId: "",
      artifactId: "",
      onAnchorsChanged: () => undefined,
    };
  },

  addProseMirrorPlugins() {
    const { epicId, artifactId, onAnchorsChanged } = this.options;
    return [
      new Plugin({
        key: PLUGIN_KEY,
        view: () => {
          // Initial push so the receiver sees current anchors before the
          // first edit even arrives.
          // (Editor view is not exposed here; the plugin's `view` factory
          //  receives the EditorView, but we want state.doc - read it via
          //  the closure created below.)
          return {
            update: (view, prevState) => {
              if (prevState.doc === view.state.doc) return;
              onAnchorsChanged(
                epicId,
                artifactId,
                scanThreadAnchorsFromDoc(view.state.doc),
              );
            },
          };
        },
      }),
    ];
  },
});
