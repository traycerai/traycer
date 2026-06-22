import { mergeAttributes, Node as TiptapNode } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";

import { ImageAttachmentNodeView } from "../nodes/image-attachment-node-view";
import {
  dataAttributeMap,
  IMAGE_ATTACHMENT_ATTRIBUTE_NAMES,
} from "./attribute-helpers";

interface ImageAttachmentBaseAttrs {
  readonly id: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number | null;
}

/**
 * An image node carries EXACTLY ONE payload:
 * - `b64content` — inline base64. Chat / new-conversation paste, and the landing
 *   submit re-inline, build nodes this way; the host ingests + hashes it.
 * - `hash` — a content hash into the per-runtime landing image store. The landing
 *   composer pastes hash-only nodes so persisted draft content never carries
 *   base64; bytes are resolved back to base64 at submit time.
 *
 * The `?: never` on the absent field makes the union mutually exclusive: a node
 * can present `b64content` or `hash`, never both, never neither.
 */
export type ImageAttachmentAttrs =
  | (ImageAttachmentBaseAttrs & {
      readonly b64content: string;
      readonly hash?: never;
    })
  | (ImageAttachmentBaseAttrs & {
      readonly hash: string;
      readonly b64content?: never;
    });

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    imageAttachment: {
      // eslint-disable-next-line no-restricted-syntax
      insertImageAttachment: (attrs: ImageAttachmentAttrs) => ReturnType;
      // eslint-disable-next-line no-restricted-syntax
      removeImageAttachmentById: (id: string) => ReturnType;
    };
  }
}

export const ImageAttachmentNode = TiptapNode.create({
  name: "imageAttachment",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  draggable: false,

  addAttributes() {
    return dataAttributeMap(IMAGE_ATTACHMENT_ATTRIBUTE_NAMES);
  },

  parseHTML() {
    return [{ tag: "span[data-composer-image-attachment]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-composer-image-attachment": "",
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageAttachmentNodeView);
  },

  addCommands() {
    return {
      insertImageAttachment:
        (attrs) =>
        ({ tr, state, dispatch }) => {
          const groupType = state.schema.nodes.attachmentGroup;
          const atomType = state.schema.nodes.imageAttachment;
          const atomNode = atomType.create(attrs);
          const firstChild = tr.doc.firstChild;
          if (firstChild !== null && firstChild.type === groupType) {
            const insertAt = firstChild.nodeSize - 1;
            tr.insert(insertAt, atomNode);
            if (dispatch) dispatch(tr);
            return true;
          }
          const groupNode = groupType.create(null, [atomNode]);
          tr.insert(0, groupNode);
          if (dispatch) dispatch(tr);
          return true;
        },
      removeImageAttachmentById:
        (id) =>
        ({ tr, state, dispatch }) => {
          const groupType = state.schema.nodes.attachmentGroup;
          const atomType = state.schema.nodes.imageAttachment;
          const firstChild = tr.doc.firstChild;
          if (firstChild === null || firstChild.type !== groupType) {
            return false;
          }
          const matches: Array<{ offset: number; size: number }> = [];
          firstChild.forEach((child, offset) => {
            if (child.type !== atomType) return;
            if (child.attrs.id !== id) return;
            matches.push({ offset, size: child.nodeSize });
          });
          if (matches.length === 0) return false;
          const match = matches[0];
          const willBeEmpty = firstChild.childCount === 1;
          if (willBeEmpty) {
            tr.delete(0, firstChild.nodeSize);
          } else {
            const atomFrom = 1 + match.offset;
            const atomTo = atomFrom + match.size;
            tr.delete(atomFrom, atomTo);
          }
          if (dispatch) dispatch(tr);
          return true;
        },
    };
  },
});
