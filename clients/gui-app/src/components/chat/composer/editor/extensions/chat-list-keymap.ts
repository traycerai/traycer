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
        // A soft newline is a paragraph boundary: `splitBlock` makes each visual
        // line its own textblock, so native list/heading input rules fire on
        // every line. `scrollIntoView` keeps the caret visible when the new line
        // pushes past the editor's max-height.
        return editor.chain().splitBlock().scrollIntoView().run();
      },
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
  return state.commitActiveItem();
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
