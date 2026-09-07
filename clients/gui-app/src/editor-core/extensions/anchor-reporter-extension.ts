/**
 * Push live `threadAnchor` positions from ProseMirror state (not Y.Doc). Keyed by `(epicId, artifactId)`.
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
          // Push current anchors before the first edit. Read state.doc via the
          // closure below; the view factory has EditorView but we want the doc.
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
