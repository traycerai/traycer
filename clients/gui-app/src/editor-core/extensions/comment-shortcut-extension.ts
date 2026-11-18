import { Extension, type Editor } from "@tiptap/core";

export interface CommentShortcutExtensionOptions {
  /**
   * Fires on `Cmd/Ctrl + Alt + M`. Receives the live editor so the host
   * can read the current selection and call `startCommentDraft`. Returning
   * `true` swallows the keystroke; returning `false` lets ProseMirror fall
   * through (which the host should do when the selection is collapsed so
   * the toast / no-op behavior is consistent with the toolbar button).
   */
  readonly onTrigger: ((editor: Editor) => boolean) | null;
}

/**
 * Tiptap extension that binds the global comment-thread shortcut. Implemented
 * as a thin keymap-only extension (no commands, no schema) so it can be
 * conditionally injected - viewers and editors both get it; tiles whose
 * artifact type doesn't support comments (chat) simply skip it.
 *
 * The actual draft-creation logic lives in `lib/comments/start-comment-draft`
 * so the toolbar button and this shortcut share one implementation.
 */
export const CommentShortcutExtension =
  Extension.create<CommentShortcutExtensionOptions>({
    name: "commentShortcut",

    addOptions() {
      return { onTrigger: null };
    },

    addKeyboardShortcuts() {
      return {
        "Mod-Alt-m": () => {
          const handler = this.options.onTrigger;
          if (handler === null) return false;
          return handler(this.editor);
        },
      };
    },
  });
