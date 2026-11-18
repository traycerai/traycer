import { useEditor, type Editor } from "@tiptap/react";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import {
  buildArtifactExtensions,
  ARTIFACT_EDITOR_CONTENT_CLASS,
  type CollabUser,
} from "@/editor-core";
import { AnchorReporter } from "@/editor-core/extensions/anchor-reporter-extension";
import { useAnchorPositionsStore } from "@/stores/comments/anchor-positions-store";

interface UseCollabTileEditorParams {
  readonly doc: Y.Doc;
  readonly fragment: Y.XmlFragment;
  readonly awareness: Awareness;
  readonly editable: boolean;
  /**
   * Caret identity for CollaborationCaret. Resolved by the consumer from
   * the auth store so two tabs on the same machine logged into different
   * users render distinct remote carets. Must be stable across re-renders
   * for a single (userId × epicId) - callers typically memoize.
   */
  readonly user: CollabUser;
  /**
   * Wired through to `CommentShortcutExtension` (`Cmd+Opt+M`). Pass `null`
   * for tiles whose artifact type doesn't support comments - the extension
   * still mounts but the keystroke is a no-op.
   */
  readonly onCommentShortcut: ((editor: Editor) => boolean) | null;
  /**
   * Identifier pair routed through the `AnchorReporter` extension so
   * `useAnchorPositionsStore` knows which (epicId, artifactId) bucket to
   * write the latest threadAnchor positions into. Pass `null` when the
   * artifact doesn't support comments - the reporter is then omitted.
   */
  readonly anchorScope: {
    readonly epicId: string;
    readonly artifactId: string;
  } | null;
  /**
   * Empty-document hint for the `Placeholder` extension. Derived from the
   * artifact kind by the consumer so a spec and a ticket can prompt
   * differently.
   */
  readonly placeholderText: string;
  /**
   * Hint shown inside an empty leading level-1 heading (the Notion-style
   * title line). Kind-agnostic.
   */
  readonly titlePlaceholderText: string;
}

/**
 * Mounts a Tiptap `Editor` bound to a Y.XmlFragment via the shared artifact
 * extension bundle. The caller gates this hook until the fragment is present
 * so Tiptap never boots a placeholder editor and then swaps it under the same
 * React mount.
 */
export function useCollabTileEditor(
  params: UseCollabTileEditorParams,
): Editor | null {
  const {
    doc,
    fragment,
    awareness,
    editable,
    user,
    onCommentShortcut,
    anchorScope,
    placeholderText,
    titlePlaceholderText,
  } = params;

  const setAnchorPositions = useAnchorPositionsStore((s) => s.setForArtifact);

  const editor = useEditor(
    {
      extensions: [
        ...buildArtifactExtensions({
          doc,
          fragment,
          awareness,
          user,
          onCommentShortcut,
          placeholderText,
          titlePlaceholderText,
        }),
        ...(anchorScope === null
          ? []
          : [
              AnchorReporter.configure({
                epicId: anchorScope.epicId,
                artifactId: anchorScope.artifactId,
                onAnchorsChanged: setAnchorPositions,
              }),
            ]),
      ],
      editable,
      immediatelyRender: false,
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: {
          class: ARTIFACT_EDITOR_CONTENT_CLASS,
          "data-artifact-editor": "",
        },
      },
    },
    // `user.name` / `user.color` intentionally not in deps - caret identity
    // is advertised through awareness without a full editor rebuild.
    // `onCommentShortcut` intentionally not in deps - the extension reads
    // it via `this.options` so a callback identity flip does not require
    // rebuilding the editor.
    [
      doc,
      fragment,
      awareness,
      editable,
      anchorScope?.epicId,
      anchorScope?.artifactId,
      placeholderText,
      titlePlaceholderText,
    ],
  );

  return editor;
}
