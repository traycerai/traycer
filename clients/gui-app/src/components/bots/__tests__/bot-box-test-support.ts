/**
 * Driving a bot's message box in jsdom. The box is the agent composer's
 * Tiptap editor; Tiptap leaves the live editor on its DOM node, which is how a
 * test reaches the real one. Text goes in through ProseMirror transactions,
 * which also run the real suggestion plugin that opens the `@` menu, and keys
 * go through the real keymap as DOM key events.
 *
 * Each function takes the box's editable element (`getByRole("textbox")` of
 * the box); the `…In` forms find it by the box's accessible name instead.
 */
import { act, fireEvent, screen, within } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { Selection } from "@tiptap/pm/state";
import { botBoxText, botBoxWire } from "@/lib/bots/bot-box-content";

/** The editable element of the box labelled `label`; waits for the editor to mount. */
export async function findBoxInput(label: string): Promise<HTMLElement> {
  const group = await screen.findByRole("group", { name: label });
  const input = group.querySelector<HTMLElement>("[data-composer-editor]");
  if (input === null) throw new Error(`"${label}" has no editor`);
  return input;
}

/** The editable element of the box labelled `label`, for a box already mounted. */
export function boxInput(label: string): HTMLElement {
  const group = screen.getByRole("group", { name: label });
  const input = group.querySelector<HTMLElement>("[data-composer-editor]");
  if (input === null) throw new Error(`"${label}" has no editor`);
  return input;
}

/** The editable element of the box labelled `label` inside `root`. */
export function boxWithin(root: HTMLElement, label: string): HTMLElement {
  const group = within(root).getByRole("group", { name: label });
  const input = group.querySelector<HTMLElement>("[data-composer-editor]");
  if (input === null) throw new Error(`"${label}" has no editor`);
  return input;
}

/** The editable element inside a box's wrapper (the `-input` test id). */
export function editableIn(wrapper: HTMLElement): HTMLElement {
  const input = wrapper.querySelector<HTMLElement>("[data-composer-editor]");
  if (input === null) throw new Error("the box has no editor");
  return input;
}

export function editorOf(input: HTMLElement): Editor {
  if ("editor" in input && input.editor instanceof Editor) return input.editor;
  throw new Error("the box carries no Tiptap editor");
}

/** What the box shows as text: each chip its `@Name`. */
export function textOf(input: HTMLElement): string {
  return botBoxText(editorOf(input).getJSON());
}

/** What the box would send as text: each chip its token. */
export function wireOf(input: HTMLElement): string {
  return botBoxWire(editorOf(input).getJSON());
}

/** Puts `text` after what the box holds, as typing does. */
function insertText(input: HTMLElement, text: string): void {
  const editor = editorOf(input);
  act(() => {
    const { state, view } = editor;
    view.dispatch(
      state.tr.setSelection(Selection.atEnd(state.doc)).insertText(text),
    );
  });
}

/**
 * A sequence as `userEvent.keyboard` writes one, into the box: plain text is
 * typed, `{Key}` is a key press, and `{Shift>}` holds Shift until `{/Shift}`.
 */
export function typeInto(input: HTMLElement, sequence: string): void {
  let shiftKey = false;
  for (const part of sequence.split(/(\{[A-Za-z/>]+\})/)) {
    if (part.length === 0) continue;
    if (part === "{Shift>}") shiftKey = true;
    else if (part === "{/Shift}") shiftKey = false;
    else {
      const key = /^\{([A-Za-z]+)\}$/.exec(part)?.[1];
      if (key === undefined) insertText(input, part);
      else fireEvent.keyDown(input, { key, shiftKey });
    }
  }
}

/** Empties the box, as selecting everything and deleting does. */
export function clearBoxOf(input: HTMLElement): void {
  const editor = editorOf(input);
  act(() => {
    editor.commands.clearContent(true);
  });
}

export function boxEditor(label: string): Editor {
  return editorOf(boxInput(label));
}

export function boxText(label: string): string {
  return textOf(boxInput(label));
}

export function boxWire(label: string): string {
  return wireOf(boxInput(label));
}

export function typeKeys(label: string, sequence: string): void {
  typeInto(boxInput(label), sequence);
}

export function clearBox(label: string): void {
  clearBoxOf(boxInput(label));
}
