import { Mark, mergeAttributes } from "@tiptap/core";

/**
 * Tiptap mark mirroring the `threadAnchor` definition in the internal shared
 * Epic-persistence document schema.
 *
 * Storage parity with Views is required: the same Y.Doc round-trips through
 * Tiptap Cloud, so the parse/render shape MUST match the shared schema or
 * gui-app will silently drop anchors authored in Views (and vice versa).
 *
 * Visual state (active / hover / resolved / draft) is layered by
 * `CommentDecorationsExtension` as inline decorations, not by mark attrs,
 * so the persisted document never carries UI-only data.
 */
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
