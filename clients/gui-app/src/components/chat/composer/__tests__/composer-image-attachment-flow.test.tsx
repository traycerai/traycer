import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";

import type { ImageAttachmentAttrs } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import { insertImageAttachmentsCommand } from "@/hooks/composer/use-composer-paste";

import { buildComposerExtensions } from "../editor/editor-config";
import { createComposerPickerStore } from "../picker/composer-picker-store";

const editors: Editor[] = [];
const elements: HTMLElement[] = [];

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
  elements.splice(0).forEach((element) => element.remove());
});

describe("composer image attachment flow", () => {
  it("inserts an image at the caret before text", () => {
    const editor = makeEditor();
    editor.commands.setContent(paragraphText("hello"));
    editor.commands.setTextSelection(1);

    insertImageAttachmentsCommand(editor, [imageAttrs("img-1")], false);

    expect(paragraphChildTypes(editor)).toEqual(["imageAttachment", "text"]);
    expect(imageIds(editor)).toEqual(["img-1"]);
  });

  it("inserts an image at the caret after text", () => {
    const editor = makeEditor();
    editor.commands.setContent(paragraphText("hello"));
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);

    insertImageAttachmentsCommand(editor, [imageAttrs("img-1")], false);

    expect(paragraphChildTypes(editor)).toEqual(["text", "imageAttachment"]);
    expect(imageIds(editor)).toEqual(["img-1"]);
  });

  it("inserts an image after a slash chip when the caret is there", () => {
    const editor = makeEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "slashCommand", attrs: { commandName: "plan" } },
            { type: "text", text: " details" },
          ],
        },
      ],
    });
    const slash = firstNodePosition(editor, "slashCommand");
    if (slash === null) throw new Error("expected slash command");
    editor.commands.setTextSelection(slash.pos + slash.size);

    insertImageAttachmentsCommand(editor, [imageAttrs("img-1")], false);

    expect(paragraphChildTypes(editor)).toEqual([
      "slashCommand",
      "imageAttachment",
      "text",
    ]);
  });

  it("preserves selected text when pasting an image attachment", () => {
    const editor = makeEditor();
    editor.commands.setContent(paragraphText("abcdef"));
    editor.commands.setTextSelection({ from: 2, to: 5 });

    insertImageAttachmentsCommand(editor, [imageAttrs("img-1")], false);

    expect(editor.state.doc.textContent).toBe("abcdef");
    expect(imageIds(editor)).toEqual(["img-1"]);
    expect(paragraphChildTypes(editor)).toEqual([
      "text",
      "imageAttachment",
      "text",
    ]);
  });

  it("preserves insertion order for multiple images", () => {
    const editor = makeEditor();

    insertImageAttachmentsCommand(
      editor,
      [imageAttrs("img-1"), imageAttrs("img-2"), imageAttrs("img-3")],
      false,
    );

    expect(imageIds(editor)).toEqual(["img-1", "img-2", "img-3"]);
  });

  it("keeps a pasted image as a positional inline atom when text is typed after it", () => {
    const editor = makeEditor();

    insertImageAttachmentsCommand(editor, [imageAttrs("img-1")], false);
    editor.commands.insertContent("hello");

    expect(editor.getJSON()).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "imageAttachment",
              attrs: {
                ...imageAttrs("img-1"),
                hash: null,
              },
            },
            { type: "text", text: "hello" },
          ],
        },
      ],
    });
    expect(
      editor.view.dom.querySelector("p [data-composer-image-attachment]"),
    ).not.toBeNull();
  });

  it("adds a stable caret boundary after a terminal image when requested", () => {
    const editor = makeEditor();

    insertImageAttachmentsCommand(editor, [imageAttrs("img-1")], true);

    expect(paragraphInlineSequence(editor)).toEqual(["image:img-1", "text: "]);
    expect(editor.state.selection.from).toBe(2);
    expect(editor.state.selection.$from.nodeAfter?.text).toBe(" ");
  });

  it("keeps typed text before the terminal image caret boundary", () => {
    const editor = makeEditor();

    insertImageAttachmentsCommand(editor, [imageAttrs("img-1")], true);
    editor.commands.insertContent("hello");

    expect(paragraphInlineSequence(editor)).toEqual([
      "image:img-1",
      "text:hello ",
    ]);
    expect(editor.state.selection.from).toBe(7);
    expect(editor.state.selection.$from.nodeAfter?.text).toBe(" ");
  });

  it("does not add a caret boundary when the inserted image is followed by content", () => {
    const editor = makeEditor();
    editor.commands.setContent(paragraphText("hello"));
    editor.commands.setTextSelection(1);

    insertImageAttachmentsCommand(editor, [imageAttrs("img-1")], true);

    expect(paragraphInlineSequence(editor)).toEqual([
      "image:img-1",
      "text:hello",
    ]);
  });

  it("undoes a terminal image insertion and its caret boundary together", () => {
    const editor = makeEditor();

    insertImageAttachmentsCommand(editor, [imageAttrs("img-1")], true);
    editor.commands.undo();

    expect(paragraphInlineSequence(editor)).toEqual([]);
  });

  it("removes the matching inline image atom by id", () => {
    const editor = makeEditor();
    insertImageAttachmentsCommand(
      editor,
      [imageAttrs("img-1"), imageAttrs("img-2"), imageAttrs("img-3")],
      false,
    );

    editor.commands.removeImageAttachmentById("img-2");

    expect(imageIds(editor)).toEqual(["img-1", "img-3"]);
  });

  // Round-4 in-place paste: rewrite b64 → hash by id, position preserved.
  it("rewriteImageAttachmentHashById flips a b64 node to hash in place", () => {
    const editor = makeEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "A" },
            {
              type: "imageAttachment",
              attrs: {
                id: "pending-1",
                fileName: "shot.png",
                b64content: "abc123",
                mimeType: "image/png",
                size: 6,
              },
            },
            { type: "text", text: "B" },
          ],
        },
      ],
    });
    const posBefore = imagePositions(editor);
    expect(posBefore).toEqual([{ id: "pending-1", pos: 2 }]);

    const rewritten = editor.commands.rewriteImageAttachmentHashById(
      "pending-1",
      "deadbeef".repeat(8),
    );
    expect(rewritten).toBe(true);

    expect(paragraphInlineSequence(editor)).toEqual([
      "text:A",
      "image:pending-1",
      "text:B",
    ]);
    expect(imagePositions(editor)).toEqual(posBefore);
    const node = firstImageNode(editor, "pending-1");
    expect(node).not.toBeNull();
    if (node === null) return;
    expect(node.attrs.hash).toBe("deadbeef".repeat(8));
    expect(node.attrs.b64content).toBeNull();
  });

  it("rewriteImageAttachmentHashById is a no-op for an unknown id", () => {
    const editor = makeEditor();
    insertImageAttachmentsCommand(editor, [imageAttrs("img-1")], false);
    const before = editor.getJSON();

    const rewritten = editor.commands.rewriteImageAttachmentHashById(
      "missing-id",
      "cafebabe".repeat(8),
    );

    expect(rewritten).toBe(false);
    expect(editor.getJSON()).toEqual(before);
    expect(imageIds(editor)).toEqual(["img-1"]);
    const node = firstImageNode(editor, "img-1");
    expect(node?.attrs.b64content).toBe("img-1");
    expect(node?.attrs.hash).toBeNull();
  });
});

function makeEditor(): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  elements.push(element);
  const editor = new Editor({
    element,
    extensions: buildComposerExtensions({
      pickerStore: createComposerPickerStore(),
      placeholder: "test",
      onSubmit: { current: () => undefined },
      slashProviderId: "claude",
      getHasPastedImageBytes: () => null,
      getIngestPastedComposerImages: () => null,
    }),
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
  editors.push(editor);
  return editor;
}

function paragraphText(text: string) {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

function imageAttrs(id: string): ImageAttachmentAttrs {
  return {
    id,
    fileName: `${id}.png`,
    b64content: id,
    mimeType: "image/png",
    size: id.length,
  };
}

function paragraphChildTypes(editor: Editor): string[] {
  const first = editor.state.doc.firstChild;
  if (first === null) return [];
  const types: string[] = [];
  first.forEach((node) => {
    types.push(node.type.name);
  });
  return types;
}

function paragraphInlineSequence(editor: Editor): string[] {
  const first = editor.state.doc.firstChild;
  if (first === null) return [];
  const sequence: string[] = [];
  first.forEach((node) => {
    if (node.type.name === "imageAttachment") {
      sequence.push(`image:${node.attrs.id}`);
      return;
    }
    if (node.isText) {
      sequence.push(`text:${node.text ?? ""}`);
      return;
    }
    sequence.push(node.type.name);
  });
  return sequence;
}

function imageIds(editor: Editor): string[] {
  const ids: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name !== "imageAttachment") return true;
    if (typeof node.attrs.id === "string") ids.push(node.attrs.id);
    return false;
  });
  return ids;
}

function imagePositions(
  editor: Editor,
): Array<{ readonly id: string; readonly pos: number }> {
  const positions: Array<{ readonly id: string; readonly pos: number }> = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "imageAttachment") return true;
    if (typeof node.attrs.id === "string") {
      positions.push({ id: node.attrs.id, pos });
    }
    return false;
  });
  return positions;
}

function firstImageNode(
  editor: Editor,
  id: string,
): { readonly attrs: Record<string, unknown> } | null {
  let found: { readonly attrs: Record<string, unknown> } | null = null;
  editor.state.doc.descendants((node) => {
    if (node.type.name !== "imageAttachment") return true;
    if (node.attrs.id !== id) return false;
    found = { attrs: node.attrs };
    return false;
  });
  return found;
}

function firstNodePosition(
  editor: Editor,
  typeName: string,
): { readonly pos: number; readonly size: number } | null {
  let found: { readonly pos: number; readonly size: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name !== typeName) return true;
    found = { pos, size: node.nodeSize };
    return false;
  });
  return found;
}
