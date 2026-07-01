import { mergeAttributes, Node as TiptapNode } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ReactNodeViewRenderer } from "@tiptap/react";

import {
  imageAttachmentDisplayLabelFromDecorations,
  imageAttachmentLabelDecorationSpec,
} from "../nodes/image-attachment-label-decorations";
import { ImageAttachmentNodeView } from "../nodes/image-attachment-node-view";
import {
  dataAttributeMap,
  IMAGE_ATTACHMENT_ATTRIBUTE_NAMES,
} from "./attribute-helpers";
import { buildImageAttachmentDisplayLabels } from "@/lib/composer/image-attachment-labels";
import { stringValue } from "@/lib/composer/tiptap-json-content";

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

interface ImageAttachmentLabelPluginState {
  readonly decorations: DecorationSet;
}

interface ImageAttachmentLabelNode {
  readonly id: string;
  readonly fileName: string;
  readonly pos: number;
  readonly size: number;
}

export const imageAttachmentLabelPluginKey =
  new PluginKey<ImageAttachmentLabelPluginState>(
    "composer-image-attachment-labels",
  );

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
    return ReactNodeViewRenderer(ImageAttachmentNodeView, {
      update: ({
        oldNode,
        oldDecorations,
        newNode,
        newDecorations,
        updateProps,
      }) => {
        if (newNode.type !== oldNode.type) return false;
        const oldLabel =
          imageAttachmentDisplayLabelFromDecorations(oldDecorations);
        const newLabel =
          imageAttachmentDisplayLabelFromDecorations(newDecorations);
        if (newNode !== oldNode || oldLabel?.title !== newLabel?.title) {
          updateProps();
        }
        return true;
      },
    });
  },

  addProseMirrorPlugins() {
    return [imageAttachmentLabelPlugin()];
  },

  addCommands() {
    return {
      insertImageAttachment:
        (attrs) =>
        ({ commands, state }) => {
          const content = { type: "imageAttachment", attrs };
          if (state.selection.empty) return commands.insertContent(content);
          return commands.insertContentAt(state.selection.to, content);
        },
      removeImageAttachmentById:
        (id) =>
        ({ tr, state, dispatch }) => {
          const groupType = state.schema.nodes.attachmentGroup;
          const matches: Array<{
            readonly pos: number;
            readonly size: number;
          }> = [];
          state.doc.descendants((node, pos) => {
            if (node.type.name !== "imageAttachment") return true;
            if (node.attrs.id !== id) return false;
            matches.push({ pos, size: node.nodeSize });
            return false;
          });
          if (matches.length === 0) return false;
          const match = matches[0];

          const $from = state.doc.resolve(match.pos);
          const parent = $from.parent;
          if (parent.type === groupType && parent.childCount === 1) {
            const parentStart = match.pos - $from.parentOffset - 1;
            tr.delete(parentStart, parentStart + parent.nodeSize);
          } else {
            tr.delete(match.pos, match.pos + match.size);
          }
          if (dispatch) dispatch(tr);
          return true;
        },
    };
  },
});

function imageAttachmentLabelPlugin(): Plugin<ImageAttachmentLabelPluginState> {
  return new Plugin<ImageAttachmentLabelPluginState>({
    key: imageAttachmentLabelPluginKey,
    state: {
      init: (_config, state: EditorState): ImageAttachmentLabelPluginState =>
        buildImageAttachmentLabelPluginState(state.doc),
      apply: (
        tr,
        prev,
        _oldState,
        newState,
      ): ImageAttachmentLabelPluginState =>
        tr.docChanged
          ? buildImageAttachmentLabelPluginState(newState.doc)
          : prev,
    },
    props: {
      decorations(state) {
        return imageAttachmentLabelPluginKey.getState(state)?.decorations;
      },
    },
  });
}

function buildImageAttachmentLabelPluginState(
  doc: ProseMirrorNode,
): ImageAttachmentLabelPluginState {
  const imageNodes = imageAttachmentLabelNodesFromDoc(doc);
  const labels = buildImageAttachmentDisplayLabels(imageNodes);
  const decorations = imageNodes
    .map((imageNode) => {
      const label = labels.get(imageNode.id);
      if (label === undefined) return null;
      return Decoration.node(
        imageNode.pos,
        imageNode.pos + imageNode.size,
        {},
        imageAttachmentLabelDecorationSpec(label),
      );
    })
    .filter(isDecoration);
  return {
    decorations: DecorationSet.create(doc, decorations),
  };
}

function imageAttachmentLabelNodesFromDoc(
  doc: ProseMirrorNode,
): ImageAttachmentLabelNode[] {
  const imageNodes: ImageAttachmentLabelNode[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "imageAttachment") return true;
    const id = stringValue(node.attrs.id);
    if (id !== null) {
      imageNodes.push({
        id,
        fileName: imageAttachmentFileName(node.attrs),
        pos,
        size: node.nodeSize,
      });
    }
    return false;
  });
  return imageNodes;
}

function imageAttachmentFileName(attrs: Record<string, unknown>): string {
  return stringValue(attrs.fileName) ?? "Image";
}

function isDecoration(value: Decoration | null): value is Decoration {
  return value !== null;
}
