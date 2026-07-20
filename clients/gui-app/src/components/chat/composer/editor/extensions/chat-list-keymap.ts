import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import type { ComposerPickerStore } from "../../picker/composer-picker-store";

export interface ChatListKeymapOptions {
  readonly onSubmit: { readonly current: () => void };
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
      "Mod-Enter": () => {
        onSubmit.current();
        return true;
      },
      "Shift-Enter": ({ editor }) => {
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
      Enter: () => {
        if (handlePickerEnter(pickerStore)) return true;
        onSubmit.current();
        return true;
      },
    };
  },
});

function handlePickerEnter(pickerStore: ComposerPickerStore | null): boolean {
  if (pickerStore === null) return false;
  const state = pickerStore.getState();
  if (!state.open || state.items.length === 0) return false;
  // An open, non-empty picker owns Enter outright - including when the
  // highlighted row legally refuses to commit (a disabled row). Returning
  // `commitActiveItem()` directly would fall through to `onSubmit` and send a
  // half-typed message with the picker still on screen. This binding wins over
  // the suggestion plugin's own key handling, so the refusal has to be
  // absorbed here rather than there.
  state.commitActiveItem();
  return true;
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
