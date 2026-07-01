import { Extension, mergeAttributes, Node as TiptapNode } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { ReactNodeViewRenderer } from "@tiptap/react";
import Suggestion from "@tiptap/suggestion";

import { slashCommandPlainTextFromAttrs } from "@/lib/composer/tiptap-json-content";

import { SlashCommandNodeView } from "../nodes/slash-command-node-view";
import { createComposerSuggestionRender } from "../../picker/suggestion-render";
import type {
  ComposerPickerItem,
  ComposerPickerStore,
} from "../../picker/composer-picker-store";
import {
  dataAttributeMap,
  SLASH_COMMAND_ATTRIBUTE_NAMES,
} from "./attribute-helpers";

export const ChatSlashCommandNode = TiptapNode.create({
  name: "slashCommand",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  draggable: false,

  addAttributes() {
    return dataAttributeMap(SLASH_COMMAND_ATTRIBUTE_NAMES);
  },

  parseHTML() {
    return [{ tag: "span[data-composer-slash-command]" }];
  },

  renderText({ node }) {
    return slashCommandPlainTextFromAttrs(node.attrs);
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-composer-slash-command": "",
      }),
      slashCommandPlainTextFromAttrs(node.attrs),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(SlashCommandNodeView);
  },

  addProseMirrorPlugins() {
    return [slashLeadingGuardPlugin()];
  },
});

const slashLeadingGuardKey = new PluginKey("composer-slash-leading-guard");

/**
 * Stable key for the `/` command suggestion plugin. Exported (and pinned via the
 * Suggestion config below) so code outside the editor can imperatively exit an
 * open suggestion by dispatching `setMeta(slashSuggestionPluginKey, { exit: true })`
 * - see the editor's `dismissActiveSuggestion` handle.
 */
export const slashSuggestionPluginKey = new PluginKey(
  "composer-slash-suggestion",
);

function slashLeadingGuardPlugin(): Plugin {
  return new Plugin({
    key: slashLeadingGuardKey,
    appendTransaction(_transactions, _oldState, newState) {
      const stripPositions = collectIllegalSlashPositions(newState);
      if (stripPositions.length === 0) return null;
      const tr = newState.tr;
      stripPositions
        .toSorted((left, right) => right - left)
        .forEach((pos) => {
          const node = tr.doc.nodeAt(pos);
          if (node?.type.name !== "slashCommand") return;
          tr.delete(pos, pos + node.nodeSize);
        });
      return tr.docChanged ? tr : null;
    },
  });
}

function collectIllegalSlashPositions(state: EditorState): number[] {
  const positions: number[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name !== "slashCommand") return true;
    if (!isLeadingSlashPosition(state.doc, pos)) {
      positions.push(pos);
    }
    return false;
  });
  return positions;
}

function isLeadingSlashPosition(doc: ProseMirrorNode, pos: number): boolean {
  return leadingTokenBefore(doc, pos) === null;
}

interface LeadingToken {
  readonly node: ProseMirrorNode;
  readonly pos: number;
}

export interface SlashSuggestionExtensionDeps {
  readonly pickerStore: ComposerPickerStore;
}

export function createSlashSuggestionExtension(
  deps: SlashSuggestionExtensionDeps,
) {
  return Extension.create({
    name: "slashCommandSuggestion",

    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          pluginKey: slashSuggestionPluginKey,
          char: "/",
          allowSpaces: false,
          startOfLine: true,
          decorationTag: "span",
          decorationClass: "",
          allow: ({ state, range }) =>
            isLeadingRange(state, range.from, range.to),
          items: () => [],
          render: createComposerSuggestionRender({
            pickerStore: deps.pickerStore,
            kind: "slash",
          }),
          command: ({ editor, range, props }) => {
            const item = props as ComposerPickerItem;
            if (item.kind !== "slash") return;
            commitSlashInsertion(editor, range, item.command.name);
          },
        }),
      ];
    },
  });
}

export function isLeadingRange(
  state: EditorState,
  from: number,
  _to: number,
): boolean {
  return leadingTokenBefore(state.doc, from) === null;
}

export function leadingTokenBefore(
  doc: ProseMirrorNode,
  pos: number,
): ProseMirrorNode | null {
  return leadingTokenBeforePosition(doc, pos)?.node ?? null;
}

export function leadingTokenInDocument(
  doc: ProseMirrorNode,
): LeadingToken | null {
  let childPos = 0;
  for (let index = 0; index < doc.childCount; index += 1) {
    const child = doc.child(index);
    if (isIgnoredLeadingLeaf(child)) {
      childPos += child.nodeSize;
      continue;
    }

    const token = leadingTokenInRange(doc, childPos, childPos + child.nodeSize);
    return token ?? { node: child, pos: childPos };
  }
  return null;
}

function leadingTokenBeforePosition(
  doc: ProseMirrorNode,
  pos: number,
): LeadingToken | null {
  const clampedPos = Math.min(Math.max(0, pos), doc.content.size);
  const $pos = doc.resolve(clampedPos);
  const topLevelIndex = $pos.index(0);
  for (let index = 0; index < topLevelIndex; index += 1) {
    const child = doc.child(index);
    if (!isIgnoredLeadingLeaf(child)) {
      return { node: child, pos: childOffsetBefore(doc, index) };
    }
  }
  if ($pos.depth === 0) return null;
  return leadingTokenInRange(doc, $pos.before(1), clampedPos);
}

function leadingTokenInRange(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): LeadingToken | null {
  let token: LeadingToken | null = null;
  doc.nodesBetween(from, to, (node, pos) => {
    if (token !== null) return false;
    if (isIgnoredLeadingLeaf(node)) return false;
    if (isTransparentLeadingContainer(node)) return true;
    if (node.isText && node.textContent.length === 0) return false;
    if (node.isText || node.isAtom || node.isLeaf) {
      token = { node, pos };
      return false;
    }
    return true;
  });
  return token;
}

function childOffsetBefore(doc: ProseMirrorNode, index: number): number {
  let offset = 0;
  for (let childIndex = 0; childIndex < index; childIndex += 1) {
    offset += doc.child(childIndex).nodeSize;
  }
  return offset;
}

function isIgnoredLeadingLeaf(node: ProseMirrorNode): boolean {
  return (
    node.type.name === "attachmentGroup" || node.type.name === "imageAttachment"
  );
}

function isTransparentLeadingContainer(node: ProseMirrorNode): boolean {
  return !node.isText && !node.isLeaf && !node.isAtom;
}

function commitSlashInsertion(
  editor: Parameters<
    NonNullable<Parameters<typeof Suggestion>[0]["command"]>
  >[0]["editor"],
  range: { from: number; to: number },
  name: string,
): void {
  const trailingSpaceFollows =
    editor.state.doc.textBetween(
      range.to,
      Math.min(range.to + 1, editor.state.doc.content.size),
    ) === " ";
  editor
    .chain()
    .focus()
    .insertContentAt(
      {
        from: range.from,
        to: trailingSpaceFollows ? range.to + 1 : range.to,
      },
      [
        { type: "slashCommand", attrs: { commandName: name } },
        { type: "text", text: " " },
      ],
    )
    .run();
}
