import { fireEvent, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { jsonContentToMarkdown } from "@traycer/protocol/common/json-content-serializer";

import { insertImageAttachmentsCommand } from "@/hooks/composer/use-composer-paste";
import { buildSubmittedChatJSONContent } from "@/lib/composer/tiptap-json-content";
import { buildComposerExtensions } from "../editor/editor-config";
import type { ImageAttachmentAttrs } from "../editor/extensions/image-attachment-extension";
import { createComposerPickerStore } from "../picker/composer-picker-store";

// Pasted through the real `insertImageAttachmentsCommand` with caret
// stabilization on, as both composers do, so the chip is followed by the
// padding space the caret sits before.
const PASTED_IMAGE: ImageAttachmentAttrs = {
  id: "img-1",
  fileName: "shot.png",
  mimeType: "image/png",
  size: 10,
  byHashEligible: true,
  hash: "abc",
};

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

  it("opens a fence typed after an image attachment and text", () => {
    const { editor, submitCalls } = makeFixture();

    insertImageAttachmentsCommand(editor, [PASTED_IMAGE], true);
    typeText(editor, ", a user has reported that:");
    fireEvent.keyDown(editor.view.dom, { key: "Enter", shiftKey: true });

    expect(editor.state.doc.child(1).type.name).toBe("paragraph");
    expect(editor.state.doc.child(1).content.size).toBe(0);
    expect(editor.state.selection.$from.parentOffset).toBe(0);

    typeText(editor, "```");

    expect(submitCalls.count).toBe(0);
    expect(editor.getJSON().content.map((node) => node.type)).toEqual([
      "paragraph",
      "codeBlock",
      "paragraph",
    ]);
    expect(editor.state.doc.child(1).type.name).toBe("codeBlock");
    expect(editor.state.doc.child(1).textContent).toBe("");
    expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
    expect(editor.getJSON().content[0]).toMatchObject({
      type: "paragraph",
      content: [
        { type: "imageAttachment", attrs: { id: "img-1" } },
        { type: "text", text: ", a user has reported that: " },
      ],
    });
  });

  it("leaves a list with Shift-Enter after an image pasted at the end of an item", () => {
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
                  content: [{ type: "text", text: "item " }],
                },
              ],
            },
          ],
        },
      ],
    });
    setSelectionAfterText(editor, "item ");
    insertImageAttachmentsCommand(editor, [PASTED_IMAGE], true);

    fireEvent.keyDown(editor.view.dom, { key: "Enter", shiftKey: true });

    const bulletList = editor.state.doc.firstChild;
    expect(bulletList?.type.name).toBe("bulletList");
    expect(bulletList?.childCount).toBe(2);
    expect(bulletList?.child(1).firstChild?.content.size).toBe(0);

    fireEvent.keyDown(editor.view.dom, { key: "Enter", shiftKey: true });

    const bulletListAfter = editor.state.doc.firstChild;
    expect(bulletListAfter?.type.name).toBe("bulletList");
    expect(bulletListAfter?.childCount).toBe(1);
    expect(editor.isActive("listItem")).toBe(false);
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(editor.state.selection.$from.parent.content.size).toBe(0);
    expect(submitCalls.count).toBe(0);
  });

  it("leaves a quote with Shift-Enter after an image pasted at the end of a line", () => {
    const { editor, submitCalls } = makeFixture();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "quoted " }],
            },
          ],
        },
      ],
    });
    setSelectionAfterText(editor, "quoted ");
    insertImageAttachmentsCommand(editor, [PASTED_IMAGE], true);

    fireEvent.keyDown(editor.view.dom, { key: "Enter", shiftKey: true });

    const blockquote = editor.state.doc.firstChild;
    expect(blockquote?.type.name).toBe("blockquote");
    expect(blockquote?.childCount).toBe(2);
    expect(blockquote?.child(1).content.size).toBe(0);

    fireEvent.keyDown(editor.view.dom, { key: "Enter", shiftKey: true });

    const blockquoteAfter = editor.state.doc.firstChild;
    expect(blockquoteAfter?.type.name).toBe("blockquote");
    expect(blockquoteAfter?.childCount).toBe(1);
    expect(editor.isActive("blockquote")).toBe(false);
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(editor.state.selection.$from.parent.content.size).toBe(0);
    expect(submitCalls.count).toBe(0);
  });

  it("keeps trailing whitespace after the caret on Shift-Enter inside a code block", () => {
    const { editor } = makeFixture();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          content: [{ type: "text", text: "code  " }],
        },
      ],
    });
    editor.commands.setTextSelection(5);

    fireEvent.keyDown(editor.view.dom, { key: "Enter", shiftKey: true });

    expect(editor.state.doc.firstChild?.textContent).toBe("code\n  ");
  });

  it.each([
    { label: "Enter", eventInit: { key: "Enter" } },
    { label: "Shift-Enter", eventInit: { key: "Enter", shiftKey: true } },
  ])(
    "drops trailing whitespace opening a fence via $label",
    ({ eventInit }) => {
      const { editor, submitCalls } = makeFixture();
      editor.commands.setContent({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "```  " }],
          },
        ],
      });
      editor.commands.setTextSelection(4);

      fireEvent.keyDown(editor.view.dom, eventInit);

      expect(editor.state.doc.firstChild?.type.name).toBe("codeBlock");
      expect(editor.state.doc.firstChild?.textContent).toBe("");
      expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
      expect(submitCalls.count).toBe(0);
    },
  );

  it("keeps the opening fence literal on Shift-Enter when non-whitespace follows", () => {
    const { editor, submitCalls } = makeFixture();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "```x" }],
        },
      ],
    });
    editor.commands.setTextSelection(4);

    fireEvent.keyDown(editor.view.dom, { key: "Enter", shiftKey: true });

    expect(
      editor.getJSON().content.some((node) => node.type === "codeBlock"),
    ).toBe(false);
    expect(submitCalls.count).toBe(0);
  });

  it("restores the literal fence and trailing whitespace with Ctrl-z", () => {
    const { editor } = makeFixture();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "`` " }],
        },
      ],
    });
    editor.commands.setTextSelection(3);

    typeText(editor, "`");
    expect(editor.state.doc.firstChild?.type.name).toBe("codeBlock");

    fireEvent.keyDown(editor.view.dom, { key: "z", ctrlKey: true });

    expect(editor.getJSON().content.map((node) => node.type)).toEqual([
      "paragraph",
    ]);
    expect(editor.state.doc.firstChild?.textContent).toBe("``` ");
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
