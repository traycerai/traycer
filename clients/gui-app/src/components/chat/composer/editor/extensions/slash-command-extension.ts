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
  ComposerSlashScope,
  ComposerSlashTrigger,
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

/** The `$` sibling of {@link slashSuggestionPluginKey}, over the same catalog. */
export const skillSuggestionPluginKey = new PluginKey(
  "composer-skill-suggestion",
);

/**
 * Character that opened a picker, recorded on the chip it inserts. Shared with
 * the picker store, which echoes it back in the menu rows.
 */
export type SlashCommandTrigger = ComposerSlashTrigger;

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
    if (!isLegalSlashChip(state.doc, node, pos)) positions.push(pos);
    return false;
  });
  return positions;
}

/**
 * Whether a chip already in the document is one the composer could have
 * produced.
 *
 * The guard runs over persisted content too - pasted, restored from a draft, or
 * carried in by an edited message - so it cannot assume the picker built every
 * node it sees. The rule is about position, not the trigger: a skill is legal
 * anywhere, and a native command only at the leading position the provider will
 * actually parse. Both triggers offer the same catalog, so neither narrows what
 * a chip is allowed to be.
 */
function isLegalSlashChip(
  doc: ProseMirrorNode,
  node: ProseMirrorNode,
  pos: number,
): boolean {
  if (node.attrs.kind === "skill") return true;
  return isLeadingSlashPosition(doc, pos);
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
        suggestionForTrigger({
          editor: this.editor,
          pickerStore: deps.pickerStore,
          trigger: "/",
          pluginKey: slashSuggestionPluginKey,
          slashScopeForProps: slashScopeForRange,
        }),
        suggestionForTrigger({
          editor: this.editor,
          pickerStore: deps.pickerStore,
          trigger: "$",
          pluginKey: skillSuggestionPluginKey,
          slashScopeForProps: slashScopeForRange,
        }),
      ];
    },
  });
}

/**
 * Scope follows the caret, not the trigger: both `/` and `$` open the whole
 * catalog at the start of the prompt and skills past it. `$` is a second way
 * into the same list, not a narrower one - rendering a skill in the form a
 * given provider expects (Codex wants `$name`) is the harness layer's job.
 */
function slashScopeForRange(context: {
  editor: { state: EditorState };
  range: { from: number; to: number };
}): ComposerSlashScope {
  return isLeadingRange(
    context.editor.state,
    context.range.from,
    context.range.to,
  )
    ? "all"
    : "skills";
}

function suggestionForTrigger(args: {
  readonly editor: Parameters<typeof Suggestion>[0]["editor"];
  readonly pickerStore: ComposerPickerStore;
  readonly trigger: SlashCommandTrigger;
  readonly pluginKey: PluginKey;
  readonly slashScopeForProps: (context: {
    editor: { state: EditorState };
    range: { from: number; to: number };
  }) => ComposerSlashScope;
}): Plugin {
  return Suggestion({
    editor: args.editor,
    pluginKey: args.pluginKey,
    char: args.trigger,
    allowSpaces: false,
    startOfLine: false,
    decorationTag: "span",
    decorationClass: "",
    items: () => [],
    render: createComposerSuggestionRender({
      pickerStore: args.pickerStore,
      kind: "slash",
      slashTrigger: args.trigger,
      slashScopeForProps: args.slashScopeForProps,
    }),
    command: ({ editor, range, props }) => {
      const item = props as ComposerPickerItem;
      if (item.kind !== "slash") return;
      commitSlashInsertion(editor, range, item.command, args.trigger);
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
 *
 * "Contributes no prompt text" is a question for the serializer, not for how
 * empty the block looks: a blockquote holding nothing but a hard break still
 * emits `>`, so `isQuoteLeadingWrapper` stops it from being skipped here.
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
    if (isQuoteLeadingWrapper(node)) {
      token = { node, pos };
      return false;
    }
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
 * A blockquote is content however empty it looks, so it is never descended
 * into. `quotePrefixLines` emits a bare `>` for a blank line, so a quote always
 * puts a character in front of whatever follows - and the prefix precedes the
 * caret from inside the quote too, which is why one rule here covers both an
 * earlier quote block and a caret sitting within one. Descending would let a
 * hard-break-only quote read as trimmable whitespace and classify the command
 * after it as leading, when the provider actually receives `>\n>\n/plan`.
 */
function isQuoteLeadingWrapper(node: ProseMirrorNode): boolean {
  return node.type.name === "blockquote";
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
  trigger: SlashCommandTrigger,
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
            trigger,
          },
        },
        { type: "text", text: " " },
      ],
    )
    .run();
}
