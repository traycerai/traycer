import { Extension, InputRule } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { ChatComposerSubmitSource } from "@/lib/chats/resolve-steer-submit";
import type { ComposerPickerStore } from "../../picker/composer-picker-store";

export interface ChatListKeymapOptions {
  readonly onSubmit: {
    readonly current: (source: ChatComposerSubmitSource) => void;
  };
  readonly pickerStore: ComposerPickerStore | null;
}

export const ChatListKeymap = Extension.create<ChatListKeymapOptions>({
  name: "chatListKeymap",

  addOptions() {
    return {
      onSubmit: { current: () => {} },
      pickerStore: null,
    };
  },

  addKeyboardShortcuts() {
    const { onSubmit, pickerStore } = this.options;
    return {
      // Undo automatic Markdown formatting before falling through to the
      // ordinary history keymap. For the fence input rule this restores ```.
      "Mod-z": ({ editor }) => editor.commands.undoInputRule(),
      "Mod-Enter": () => {
        // Steer chord (decision 12): with an open @mention/slash picker, commit
        // the highlighted item and then submit-as-steer in one press, rather
        // than sending the half-typed trigger. With no picker it is a plain
        // submit-as-steer. A highlighted row that legally refuses to commit
        // (disabled/loading) absorbs the chord exactly like Enter does, instead
        // of falling through to submit the half-typed trigger.
        if (commitPickerRefused(pickerStore)) return true;
        onSubmit.current("mod-enter");
        return true;
      },
      "Shift-Enter": ({ editor }) => {
        if (handleOpeningCodeFence(editor)) return true;
        if (handleListEnter(editor)) return true;
        if (editor.isActive("codeBlock")) {
          // `splitBlock` would fragment one code block into two; `newlineInCode`
          // inserts a real in-code newline. A bare `return false` would insert
          // nothing here, because `Enter` is globally bound to submit and
          // nothing else binds `Shift-Enter`.
          return editor.chain().newlineInCode().scrollIntoView().run();
        }
        // Must run before the `splitBlock` fallback: an empty trailing quote
        // line means the user already added one blank line via the ordinary
        // path below and is now signalling "done quoting" rather than "add
        // another quote line".
        if (handleQuoteExit(editor)) return true;
        // A soft newline is a paragraph boundary: `splitBlock` makes each visual
        // line its own textblock, so native list/heading input rules fire on
        // every line. `scrollIntoView` keeps the caret visible when the new line
        // pushes past the editor's max-height. Inside a blockquote this simply
        // adds another quote line, since `splitBlock` keeps the same ancestor.
        return editor.chain().splitBlock().scrollIntoView().run();
      },
      Backspace: ({ editor }) => handleQuoteBackspaceUnwrap(editor),
      Enter: ({ editor }) => {
        if (handlePickerEnter(pickerStore)) return true;
        if (handleOpeningCodeFence(editor)) return true;
        onSubmit.current("enter");
        return true;
      },
    };
  },

  addInputRules() {
    const codeBlockType = this.editor.schema.nodes.codeBlock;
    const paragraphType = this.editor.schema.nodes.paragraph;

    return [
      new InputRule({
        find: /^```$/,
        handler: ({ state, range }) => {
          const $start = state.doc.resolve(range.from);
          if (range.to !== $start.end()) return null;

          const parent = $start.node(-1);
          if (
            !parent.canReplaceWith(
              $start.index(-1),
              $start.indexAfter(-1),
              codeBlockType,
            )
          ) {
            return null;
          }

          const tr = state.tr
            .delete(range.from, range.to)
            .setBlockType(range.from, range.from, codeBlockType);
          // Keep StarterKit's trailing-paragraph invariant inside the same
          // undoable input-rule transaction. If TrailingNode appended it in a
          // follow-up transaction, Tiptap would discard the rule state before
          // Mod-z had a chance to restore the literal fence.
          if (tr.doc.lastChild?.type !== paragraphType) {
            tr.insert(tr.doc.content.size, paragraphType.create());
          }
        },
      }),
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleTextInput: (view, from, to, text) =>
            handleClosingCodeFence(view, from, to, text),
        },
      }),
    ];
  },
});

// The composer owns both Enter (submit) and Shift-Enter (paragraph split), so
// Tiptap never sees the newline that completes its native fenced-code input
// rule. Recognize the opening fence before either shortcut: a paragraph
// containing only ``` (optionally with Tiptap's supported lowercase language
// suffix) becomes an empty code block.
function handleOpeningCodeFence(editor: Editor): boolean {
  const { $from, empty } = editor.state.selection;
  if (!empty || $from.parent.type.name !== "paragraph") return false;
  if ($from.parentOffset !== $from.parent.content.size) return false;

  const fenceText = $from.parent.textContent;
  if (!/^```(?:[a-z]+)?$/.test(fenceText)) return false;
  if (!hasOnlyTextChildren($from.parent)) return false;

  const fenceRange = { from: $from.start(), to: $from.end() };
  const language = fenceText.slice(3);
  const codeBlockAttrs = language.length === 0 ? undefined : { language };
  if (!editor.can().setCodeBlock(codeBlockAttrs)) return false;

  return editor
    .chain()
    .setCodeBlock(codeBlockAttrs)
    .deleteRange(fenceRange)
    .scrollIntoView()
    .run();
}

function hasOnlyTextChildren(node: ProseMirrorNode): boolean {
  for (let index = 0; index < node.childCount; index += 1) {
    if (!node.child(index).isText) return false;
  }
  return true;
}

// A closing fence typed on its own line exits the rich code block immediately:
// the full fence (and preceding newline on later lines) is removed, and the
// caret moves into the following paragraph.
function handleClosingCodeFence(
  view: EditorView,
  from: number,
  to: number,
  text: string,
): boolean {
  if (text !== "`" || from !== to) return false;

  const { selection } = view.state;
  if (!selection.empty || selection.from !== from) return false;
  const { $from } = selection;
  if ($from.parent.type.name !== "codeBlock") return false;
  const textBeforeCaret = $from.parent.textContent.slice(0, $from.parentOffset);
  const isAtCodeBlockEnd = $from.parentOffset === $from.parent.content.size;
  const isFirstLineFence =
    isAtCodeBlockEnd && $from.parentOffset === 2 && textBeforeCaret === "``";
  const isLaterLineFence = isAtCodeBlockEnd && textBeforeCaret.endsWith("\n``");
  if (!isFirstLineFence && !isLaterLineFence) return false;

  const closingFenceFrom = from - (isFirstLineFence ? 2 : 3);
  // Record the incoming third backtick before closing the block. Isolating the
  // close in its own history event means undo restores the complete literal
  // fence, even when the first two backticks belong to an older history group.
  view.dispatch(view.state.tr.insertText(text, from, to));
  const closingFenceTo = from + text.length;
  const codeBlockEnd = view.state.selection.$from.after();
  const paragraphType = view.state.schema.nodes.paragraph;
  const tr = closeHistory(view.state.tr);

  tr.delete(closingFenceFrom, closingFenceTo);
  const afterCodeBlock = tr.mapping.map(codeBlockEnd);
  const nextNode = tr.doc.nodeAt(afterCodeBlock);
  if (nextNode?.type !== paragraphType) {
    tr.insert(afterCodeBlock, paragraphType.create());
  }
  tr.setSelection(TextSelection.create(tr.doc, afterCodeBlock + 1));
  tr.scrollIntoView();
  view.dispatch(tr);
  return true;
}

function handlePickerEnter(pickerStore: ComposerPickerStore | null): boolean {
  if (pickerStore === null) return false;
  const state = pickerStore.getState();
  if (!state.open) return false;
  // An open picker owns Enter outright - whether it can commit (a highlighted,
  // enabled row) or not (empty results, still loading, or the active row
  // legally refusing). `commitActiveItem()` commits when it can and no-ops
  // (returns false) otherwise; either way we absorb the keypress so a
  // half-typed trigger is never submitted with the picker still on screen.
  // Returning `commitActiveItem()` directly would fall through to `onSubmit`
  // in exactly those can't-commit states. This binding wins over the
  // suggestion plugin's own key handling, so the absorb must happen here too.
  state.commitActiveItem();
  return true;
}

// Mod-Enter's picker handling differs from Enter's only on a SUCCESSFUL commit:
// it does NOT absorb the keypress, so the same chord proceeds to submit as a
// steer (commit + steer in one press). Whenever the OPEN picker cannot commit -
// empty results, still loading, or the active row legally refusing (all of which
// make `commitActiveItem` return false) - it absorbs the chord exactly like
// Enter, so the half-typed trigger is never sent with the picker still open.
// With no open picker nothing is committed and the submit runs. Returns true
// when the commit was refused and the caller must NOT submit.
function commitPickerRefused(pickerStore: ComposerPickerStore | null): boolean {
  if (pickerStore === null) return false;
  const state = pickerStore.getState();
  if (!state.open) return false;
  return !state.commitActiveItem();
}

// Shift-Enter on an empty final line inside a blockquote lifts the caret out
// below the quote instead of adding yet another empty quote line, mirroring
// the "blank list item exits the list" idiom in `handleListEnter` below.
function handleQuoteExit(editor: Editor): boolean {
  const { $from, empty } = editor.state.selection;
  if (!empty) return false;
  if (!$from.parent.isTextblock || $from.parent.content.size !== 0) {
    return false;
  }

  const depth = $from.depth;
  if (depth < 1) return false;
  const blockquoteDepth = depth - 1;
  const blockquote = $from.node(blockquoteDepth);
  if (blockquote.type.name !== "blockquote") return false;
  // A lone empty line has no earlier quoted content to leave behind, so this
  // contrived state falls through to the ordinary `splitBlock` path instead.
  if (blockquote.childCount <= 1) return false;
  if ($from.index(blockquoteDepth) !== blockquote.childCount - 1) return false;

  // Lifting the (empty) last line out of the blockquote - rather than
  // deleting it and inserting a fresh paragraph - reuses ProseMirror's own
  // range-lift machinery (the same primitive `unsetBlockquote` below builds
  // on) and keeps selection mapping correct for free.
  return editor.commands.lift("blockquote");
}

// Backspace unwraps the blockquote only when the caret sits at the very start
// of its first line. Deliberately narrow: the composer does not also join a
// following paragraph backward into a preceding blockquote (Tiptap's default
// Blockquote keymap does), since that would surprise a user backspacing at
// the start of their typed reply just below a quote.
function handleQuoteBackspaceUnwrap(editor: Editor): boolean {
  const { selection } = editor.state;
  if (!selection.empty) return false;
  const { $from } = selection;
  if ($from.parentOffset !== 0) return false;

  const depth = $from.depth;
  if (depth < 1) return false;
  const blockquoteDepth = depth - 1;
  const blockquote = $from.node(blockquoteDepth);
  if (blockquote.type.name !== "blockquote") return false;
  if ($from.index(blockquoteDepth) !== 0) return false;

  if ($from.parent.type.name !== "paragraph") {
    // A non-prose first line (e.g. a quoted code block, per the future
    // fence-quote path) is not unwrapped here - it stops instead of falling
    // through, because ProseMirror's default Backspace-at-start-of-sole-child
    // behavior would otherwise silently lift it out of the blockquote too,
    // just via a different mechanism than this handler.
    return true;
  }

  return editor.commands.unsetBlockquote();
}

function handleListEnter(editor: Editor): boolean {
  if (editor.isActive("listItem")) {
    if (editor.can().splitListItem("listItem")) {
      return editor.chain().splitListItem("listItem").run();
    }
    // `splitListItem` cannot run on an empty list item, so its failure is the
    // signal that the caret sits on a blank list item - the moment the user
    // wants to leave the list. Lift that item out instead of breaking the line.
    if (editor.can().liftListItem("listItem")) {
      return editor.chain().liftListItem("listItem").run();
    }
  }
  return false;
}
