import { mergeAttributes, Node as TiptapNode } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";

import {
  FILE_ATTACHMENT_NODE_TYPE,
  fileAttachmentSizeValue,
  type ComposerFileAttachmentAttrs,
} from "@/lib/composer/file-attachments";

import { FileAttachmentNodeView } from "../nodes/file-attachment-node-view";
import { dataAttributeMap } from "./attribute-helpers";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    fileAttachment: {
      insertFileAttachment: (attrs: ComposerFileAttachmentAttrs) => ReturnType;
    };
  }
}

/**
 * A non-image file the author attached, by hash (`common/file-attachment.ts`).
 * The node's whole lifecycle after insertion - pending until the host holds the
 * bytes, then stored, or removed on a failed upload - is applied by its node
 * view from the upload registry (`lib/composer/file-attachment-upload.ts`), so
 * the only command is the insert.
 */
export const FileAttachmentNode = TiptapNode.create({
  name: FILE_ATTACHMENT_NODE_TYPE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  draggable: false,

  addAttributes() {
    return {
      ...dataAttributeMap([
        "id",
        "hash",
        "fileName",
        "mediaType",
        "uploadState",
      ]),
      // Parsed back to a number: the wire schema requires one, and an HTML
      // clipboard round trip hands every data attribute back as a string.
      size: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          fileAttachmentSizeValue(element.getAttribute("data-size")),
        renderHTML: (attributes: Record<string, unknown>) => {
          const size = fileAttachmentSizeValue(attributes.size);
          return size === null ? {} : { "data-size": String(size) };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-composer-file-attachment]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-composer-file-attachment": "",
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(FileAttachmentNodeView);
  },

  addCommands() {
    return {
      insertFileAttachment:
        (attrs) =>
        ({ commands, state }) => {
          const content = { type: FILE_ATTACHMENT_NODE_TYPE, attrs };
          if (state.selection.empty) return commands.insertContent(content);
          return commands.insertContentAt(state.selection.to, content);
        },
    };
  },
});
