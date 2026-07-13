import type { AnyExtension, Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { Placeholder } from "@tiptap/extensions";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { CollabUser } from "../awareness/derive-collab-user";
import { FencePromotionExtension } from "../nodes/shared/fence-promotion-extension";
import { artifactDocumentBundle } from "../artifact-document-bundle";
import { CommentDecorationsExtension } from "./comment-decorations-extension";
import { CommentShortcutExtension } from "./comment-shortcut-extension";
import { MarkdownClipboard } from "./markdown-clipboard-extension";
import { ArtifactFindExtension } from "./artifact-find-extension";

/**
 * `@tiptap/extension-collaboration-caret` only reads `provider.awareness` off
 * the object it's given - the full Hocuspocus provider surface is not used
 * here because awareness is owned by the per-epic store and shipped through
 * the host stream.
 */
export interface ArtifactAwarenessProvider {
  readonly awareness: Awareness;
}

export interface BuildArtifactExtensionsParams {
  readonly doc: Y.Doc;
  readonly fragment: Y.XmlFragment;
  readonly awareness: Awareness;
  readonly user: CollabUser;
  /**
   * Wired by tiles whose artifact type supports comments (spec / ticket /
   * story / review). `null` for unsupported tiles (chat) - the shortcut
   * extension still mounts but no-ops on the keystroke.
   */
  readonly onCommentShortcut: ((editor: Editor) => boolean) | null;
  /**
   * Empty-document hint rendered by the `Placeholder` extension. Shown only
   * while the doc is empty AND the editor is editable (Tiptap default), so
   * viewers and streamed agent docs never see it. The visual comes from the
   * `.tc-editor-prose .is-editor-empty::before` rule in `styles/editor.css`.
   */
  readonly placeholderText: string;
  /**
   * Hint rendered inside an empty leading level-1 heading - the Notion-style
   * "title line" a hand-created artifact opens on (see
   * `seedArtifactTitleHeading`). Distinct from `placeholderText` (the body
   * hint) so the title line prompts for a title, not a description.
   */
  readonly titlePlaceholderText: string;
}

/**
 * Placeholder text for a given empty node: the title hint for the doc's
 * leading level-1 heading (the "title line"), else the body hint. Exported for
 * unit tests; the live wiring passes this to `Placeholder`'s function form.
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

/**
 * Opinionated Tiptap extension bundle for Traycer artifact editors
 * (specs, ticket reviews, stories). Opinionated means: collaboration is
 * required - there is no non-collab variant; the Yjs undo manager replaces
 * Tiptap's history; markdown is the canonical serialization; and the node
 * vocabulary is fixed (headings, lists, task lists, tables, code blocks
 * with syntax highlighting, horizontal rules, blockquotes, inline code).
 *
 * Consumers pass in the doc + fragment + awareness + user; the returned
 * array can be handed straight to `useEditor({ extensions })`.
 */
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
    // Cmd+C / Cmd+X -> Markdown (via the `Markdown` manager above) instead of
    // ProseMirror's default textContent, which drops `#` / `-` / `1.` / fences
    // and double-spaces every block. Registered right after `Markdown` so the
    // manager its serializer reads is already in storage.
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
    // Inline-decoration plugin painting active / hover / resolved / draft
    // visual state over `threadAnchor` ranges. Driven by the React layer via
    // `applyCommentDecorationSnapshot(editor, ...)` so the persisted doc
    // never carries UI-only attrs.
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

  return artifactDocumentBundle.extensions.flatMap((extension) =>
    extension.name === "markdown"
      ? [extension, ...editorOnlyExtensions]
      : [extension],
  );
}

/**
 * Class applied to the ProseMirror content root via `editorProps.attributes`.
 * The `tc-editor-prose` suffix scopes the workspace-specific tweaks
 * (task-list bullet reset, table borders, code-block chrome) shipped from
 * `styles/editor.css`.
 */
export const ARTIFACT_EDITOR_CONTENT_CLASS =
  "prose prose-sm sm:prose-base dark:prose-invert md-prose max-w-none focus:outline-none tc-editor-prose";
