import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { buildComposerExtensions } from "../editor/editor-config";
import { createComposerPickerStore } from "../picker/composer-picker-store";

const editors: Editor[] = [];
const elements: HTMLElement[] = [];

function makeFixture(content: JsonContent): {
  readonly editor: Editor;
  readonly submitCalls: { count: number };
} {
  const element = document.createElement("div");
  document.body.appendChild(element);
  elements.push(element);
  const submitCalls = { count: 0 };
  const editor = new Editor({
    element,
    extensions: buildComposerExtensions({
      pickerStore: createComposerPickerStore(),
      placeholder: "test",
      onSubmit: {
        current: () => {
          submitCalls.count += 1;
        },
      },
      slashProviderId: "claude",
    }),
    content,
  });
  editors.push(editor);
  return { editor, submitCalls };
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
  elements.splice(0).forEach((element) => element.remove());
});

function quoteDoc(text: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "blockquote",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      },
      { type: "paragraph" },
    ],
  };
}

function emptyDoc(): JsonContent {
  return { type: "doc", content: [{ type: "paragraph" }] };
}

function setCaretAtTextStart(editor: Editor, text: string): void {
  let target = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === text) target = pos;
    return true;
  });
  if (target === -1) throw new Error(`text "${text}" not found`);
  editor.commands.setTextSelection(target);
}

function setCaretAtTextEnd(editor: Editor, text: string): void {
  let target = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === text) target = pos + node.nodeSize;
    return true;
  });
  if (target === -1) throw new Error(`text "${text}" not found`);
  editor.commands.setTextSelection(target);
}

function topLevelTypes(editor: Editor): string[] {
  return editor.getJSON().content.map((node) => node.type);
}

function typeText(editor: Editor, value: string): void {
  Array.from(value).forEach((char) => typeChar(editor, char));
}

function typeChar(editor: Editor, char: string): void {
  const { from, to } = editor.state.selection;
  const defaultTransaction = () => editor.state.tr.insertText(char, from, to);
  const handled =
    editor.view.someProp("handleTextInput", (handler) => {
      const result = handler(editor.view, from, to, char, defaultTransaction);
      return result === true ? true : undefined;
    }) === true;
  if (!handled) {
    editor.view.dispatch(defaultTransaction());
  }
}

describe("composer blockquote schema", () => {
  it("accepts a blockquote node and round-trips it through getJSON", () => {
    const { editor } = makeFixture(quoteDoc("quoted text"));
    expect(topLevelTypes(editor)).toEqual(["blockquote", "paragraph"]);
    expect(editor.getJSON()).toEqual(quoteDoc("quoted text"));
  });

  it("does not turn a typed '> ' into a blockquote (button-only authoring)", () => {
    const { editor } = makeFixture(emptyDoc());
    typeText(editor, "> quote");
    expect(topLevelTypes(editor)).toEqual(["paragraph"]);
    expect(editor.state.doc.firstChild?.textContent).toBe("> quote");
  });

  it("does not toggle a blockquote on Cmd-Shift-B", () => {
    const { editor } = makeFixture(emptyDoc());
    typeText(editor, "text");
    // `keyboardShortcut()` always resolves `true` (it only reports that the
    // simulated keydown was dispatched, not that a handler matched) - assert
    // on the resulting doc instead of the return value.
    editor.commands.keyboardShortcut("Mod-Shift-b");
    expect(topLevelTypes(editor)).toEqual(["paragraph"]);
  });
});

describe("composer quote keymap", () => {
  it("splits into a new quote line on ordinary Shift-Enter inside a quote", () => {
    const { editor, submitCalls } = makeFixture(quoteDoc("quoted"));
    setCaretAtTextEnd(editor, "quoted");

    expect(editor.commands.keyboardShortcut("Shift-Enter")).toBe(true);

    expect(topLevelTypes(editor)).toEqual(["blockquote", "paragraph"]);
    const blockquote = editor.state.doc.firstChild;
    expect(blockquote?.type.name).toBe("blockquote");
    expect(blockquote?.childCount).toBe(2);
    expect(blockquote?.child(1).textContent).toBe("");
    expect(submitCalls.count).toBe(0);
  });

  it("exits the quote on Shift-Enter when the last quote line is empty", () => {
    const { editor } = makeFixture(quoteDoc("quoted"));
    setCaretAtTextEnd(editor, "quoted");
    // First press: ordinary split, adds an empty quote line.
    expect(editor.commands.keyboardShortcut("Shift-Enter")).toBe(true);
    // Second press: the trailing line is now empty, so this exits instead.
    expect(editor.commands.keyboardShortcut("Shift-Enter")).toBe(true);

    expect(topLevelTypes(editor)).toEqual([
      "blockquote",
      "paragraph",
      "paragraph",
    ]);
    const blockquote = editor.state.doc.firstChild;
    expect(blockquote?.childCount).toBe(1);
    expect(blockquote?.textContent).toBe("quoted");

    const { $from } = editor.state.selection;
    expect($from.parent.type.name).toBe("paragraph");
    expect($from.node($from.depth - 1).type.name).toBe("doc");
  });

  it("submits with Enter even when the caret is inside a quote", () => {
    const { editor, submitCalls } = makeFixture(quoteDoc("quoted"));
    setCaretAtTextEnd(editor, "quoted");

    expect(editor.commands.keyboardShortcut("Enter")).toBe(true);

    expect(submitCalls.count).toBe(1);
    expect(topLevelTypes(editor)).toEqual(["blockquote", "paragraph"]);
  });

  it("unwraps the quote on Backspace at the start of its first line", () => {
    const { editor } = makeFixture(quoteDoc("quoted"));
    setCaretAtTextStart(editor, "quoted");

    expect(editor.commands.keyboardShortcut("Backspace")).toBe(true);

    expect(topLevelTypes(editor)).toEqual(["paragraph", "paragraph"]);
    expect(editor.state.doc.firstChild?.textContent).toBe("quoted");
  });

  it("does not unwrap the quote when Backspace is pressed mid-text", () => {
    const { editor } = makeFixture(quoteDoc("quoted"));
    let mid = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "quoted") mid = pos + 3;
      return true;
    });
    editor.commands.setTextSelection(mid);

    editor.commands.keyboardShortcut("Backspace");
    expect(topLevelTypes(editor)).toEqual(["blockquote", "paragraph"]);
    expect(editor.state.doc.firstChild?.type.name).toBe("blockquote");
  });

  it("does not unwrap the quote when Backspace is pressed on a later quote line", () => {
    const { editor } = makeFixture(quoteDoc("quoted"));
    setCaretAtTextEnd(editor, "quoted");
    editor.commands.keyboardShortcut("Shift-Enter");
    typeText(editor, "second");
    setCaretAtTextStart(editor, "second");

    editor.commands.keyboardShortcut("Backspace");
    expect(topLevelTypes(editor)).toEqual(["blockquote", "paragraph"]);
    expect(editor.state.doc.firstChild?.type.name).toBe("blockquote");
  });

  it("falls through to ordinary splitBlock when the quote's only line is already empty", () => {
    // A single-empty-paragraph blockquote has no earlier quoted content to
    // leave behind, so the childCount<=1 guard bails and this reaches the
    // ordinary splitBlock fallback instead of lifting/exiting.
    const { editor } = makeFixture({
      type: "doc",
      content: [
        { type: "blockquote", content: [{ type: "paragraph" }] },
        { type: "paragraph" },
      ],
    });

    expect(editor.commands.keyboardShortcut("Shift-Enter")).toBe(true);

    expect(topLevelTypes(editor)).toEqual(["blockquote", "paragraph"]);
    const blockquote = editor.state.doc.firstChild;
    expect(blockquote?.type.name).toBe("blockquote");
    expect(blockquote?.childCount).toBe(2);
    expect(blockquote?.child(0).type.name).toBe("paragraph");
    expect(blockquote?.child(1).type.name).toBe("paragraph");
  });
});

describe("composer quote keymap with nested block structures", () => {
  function quoteWithListDoc(): JsonContent {
    return {
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "item" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        { type: "paragraph" },
      ],
    };
  }

  function quoteWithCodeBlockDoc(): JsonContent {
    return {
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            { type: "codeBlock", content: [{ type: "text", text: "code" }] },
          ],
        },
        { type: "paragraph" },
      ],
    };
  }

  it("Shift-Enter on a quoted list item splits the list item, not the quote", () => {
    const { editor } = makeFixture(quoteWithListDoc());
    setCaretAtTextEnd(editor, "item");

    expect(editor.commands.keyboardShortcut("Shift-Enter")).toBe(true);

    // handleListEnter wins before handleQuoteExit is ever reached: still one
    // blockquote wrapping one bulletList, now with two list items.
    expect(topLevelTypes(editor)).toEqual(["blockquote", "paragraph"]);
    const blockquote = editor.state.doc.firstChild;
    expect(blockquote?.type.name).toBe("blockquote");
    expect(blockquote?.childCount).toBe(1);
    const bulletList = blockquote?.firstChild;
    expect(bulletList?.type.name).toBe("bulletList");
    expect(bulletList?.childCount).toBe(2);
  });

  it("Backspace at the start of a quoted list item's text unwraps the list, not the quote", () => {
    const { editor } = makeFixture(quoteWithListDoc());
    setCaretAtTextStart(editor, "item");

    // handleQuoteBackspaceUnwrap bails immediately: the node one level above
    // the caret's paragraph is `listItem`, not `blockquote` - list-keymap's
    // own Backspace handling owns this instead.
    editor.commands.keyboardShortcut("Backspace");

    expect(topLevelTypes(editor)).toEqual(["blockquote", "paragraph"]);
    const blockquote = editor.state.doc.firstChild;
    expect(blockquote?.type.name).toBe("blockquote");
    expect(blockquote?.textContent).toBe("item");
  });

  it("Shift-Enter inside a quoted code block inserts a newline, not a quote exit", () => {
    const { editor } = makeFixture(quoteWithCodeBlockDoc());
    setCaretAtTextEnd(editor, "code");

    expect(editor.commands.keyboardShortcut("Shift-Enter")).toBe(true);

    // editor.isActive("codeBlock") short-circuits before handleQuoteExit:
    // still one blockquote wrapping the same single code block.
    expect(topLevelTypes(editor)).toEqual(["blockquote", "paragraph"]);
    const blockquote = editor.state.doc.firstChild;
    expect(blockquote?.childCount).toBe(1);
    expect(blockquote?.firstChild?.type.name).toBe("codeBlock");
    expect(blockquote?.firstChild?.textContent).toBe("code\n");
  });

  it("Backspace at the start of a quoted code block leaves the quote intact", () => {
    const { editor } = makeFixture(quoteWithCodeBlockDoc());
    setCaretAtTextStart(editor, "code");

    // The first line here is a codeBlock, not a paragraph, so
    // handleQuoteBackspaceUnwrap deliberately consumes the keystroke instead
    // of falling through - otherwise ProseMirror's default
    // Backspace-at-start-of-sole-child behavior would silently lift the code
    // block out of the quote via a different mechanism.
    editor.commands.keyboardShortcut("Backspace");

    expect(topLevelTypes(editor)).toEqual(["blockquote", "paragraph"]);
    const blockquote = editor.state.doc.firstChild;
    expect(blockquote?.type.name).toBe("blockquote");
    expect(blockquote?.childCount).toBe(1);
    expect(blockquote?.firstChild?.type.name).toBe("codeBlock");
    expect(blockquote?.firstChild?.textContent).toBe("code");
  });
});
