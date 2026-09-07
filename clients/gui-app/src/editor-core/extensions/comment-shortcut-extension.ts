import { Extension, type Editor } from "@tiptap/core";

export interface CommentShortcutExtensionOptions {
  /** Return true to swallow. Return false on collapsed selection so the toast matches the toolbar button. */
  readonly onTrigger: ((editor: Editor) => boolean) | null;
}

/** Keymap-only comment shortcut; skip on chat tiles. Draft creation lives in lib/comments/start-comment-draft. */
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
