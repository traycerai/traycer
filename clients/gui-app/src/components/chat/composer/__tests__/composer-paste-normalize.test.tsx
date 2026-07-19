import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import {
  DOMParser as ProseMirrorDOMParser,
  Fragment,
  Slice,
} from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";

import { sanitizeMarkdownHtml } from "@/lib/composer/markdown-paste";
import { normalizeSliceSoftBreaks } from "@/lib/composer/normalize-soft-breaks";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";
import { buildComposerExtensions } from "../editor/editor-config";
import { createComposerPickerStore } from "../picker/composer-picker-store";

const editors: Editor[] = [];
const elements: HTMLElement[] = [];

function makeEditor(): Editor {
  const el = document.createElement("div");
  document.body.appendChild(el);
  elements.push(el);
  const editor = new Editor({
    element: el,
    extensions: buildComposerExtensions({
      pickerStore: createComposerPickerStore(),
      placeholder: "t",
      onSubmit: { current: () => {} },
      slashProviderId: "claude",
      getHasPastedImageBytes: () => null,
    }),
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  editors.splice(0).forEach((e) => e.destroy());
  elements.splice(0).forEach((e) => e.remove());
});

function typeChar(editor: Editor, char: string): void {
  const { from, to } = editor.state.selection;
  const def = () => editor.state.tr.insertText(char, from, to);
  const handled =
    editor.view.someProp("handleTextInput", (h) => {
      const r = h(editor.view, from, to, char, def);
      return r === true ? true : undefined;
    }) === true;
  if (!handled) editor.view.dispatch(def());
}
function typeText(editor: Editor, v: string): void {
  Array.from(v).forEach((c) => typeChar(editor, c));
}

function setText(editor: Editor, text: string): void {
  editor.commands.setContent({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
}

function caretBefore(editor: Editor, text: string): void {
  let pos = -1;
  editor.state.doc.descendants((node, p) => {
    if (node.isText && node.text === text && pos === -1) pos = p;
    return true;
  });
  editor.commands.setTextSelection(pos);
}

describe("normalizeSliceSoftBreaks", () => {
  it("splits inline 'a\\nb' into two paragraphs with open depth 1/1", () => {
    const editor = makeEditor();
    const schema = editor.state.schema;
    const inline = new Slice(Fragment.from(schema.text("a\nb")), 0, 0);
    const out = normalizeSliceSoftBreaks(inline, schema);
    expect(out.content.childCount).toBe(2);
    expect(out.content.firstChild?.type.name).toBe("paragraph");
    expect(out.content.firstChild?.textContent).toBe("a");
    expect(out.content.lastChild?.textContent).toBe("b");
    expect(out.openStart).toBe(1);
    expect(out.openEnd).toBe(1);
  });

  it("returns the original slice unchanged when there is no soft break", () => {
    const editor = makeEditor();
    const schema = editor.state.schema;
    const inline = new Slice(Fragment.from(schema.text("abc")), 0, 0);
    const out = normalizeSliceSoftBreaks(inline, schema);
    expect(out).toBe(inline);
  });

  it("never splits a code block's literal newline", () => {
    const editor = makeEditor();
    const schema = editor.state.schema;
    const code = schema.nodes.codeBlock.create(null, schema.text("a\nb"));
    const slice = new Slice(Fragment.from(code), 0, 0);
    const out = normalizeSliceSoftBreaks(slice, schema);
    expect(out).toBe(slice);
    expect(out.content.firstChild?.type.name).toBe("codeBlock");
  });

  it("mid-paragraph paste merges at both ends (XYa / bZ)", () => {
    const editor = makeEditor();
    setText(editor, "XYZ");
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3)),
    );
    const inline = new Slice(
      Fragment.from(editor.state.schema.text("a\nb")),
      0,
      0,
    );
    editor.view.dispatch(
      editor.state.tr.replaceSelection(
        normalizeSliceSoftBreaks(inline, editor.state.schema),
      ),
    );
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.firstChild?.textContent).toBe("XYa");
    expect(editor.state.doc.lastChild?.textContent).toBe("bZ");
  });
});

describe("paste -> list end to end (HTML branch)", () => {
  it("HTML 'hello<br>abc' pastes as two paragraphs, then '1. ' on line 2 lists 'abc'", () => {
    const editor = makeEditor();
    const html = "<div>hello<br>abc</div>";
    const sanitized = sanitizeMarkdownHtml(html);
    if (sanitized === null)
      throw new Error("sanitizeMarkdownHtml returned null");
    const parser = ProseMirrorDOMParser.fromSchema(editor.state.schema);
    const slice = parser.parseSlice(sanitized, { preserveWhitespace: false });
    editor.view.dispatch(
      editor.state.tr.replaceSelection(
        normalizeSliceSoftBreaks(slice, editor.state.schema),
      ),
    );

    // Two real paragraphs, no hardBreak.
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.firstChild?.textContent).toBe("hello");
    expect(editor.state.doc.lastChild?.textContent).toBe("abc");

    caretBefore(editor, "abc");
    typeText(editor, "1. ");

    expect(editor.state.doc.firstChild?.textContent).toBe("hello");
    let listItemText: string | null = null;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "listItem" && listItemText === null) {
        listItemText = node.textContent;
        return false;
      }
      return true;
    });
    expect(listItemText).toBe("abc");
  });
});

describe("serialization invariance", () => {
  it("hardBreak and paragraph representations submit identical text", () => {
    const withHardBreak = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "hello" },
            { type: "hardBreak" },
            { type: "text", text: "abc" },
          ],
        },
      ],
    };
    const withParagraphs = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "hello" }] },
        { type: "paragraph", content: [{ type: "text", text: "abc" }] },
      ],
    };
    expect(extractPlainTextFromComposerJSONContent(withHardBreak)).toBe(
      "hello\nabc",
    );
    expect(extractPlainTextFromComposerJSONContent(withParagraphs)).toBe(
      "hello\nabc",
    );
  });
});
