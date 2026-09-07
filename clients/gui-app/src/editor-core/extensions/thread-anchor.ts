import { Mark, mergeAttributes } from "@tiptap/core";

/** Parse/render must match the shared Views schema or Y.Doc round-trips drop anchors. UI state lives on CommentDecorationsExtension, not mark attrs. */
export const ThreadAnchor = Mark.create({
  name: "threadAnchor",
  inclusive: false,
  excludes: "",

  addAttributes() {
    return {
      threadId: {
        default: null,
        parseHTML: (element): string | null =>
          element.getAttribute("data-thread-id"),
        renderHTML: (attrs): Record<string, string> =>
          attrs.threadId === null || attrs.threadId === ""
            ? {}
            : { "data-thread-id": String(attrs.threadId) },
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-thread-id]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { class: "thread-anchor" }),
      0,
    ];
  },
});
