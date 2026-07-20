import { Extension, mergeAttributes, Node as TiptapNode } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { ReactNodeViewRenderer } from "@tiptap/react";
import Suggestion from "@tiptap/suggestion";

import { slashCommandPlainTextFromAttrs } from "@/lib/composer/tiptap-json-content";
import type { SlashCommand } from "@/lib/composer/types";

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
    if (node.attrs.kind === "skill") return false;
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
          startOfLine: false,
          decorationTag: "span",
          decorationClass: "",
          items: () => [],
          render: createComposerSuggestionRender({
            pickerStore: deps.pickerStore,
            kind: "slash",
            slashScopeForProps: ({ editor, range }) =>
              isLeadingRange(editor.state, range.from, range.to)
                ? "all"
                : "skills",
          }),
          command: ({ editor, range, props }) => {
            const item = props as ComposerPickerItem;
            if (item.kind !== "slash") return;
            commitSlashInsertion(editor, range, item.command);
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
  return firstTokenInBlocks(doc, doc.childCount);
}

function leadingTokenBeforePosition(
  doc: ProseMirrorNode,
  pos: number,
): LeadingToken | null {
  const clampedPos = Math.min(Math.max(0, pos), doc.content.size);
  const $pos = doc.resolve(clampedPos);
  const earlier = firstTokenInBlocks(doc, $pos.index(0));
  if (earlier !== null) return earlier;
  if ($pos.depth === 0) return null;
  return leadingTokenInRange(doc, $pos.before(1), clampedPos);
}

/**
 * First real token across the document's first `blockCount` top-level blocks.
 *
 * A block that contributes no prompt text is skipped, whether it holds
 * whitespace or only attachments: `plainTextFromNodes` serializes both to the
 * empty string and drops the block outright, so the command really does reach
 * the provider at the start of the prompt. Classifying by what the parser sees
 * rather than by document shape is also what keeps an attachment consistent
 * with itself - the same image one line up used to disable native commands
 * while an image beside the caret did not.
 */
function firstTokenInBlocks(
  doc: ProseMirrorNode,
  blockCount: number,
): LeadingToken | null {
  let blockPos = 0;
  for (let index = 0; index < blockCount; index += 1) {
    const block = doc.child(index);
    const blockEnd = blockPos + block.nodeSize;
    const token = leadingTokenInRange(doc, blockPos, blockEnd);
    if (token !== null) return token;
    blockPos = blockEnd;
  }
  return null;
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
    if (isWhitespaceLeadingLeaf(node)) return false;
    if (isTransparentLeadingContainer(node)) return true;
    if (node.isText) {
      if (textWithinRange(node, pos, from, to).trim().length === 0)
        return false;
      token = { node, pos };
      return false;
    }
    if (node.isAtom || node.isLeaf) {
      token = { node, pos };
      return false;
    }
    return true;
  });
  return token;
}

/**
 * The slice of a text node that actually lies inside `[from, to)`.
 *
 * Only that slice may decide whether the run is blank: when the user types
 * `   /`, the trigger character shares one text node with the spaces before
 * it, so testing the node's whole text would report non-blank and classify a
 * genuinely leading command as inline.
 */
function textWithinRange(
  node: ProseMirrorNode,
  pos: number,
  from: number,
  to: number,
): string {
  const text = node.text ?? "";
  const start = Math.max(0, from - pos);
  const end = Math.min(text.length, to - pos);
  return end > start ? text.slice(start, end) : "";
}

/**
 * Attachments are not serialized into the prompt text, so they never form the
 * token a command would be measured against inside a block.
 */
function isIgnoredLeadingLeaf(node: ProseMirrorNode): boolean {
  return (
    node.type.name === "attachmentGroup" || node.type.name === "imageAttachment"
  );
}

/**
 * A hard break serializes to a bare newline, which `trim()` strips - so like
 * whitespace text it is not content a command can follow.
 */
function isWhitespaceLeadingLeaf(node: ProseMirrorNode): boolean {
  return node.type.name === "hardBreak";
}

function isTransparentLeadingContainer(node: ProseMirrorNode): boolean {
  return !node.isText && !node.isLeaf && !node.isAtom;
}

function commitSlashInsertion(
  editor: Parameters<
    NonNullable<Parameters<typeof Suggestion>[0]["command"]>
  >[0]["editor"],
  range: { from: number; to: number },
  command: SlashCommand,
): void {
  if (
    command.kind === "slash-command" &&
    !isLeadingRange(editor.state, range.from, range.to)
  ) {
    return;
  }
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
        {
          type: "slashCommand",
          attrs: {
            commandName: command.name,
            harnessId: command.harnessId,
            kind: command.kind,
            description: command.description,
            argumentHint: command.argumentHint,
            path:
              typeof command.metadata.path === "string"
                ? command.metadata.path
                : null,
          },
        },
        { type: "text", text: " " },
      ],
    )
    .run();
}
