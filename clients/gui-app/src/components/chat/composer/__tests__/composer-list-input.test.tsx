import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { jsonContentToMarkdown } from "@traycer/protocol/common/json-content-serializer";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  buildSubmittedChatJSONContent,
  numberValue,
} from "@/lib/composer/tiptap-json-content";
import { ComposerContentRenderer } from "../content-renderer";
import { buildComposerExtensions } from "../editor/editor-config";
import { createComposerPickerStore } from "../picker/composer-picker-store";

const editors: Editor[] = [];
const elements: HTMLElement[] = [];

function makeFixture(): {
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
  return { editor, submitCalls };
}

afterEach(() => {
  cleanup();
  editors.splice(0).forEach((editor) => editor.destroy());
  elements.splice(0).forEach((element) => element.remove());
});

describe("composer list input", () => {
  it("turns '- ' on a second paragraph into a bullet list", () => {
    const { editor } = makeFixture();
    editor.commands.insertContent("Intro");
    // Shift+Enter now splits into a real paragraph (no hardBreak).
    expect(editor.commands.keyboardShortcut("Shift-Enter")).toBe(true);

    typeText(editor, "- ");
    typeText(editor, "item");

    expect(topLevelTypes(editor)).toEqual([
      "paragraph",
      "bulletList",
      "paragraph",
    ]);
    expect(editor.state.doc.firstChild?.textContent).toBe("Intro");
    expect(textOfFirstNode(editor, "listItem")).toBe("item");
    expect(editor.state.doc.lastChild?.textContent).toBe("");
  });

  it("turns '1. ' on a second paragraph into an ordered list", () => {
    const { editor } = makeFixture();
    editor.commands.insertContent("Intro");
    expect(editor.commands.keyboardShortcut("Shift-Enter")).toBe(true);

    typeText(editor, "3. ");
    typeText(editor, "step");

    expect(topLevelTypes(editor)).toEqual([
      "paragraph",
      "orderedList",
      "paragraph",
    ]);
    const orderedList = firstNodeOfType(editor, "orderedList");
    expect(orderedList?.attrs.start).toBe(3);
    expect(textOfFirstNode(editor, "listItem")).toBe("step");
    expect(editor.state.doc.lastChild?.textContent).toBe("");
  });

  it("wraps existing text when a marker is typed before it (regression)", () => {
    const { editor } = makeFixture();
    editor.commands.insertContent("hello");
    expect(editor.commands.keyboardShortcut("Shift-Enter")).toBe(true);
    typeText(editor, "abc");
    // Caret to the start of the second paragraph, before "abc".
    let beforeAbc = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "abc") beforeAbc = pos;
      return true;
    });
    editor.commands.setTextSelection(beforeAbc);

    typeText(editor, "1. ");

    expect(editor.state.doc.firstChild?.textContent).toBe("hello");
    expect(textOfFirstNode(editor, "listItem")).toBe("abc");
    expect(firstNodeOfType(editor, "orderedList")).not.toBeNull();
  });

  it("submits with Enter even when the caret is inside a list item", () => {
    const { editor, submitCalls } = makeFixture();
    editor.commands.insertContent("Intro");
    expect(editor.commands.keyboardShortcut("Shift-Enter")).toBe(true);
    typeText(editor, "- ");
    typeText(editor, "item");

    expect(editor.commands.keyboardShortcut("Enter")).toBe(true);

    expect(submitCalls.count).toBe(1);
    expect(listItemTexts(editor)).toEqual(["item"]);
  });

  it("continues the current list with Shift+Enter", () => {
    const { editor, submitCalls } = makeFixture();
    editor.commands.insertContent("Intro");
    expect(editor.commands.keyboardShortcut("Shift-Enter")).toBe(true);
    typeText(editor, "1. ");
    typeText(editor, "first");

    expect(editor.commands.keyboardShortcut("Shift-Enter")).toBe(true);
    typeText(editor, "second");

    expect(submitCalls.count).toBe(0);
    expect(listItemTexts(editor)).toEqual(["first", "second"]);
  });

  it("preserves a non-one starting number from input through sent-message rendering", () => {
    const { editor, submitCalls } = makeFixture();
    typeText(editor, "2. Hello");

    expect(firstNodeOfType(editor, "orderedList")?.attrs.start).toBe(2);
    expect(editor.commands.keyboardShortcut("Enter")).toBe(true);
    expect(submitCalls.count).toBe(1);

    const submitted = buildSubmittedChatJSONContent(editor.getJSON(), null);
    expect(serializeForAgent(submitted)).toBe("2. Hello");

    const rendered = renderSubmittedContent(submitted);
    const orderedList = orderedListElement(within(rendered).getByRole("list"));
    expect(orderedList.start).toBe(2);
    expect(within(orderedList).getByRole("listitem").textContent).toBe("Hello");
  });

  it("keeps a later-starting multi-item list sequential after submission", () => {
    const { editor, submitCalls } = makeFixture();
    typeText(editor, "2. First");
    expect(editor.commands.keyboardShortcut("Shift-Enter")).toBe(true);
    typeText(editor, "Second");

    expect(editor.commands.keyboardShortcut("Enter")).toBe(true);
    expect(submitCalls.count).toBe(1);

    const submitted = buildSubmittedChatJSONContent(editor.getJSON(), null);
    expect(serializeForAgent(submitted)).toBe("2. First\n3. Second");

    const rendered = renderSubmittedContent(submitted);
    const orderedList = orderedListElement(within(rendered).getByRole("list"));
    expect(orderedList.start).toBe(2);
    expect(
      within(orderedList)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["First", "Second"]);
  });

  it("preserves separately entered list starts when two appears before one", () => {
    const { editor, submitCalls } = makeFixture();
    typeText(editor, "2. Second");
    expect(editor.commands.keyboardShortcut("Shift-Enter")).toBe(true);
    expect(editor.commands.keyboardShortcut("Shift-Enter")).toBe(true);
    typeText(editor, "1. First");

    expect(
      editor
        .getJSON()
        .content.filter((node) => node.type === "orderedList")
        .map((node) => numberValue(node.attrs?.start)),
    ).toEqual([2, 1]);
    expect(editor.commands.keyboardShortcut("Enter")).toBe(true);
    expect(submitCalls.count).toBe(1);

    const submitted = buildSubmittedChatJSONContent(editor.getJSON(), null);
    expect(serializeForAgent(submitted)).toBe("2. Second\n\n1. First");
    const rendered = renderSubmittedContent(submitted);
    expect(
      within(rendered)
        .getAllByRole("list")
        .map((list) => orderedListElement(list).start),
    ).toEqual([2, 1]);
  });
});

function renderSubmittedContent(content: JsonContent): HTMLElement {
  return render(
    <ComposerContentRenderer
      content={content}
      variant={undefined}
      className={undefined}
      testId={undefined}
    />,
  ).container;
}

function orderedListElement(element: HTMLElement): HTMLOListElement {
  if (!(element instanceof HTMLOListElement)) {
    throw new Error("expected an ordered list");
  }
  return element;
}

function serializeForAgent(content: JsonContent): string {
  return jsonContentToMarkdown(content, {
    mentionFormat: "llm",
    platform: "POSIX",
  });
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

function topLevelTypes(editor: Editor): string[] {
  return editor.getJSON().content.map((node) => node.type);
}

function textOfFirstNode(editor: Editor, type: string): string | null {
  return firstNodeOfType(editor, type)?.textContent ?? null;
}

function listItemTexts(editor: Editor): string[] {
  const texts: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name !== "listItem") return true;
    texts.push(node.textContent);
    return false;
  });
  return texts;
}

function firstNodeOfType(editor: Editor, type: string): ProseMirrorNode | null {
  let found: ProseMirrorNode | null = null;
  editor.state.doc.descendants((node) => {
    if (node.type.name !== type) return true;
    found = node;
    return false;
  });
  return found;
}
