import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import { Plugin, TextSelection, type EditorState } from "@tiptap/pm/state";
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

  addProseMirrorPlugins() {
    return [visualLineListInputPlugin()];
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
        // `setHardBreak` dispatches without scrollIntoView, so a newline past
        // the editor's max-height wouldn't follow the caret until the next
        // keystroke. Chain scrollIntoView so the cursor stays visible.
        return editor.chain().setHardBreak().scrollIntoView().run();
      },
      Enter: () => {
        if (handlePickerEnter(pickerStore)) return true;
        onSubmit.current();
        return true;
      },
    };
  },
});

interface VisualLineListMatch {
  readonly kind: "bullet" | "ordered";
  readonly hardBreakPos: number;
  readonly insertAfter: number;
  readonly start: number | null;
}

function visualLineListInputPlugin(): Plugin {
  return new Plugin({
    props: {
      handleTextInput(view, from, to, text) {
        if (text !== " " || from !== to) return false;
        const match = visualLineListMatch(view.state, from);
        if (match === null) return false;
        const listNode = createEmptyListNode(
          view.state.schema,
          match.kind,
          match.start,
        );
        if (listNode === null) return false;

        const tr = view.state.tr.delete(match.hardBreakPos, from);
        const insertPos = tr.mapping.map(match.insertAfter);
        tr.insert(insertPos, listNode);
        tr.setSelection(TextSelection.create(tr.doc, insertPos + 3));
        view.dispatch(tr.scrollIntoView());
        return true;
      },
    },
  });
}

function visualLineListMatch(
  state: EditorState,
  from: number,
): VisualLineListMatch | null {
  const $from = state.doc.resolve(from);
  const parent = $from.parent;
  if (parent.type.name !== "paragraph") return null;

  const marker = markerAfterLastHardBreak(parent, $from.parentOffset);
  if (marker === null) return null;

  const ordered = /^(\d+)\.$/.exec(marker.text);
  if (ordered !== null) {
    return {
      kind: "ordered",
      hardBreakPos: $from.start() + marker.hardBreakOffset,
      insertAfter: $from.after(),
      start: Number.parseInt(ordered[1], 10),
    };
  }

  if (marker.text === "-" || marker.text === "+" || marker.text === "*") {
    return {
      kind: "bullet",
      hardBreakPos: $from.start() + marker.hardBreakOffset,
      insertAfter: $from.after(),
      start: null,
    };
  }

  return null;
}

function markerAfterLastHardBreak(
  parent: ProseMirrorNode,
  parentOffset: number,
): { readonly hardBreakOffset: number; readonly text: string } | null {
  let hardBreakOffset: number | null = null;
  let lineText = "";

  let offset = 0;
  for (let index = 0; index < parent.childCount; index += 1) {
    const child = parent.child(index);
    if (offset >= parentOffset) break;
    const childEnd = offset + child.nodeSize;
    if (child.type.name === "hardBreak" && childEnd <= parentOffset) {
      hardBreakOffset = offset;
      lineText = "";
      offset = childEnd;
      continue;
    }
    if (child.isText) {
      const text = child.text ?? "";
      const end = Math.min(text.length, parentOffset - offset);
      if (end > 0) lineText += text.slice(0, end);
    }
    offset = childEnd;
  }

  return hardBreakOffset === null ? null : { hardBreakOffset, text: lineText };
}

function createEmptyListNode(
  schema: Schema,
  kind: "bullet" | "ordered",
  start: number | null,
): ProseMirrorNode | null {
  const paragraph = schema.nodes.paragraph.createAndFill();
  if (paragraph === null) return null;
  const listItem = schema.nodes.listItem.createAndFill(null, paragraph);
  if (listItem === null) return null;
  const listType =
    kind === "bullet" ? schema.nodes.bulletList : schema.nodes.orderedList;
  const attrs = kind === "ordered" ? { start: start ?? 1 } : null;
  return listType.createAndFill(attrs, listItem);
}

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
