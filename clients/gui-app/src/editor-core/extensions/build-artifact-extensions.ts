import type { AnyExtension, Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { Placeholder } from "@tiptap/extensions";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { CollabUser } from "../awareness/derive-collab-user";
import { FencePromotionExtension } from "../nodes/shared/fence-promotion-extension";
import {
  artifactDocumentBundle,
  createArtifactMarkdownExtension,
} from "../artifact-document-bundle";
import { CommentDecorationsExtension } from "./comment-decorations-extension";
import { CommentShortcutExtension } from "./comment-shortcut-extension";
import { MarkdownClipboard } from "./markdown-clipboard-extension";
import { ArtifactFindExtension } from "./artifact-find-extension";

/** Caret extension only reads provider.awareness. Awareness lives on the per-epic store and ships through the host stream. */
export interface ArtifactAwarenessProvider {
  readonly awareness: Awareness;
}

export interface BuildArtifactExtensionsParams {
  readonly doc: Y.Doc;
  readonly fragment: Y.XmlFragment;
  readonly awareness: Awareness;
  readonly user: CollabUser;
  /**
   * null for chat. Shortcut still mounts but no-ops on the keystroke.
   */
  readonly onCommentShortcut: ((editor: Editor) => boolean) | null;
  /**
   * Empty+editable only. Visual is .tc-editor-prose .is-editor-empty::before.
   */
  readonly placeholderText: string;
  /**
   * Empty leading h1 title hint. Distinct from placeholderText (body).
   */
  readonly titlePlaceholderText: string;
}

/**
 * Title hint for a leading empty h1, else the body hint. Exported for tests.
 */
export function resolveArtifactPlaceholderText(params: {
  readonly nodeTypeName: string;
  readonly headingLevel: number | null;
  readonly pos: number;
  readonly titlePlaceholderText: string;
  readonly placeholderText: string;
}): string {
  const isLeadingTitleHeading =
    params.pos === 0 &&
    params.nodeTypeName === "heading" &&
    params.headingLevel === 1;
  return isLeadingTitleHeading
    ? params.titlePlaceholderText
    : params.placeholderText;
}

/** Collab is required; Yjs undo replaces history; markdown is canonical. Pass doc + fragment + awareness + user. */
export function buildArtifactExtensions(
  params: BuildArtifactExtensionsParams,
): AnyExtension[] {
  const {
    doc,
    fragment,
    awareness,
    user,
    onCommentShortcut,
    placeholderText,
    titlePlaceholderText,
  } = params;
  const provider: ArtifactAwarenessProvider = { awareness };

  const editorOnlyExtensions: AnyExtension[] = [
    // Cmd+C/X copy Markdown, not textContent (which drops # / - / fences).
    // Register after Markdown so the serializer's manager is in storage.
    MarkdownClipboard,
    Collaboration.configure({ document: doc, fragment }),
    CollaborationCaret.configure({
      provider,
      user: { name: user.name, color: user.color },
    }),
    // Promotion plugin watches for `codeBlock(language=mermaid|wireframe)`
    // (from live typing, paste, or streamed content) and swaps each into
    // the corresponding rich atom after a ~400ms idle window.
    FencePromotionExtension,
    // Comment decorations over threadAnchor. UI state is not persisted on
    // the doc.
    CommentDecorationsExtension,
    // Tile-local find paints search matches and tracks the active match in
    // ProseMirror document positions rather than mounted DOM text.
    ArtifactFindExtension,
    // Global Cmd+Opt+M shortcut to start a comment draft from the current
    // selection. Mounted on every artifact editor; tiles that don't support
    // comments pass `onCommentShortcut: null` so the keystroke is a no-op.
    CommentShortcutExtension.configure({ onTrigger: onCommentShortcut }),
    Placeholder.configure({
      placeholder: ({ node, pos }) =>
        resolveArtifactPlaceholderText({
          nodeTypeName: node.type.name,
          headingLevel:
            typeof node.attrs.level === "number" ? node.attrs.level : null,
          pos,
          titlePlaceholderText,
          placeholderText,
        }),
    }),
  ];

  // Replace the template Markdown with a private marked instance per editor.
  // Tokenizers must not accumulate on the module singleton.
  return artifactDocumentBundle.extensions.flatMap((extension) =>
    extension.name === "markdown"
      ? [createArtifactMarkdownExtension(), ...editorOnlyExtensions]
      : [extension],
  );
}

/**
 * ProseMirror root class; tc-editor-prose scopes editor.css tweaks.
 */
export const ARTIFACT_EDITOR_CONTENT_CLASS =
  "prose prose-sm sm:prose-base dark:prose-invert md-prose max-w-none focus:outline-none tc-editor-prose";
