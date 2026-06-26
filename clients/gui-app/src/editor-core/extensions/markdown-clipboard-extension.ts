import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

import { sliceToDocJson } from "@/lib/editor/prosemirror-json";

/**
 * Makes Cmd+C / Cmd+X from an artifact editor copy Markdown instead of
 * ProseMirror's default `textContent` - which drops `#`, `-`, `1.`, fences and
 * double-spaces every block.
 *
 * The copied slice is wrapped into a doc and run through the same
 * `@tiptap/markdown` manager that backs `editor.getMarkdown()`, so headings,
 * lists, task lists, tables and mermaid / wireframe fences all serialize through
 * their registered renderers. Contributed as a ProseMirror plugin prop (read by
 * `view.someProp`) so the behavior travels with the extension bundle.
 *
 * Must be registered alongside the `Markdown` extension, whose storage owns the
 * manager.
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
