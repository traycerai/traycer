import { mergeAttributes, Node as TiptapNode } from "@tiptap/core";

export const AttachmentGroupNode = TiptapNode.create({
  name: "attachmentGroup",
  group: "block",
  content: "imageAttachment+",
  isolating: true,
  selectable: false,
  draggable: false,
  defining: true,

  parseHTML() {
    return [{ tag: "div[data-composer-attachment-group]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-composer-attachment-group": "",
        style: "display: none;",
      }),
      0,
    ];
  },
});
