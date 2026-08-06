import { fireEvent, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { jsonContentToMarkdown } from "@traycer/protocol/common/json-content-serializer";

import { buildSubmittedChatJSONContent } from "@/lib/composer/tiptap-json-content";
import { buildComposerExtensions } from "../editor/editor-config";
import { createComposerPickerStore } from "../picker/composer-picker-store";

const editors: Editor[] = [];
const elements: HTMLElement[] = [];

function makeFixture(): {
  readonly editor: Editor;
  readonly element: HTMLElement;
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
      getPlaceholder: () => "test",
      onSubmit: {
        current: () => {
          submitCalls.count += 1;
        },
      },
      slashProviderId: "claude",
      getHasPastedImageBytes: () => null,
      getIngestPastedComposerImages: () => null,
    }),
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
  editors.push(editor);
  return { editor, element, submitCalls };
}

afterEach(() => {
  vi.useRealTimers();
  editors.splice(0).forEach((editor) => editor.destroy());
  elements.splice(0).forEach((element) => element.remove());
});

describe("composer Markdown-style input", () => {
  it("turns the third backtick into a code block immediately", () => {
    const { editor, submitCalls } = makeFixture();

    typeText(editor, "``");
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(editor.state.doc.firstChild?.textContent).toBe("``");

    typeText(editor, "`");

    expect(submitCalls.count).toBe(0);
    expect(editor.getJSON().content.map((node) => node.type)).toEqual([
      "codeBlock",
      "paragraph",
    ]);
    expect(editor.state.doc.firstChild?.type.name).toBe("codeBlock");
    expect(editor.state.doc.firstChild?.attrs.language).toBeNull();
    expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");

    typeText(editor, "const answer = 42;");
    expect(editor.commands.keyboardShortcut("Shift-Enter")).toBe(true);
    typeText(editor, "return answer;");
    expect(editor.state.doc.firstChild?.textContent).toBe(
      "const answer = 42;\nreturn answer;",
    );
  });

  it("does not show the composer placeholder inside an empty code block", () => {
    const { editor, element } = makeFixture();
    const editorView = within(element);

    expect(
      editorView.getByRole("paragraph").getAttribute("data-placeholder"),
    ).toBe("test");
    typeText(editor, "```");

    const codeBlock = editorView.getByRole("code").parentElement;
    expect(codeBlock).not.toBeNull();
    expect(codeBlock?.getAttribute("data-placeholder")).toBe("");
  });

  it("restores the literal triple backticks with Ctrl-z", () => {
    const { editor } = makeFixture();

    typeText(editor, "```");
    expect(editor.state.doc.firstChild?.type.name).toBe("codeBlock");

    fireEvent.keyDown(editor.view.dom, { key: "z", ctrlKey: true });

    expect(editor.getJSON().content.map((node) => node.type)).toEqual([
      "paragraph",
    ]);
    expect(editor.state.doc.firstChild?.textContent).toBe("```");
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
  });

  it("falls through to ordinary history undo when no input rule is active", () => {
    const { editor } = makeFixture();

    typeText(editor, "ordinary text");
    fireEvent.keyDown(editor.view.dom, { key: "z", ctrlKey: true });

    expect(editor.state.doc.textContent).toBe("");
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
  });

  it("formats a complete fenced block entered with Shift-Enter", () => {
    const { editor, submitCalls } = makeFixture();

    typeText(editor, "```");
    typeText(editor, "Hello");
    fireEvent.keyDown(editor.view.dom, { key: "Enter", shiftKey: true });
    typeText(editor, "```");

    expect(submitCalls.count).toBe(0);
    expect(editor.getJSON().content.map((node) => node.type)).toEqual([
      "codeBlock",
      "paragraph",
    ]);
    expect(editor.state.doc.firstChild?.type.name).toBe("codeBlock");
    expect(editor.state.doc.firstChild?.textContent).toBe("Hello");
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
  });

  it("closes an empty code block with a fence on its first line", () => {
    const { editor, submitCalls } = makeFixture();

    typeText(editor, "```");
    expect(editor.state.doc.firstChild?.type.name).toBe("codeBlock");

    typeText(editor, "```");

    expect(submitCalls.count).toBe(0);
    expect(editor.getJSON().content.map((node) => node.type)).toEqual([
      "codeBlock",
      "paragraph",
    ]);
    expect(editor.state.doc.firstChild?.textContent).toBe("");
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
  });

  it("keeps a closing fence literal when text follows it on the same line", () => {
    const { editor } = makeFixture();

    typeText(editor, "```");
    typeText(editor, "before");
    fireEvent.keyDown(editor.view.dom, { key: "Enter", shiftKey: true });
    typeText(editor, "suffix");
    const codeBlockStart = editor.state.selection.$from.start();
    editor.commands.setTextSelection(codeBlockStart + "before\n".length);

    typeText(editor, "```");

    expect(editor.state.doc.firstChild?.textContent).toBe("before\n```suffix");
    expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
  });

  it("restores the complete closing fence when undoing an automatic close", () => {
    vi.useFakeTimers();
    const { editor } = makeFixture();

    typeText(editor, "```");
    typeText(editor, "before");
    fireEvent.keyDown(editor.view.dom, { key: "Enter", shiftKey: true });
    typeText(editor, "``");
    vi.advanceTimersByTime(1_000);
    typeText(editor, "`");
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");

    fireEvent.keyDown(editor.view.dom, { key: "z", ctrlKey: true });

    expect(editor.state.doc.firstChild?.textContent).toBe("before\n```");
    expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
  });

  it("keeps an opening fence literal before existing paragraph content", () => {
    const { editor } = makeFixture();

    typeText(editor, "suffix");
    editor.commands.setTextSelection(editor.state.selection.$from.start());
    typeText(editor, "```");

    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(editor.state.doc.firstChild?.textContent).toBe("```suffix");
  });

  it("preserves an inline atom in an Enter fence-looking paragraph", () => {
    const { editor, submitCalls } = makeFixture();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "slashCommand", attrs: { commandName: "plan" } },
            { type: "text", text: "```" },
          ],
        },
      ],
    });
    setSelectionAfterText(editor, "```");

    expect(editor.commands.keyboardShortcut("Enter")).toBe(true);

    expect(submitCalls.count).toBe(1);
    expect(editor.getJSON()).toMatchObject({
      content: [
        {
          type: "paragraph",
          content: [
            { type: "slashCommand", attrs: { commandName: "plan" } },
            { type: "text", text: "```" },
          ],
        },
      ],
    });
  });

  it("does not delete an Enter fence when a list item cannot become code", () => {
    const { editor, submitCalls } = makeFixture();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "```" }],
                },
              ],
            },
          ],
        },
      ],
    });
    setSelectionAfterText(editor, "```");
    expect(editor.can().setCodeBlock()).toBe(false);

    expect(editor.commands.keyboardShortcut("Enter")).toBe(true);

    expect(submitCalls.count).toBe(1);
    expect(editor.state.doc.firstChild?.type.name).toBe("bulletList");
    expect(editor.state.doc.textContent).toBe("```");
  });

  it("keeps a language suffix when Shift-Enter opens the code block", () => {
    const { editor, submitCalls } = makeFixture();

    typeText(editor, "```");
    fireEvent.keyDown(editor.view.dom, { key: "z", ctrlKey: true });
    typeText(editor, "typescript");
    fireEvent.keyDown(editor.view.dom, { key: "Enter", shiftKey: true });

    expect(submitCalls.count).toBe(0);
    expect(editor.state.doc.firstChild?.type.name).toBe("codeBlock");
    expect(editor.state.doc.firstChild?.attrs.language).toBe("typescript");

    typeText(editor, "const answer: number = 42;");
    const submitted = buildSubmittedChatJSONContent(editor.getJSON(), null);
    expect(
      jsonContentToMarkdown(submitted, {
        mentionFormat: "llm",
        platform: "POSIX",
      }),
    ).toBe("```typescript\nconst answer: number = 42;\n```");
  });

  it("keeps triple backticks that are not on a new code-block line", () => {
    const { editor } = makeFixture();

    typeText(editor, "```");
    typeText(editor, "const literal = ```;");

    expect(editor.state.doc.firstChild?.type.name).toBe("codeBlock");
    expect(editor.state.doc.firstChild?.textContent).toBe(
      "const literal = ```;",
    );
    expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
  });

  it("still submits ordinary text ending in backticks", () => {
    const { editor, submitCalls } = makeFixture();

    typeText(editor, "Keep these ```");
    expect(editor.commands.keyboardShortcut("Enter")).toBe(true);

    expect(submitCalls.count).toBe(1);
    expect(editor.state.doc.textContent).toBe("Keep these ```");
  });

  it.each([
    { input: "**bold**", text: "bold", mark: "bold" },
    { input: "*italic*", text: "italic", mark: "italic" },
    { input: "~~strike~~", text: "strike", mark: "strike" },
    { input: "`code`", text: "code", mark: "code" },
  ])("formats $input as $mark", ({ input, text, mark }) => {
    const { editor } = makeFixture();

    typeText(editor, input);

    expect(editor.getJSON()).toMatchObject({
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text, marks: [{ type: mark }] }],
        },
      ],
    });
  });
});

function typeText(editor: Editor, value: string): void {
  Array.from(value).forEach((char) => typeChar(editor, char));
}

function setSelectionAfterText(editor: Editor, text: string): void {
  let textEnd = -1;
  editor.state.doc.descendants((node, position) => {
    if (node.isText && node.text === text) textEnd = position + node.nodeSize;
    return true;
  });
  editor.commands.setTextSelection(textEnd);
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
