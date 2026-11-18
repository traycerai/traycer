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
  /**
   * Whether these bytes may travel to the host BY HASH rather than inline.
   * METADATA beside the payload XOR below — not a third payload arm.
   *
   * Stamped by the preparer (`composer-image-preparation.ts`), which is the only
   * place that knows: `true` for a raster output it produced, `false` for its
   * source-bytes fallback (SVG, AVIF, HEIC, BMP, bytes that disagree with their
   * declared type). The host's staging seam refuses the complement of the same
   * raster list; its `missing-attachment-bytes` refusal is the backstop for a
   * disagreement, not the rule.
   *
   * Read it with `imageAttachmentByHashEligible` (`lib/composer/image-atoms.ts`)
   * rather than off the attrs directly — a node that has round-tripped through
   * the HTML clipboard carries `"true"`/`"false"` strings, exactly as `size` and
   * the mention chip's `issueNumber` do.
   */
  readonly byHashEligible: boolean;
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

/**
 * What a pending b64 node becomes once its background job settles. It carries
 * the metadata as well as the hash because preparation may have re-encoded the
 * bytes on the way to the store: the node's `mimeType`, `fileName` and `size`
 * must describe the bytes that hash addresses, not the ones that were pasted -
 * the composer image budget reads `size` back off the node, and `size`/
 * `mimeType` are what the send carries.
 *
 * `byHashEligible` rides along for the same reason and is the sharpest case of
 * it: the pending node was stamped from the SOURCE bytes, and preparation is
 * what decides whether the stored bytes are a format the host can take by hash.
 */
export interface ImageAttachmentRewrite {
  readonly hash: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number | null;
  readonly byHashEligible: boolean;
}

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
      insertImageAttachment: (attrs: ImageAttachmentAttrs) => ReturnType;
      removeImageAttachmentById: (id: string) => ReturnType;
      rewriteImageAttachmentHashById: (
        id: string,
        rewrite: ImageAttachmentRewrite,
      ) => ReturnType;
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
      rewriteImageAttachmentHashById:
        (id, rewrite) =>
        ({ tr, state, dispatch }) => {
          const matches: Array<{
            readonly pos: number;
            readonly attrs: Record<string, unknown>;
          }> = [];
          state.doc.descendants((node, pos) => {
            if (node.type.name !== "imageAttachment") return true;
            if (node.attrs.id !== id) return false;
            matches.push({ pos, attrs: node.attrs });
            return false;
          });
          if (matches.length === 0) return false;
          const match = matches[0];
          // Flip a pending b64 image node to its stored content hash IN PLACE:
          // `setNodeMarkup` rewrites the attrs while preserving the node's exact
          // position (no re-insert, no mapping, caret untouched). This is what
          // lets the paste insert full content in document order and convert each
          // image's payload once its background prepare+hash+store job resolves.
          tr.setNodeMarkup(match.pos, undefined, {
            ...match.attrs,
            hash: rewrite.hash,
            fileName: rewrite.fileName,
            mimeType: rewrite.mimeType,
            size: rewrite.size,
            byHashEligible: rewrite.byHashEligible,
            b64content: null,
          });
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
