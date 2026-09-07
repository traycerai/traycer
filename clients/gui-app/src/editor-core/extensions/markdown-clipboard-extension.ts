import { Extension } from "@tiptap/core";
import type { Fragment, Slice } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";

import { sliceToDocJson } from "@/lib/editor/prosemirror-json";

/**
 * Copy Markdown, not ProseMirror `textContent`. Must sit beside the `Markdown` extension whose storage owns the manager.
 */
export const MarkdownClipboard = Extension.create({
  name: "markdownClipboard",
  addProseMirrorPlugins() {
    const { editor } = this;
    return [
      new Plugin({
        key: new PluginKey("markdownClipboard"),
        props: {
          clipboardTextSerializer: (slice) => {
            const codeText = selectedCodeText(slice);
            if (codeText !== null) return codeText;
            const doc = sliceToDocJson(slice);
            if (doc === null) {
              return slice.content.textBetween(0, slice.content.size, "\n");
            }
            return editor.storage.markdown.manager.serialize(doc);
          },
        },
      }),
    ];
  },
});

function selectedCodeText(slice: Slice): string | null {
  let content: Fragment = slice.content;
  let depth = 0;
  while (content.childCount === 1) {
    const onlyChild = content.firstChild;
    if (onlyChild === null) return null;
    if (onlyChild.type.name === "codeBlock") {
      const codeBlockIsOpen = depth < slice.openStart && depth < slice.openEnd;
      return codeBlockIsOpen ? onlyChild.textContent : null;
    }
    content = onlyChild.content;
    depth += 1;
  }
  return null;
}
