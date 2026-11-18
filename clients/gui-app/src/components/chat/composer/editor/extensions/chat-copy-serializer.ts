import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

import { composerClipboardTextSerializer } from "@/lib/composer/composer-clipboard";

/**
 * Makes Cmd+C / Cmd+X from the composer write structured plain text (list
 * markers, mentions, slash commands) to the clipboard instead of ProseMirror's
 * default `textContent` - which drops `-` / `1.` markers and double-spaces every
 * block.
 *
 * Contributed as a ProseMirror plugin prop (read by `view.someProp`) rather than
 * via the React `editorProps` so the behavior travels with the extension bundle
 * and is exercised by `serializeForClipboard` in tests.
 */
export const ChatCopySerializer = Extension.create({
  name: "chatCopySerializer",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("chatCopySerializer"),
        props: {
          clipboardTextSerializer: (slice) =>
            composerClipboardTextSerializer(slice),
        },
      }),
    ];
  },
});
