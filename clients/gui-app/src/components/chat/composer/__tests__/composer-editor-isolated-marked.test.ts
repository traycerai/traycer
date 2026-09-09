import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { marked } from "marked";

import { buildComposerExtensions } from "../editor/editor-config";
import { createComposerPickerStore } from "../picker/composer-picker-store";
import type { MarkedModule } from "@/lib/markdown/isolated-marked";

const editors: Editor[] = [];
const elements: HTMLElement[] = [];

/** Tokenizers registered on a marked module object (inline + block). */
function registeredTokenizerCount(module: MarkedModule): number {
  const extensions = module.defaults.extensions;
  if (extensions === undefined || extensions === null) return 0;
  return (extensions.inline?.length ?? 0) + (extensions.block?.length ?? 0);
}

function makeComposerEditor(): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  elements.push(element);
  const editor = new Editor({
    element,
    extensions: buildComposerExtensions({
      pickerStore: createComposerPickerStore(),
      getPlaceholder: () => "test",
      onSubmit: { current: () => {} },
      slashProviderId: "claude",
      getHasPastedImageBytes: () => null,
      getIngestPastedComposerImages: () => null,
    }),
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
  elements.splice(0).forEach((element) => element.remove());
});

describe("composer editors use a private marked instance", () => {
  it("leaves the real marked singleton's registrations untouched across several editors", () => {
    const before = registeredTokenizerCount(marked);

    const editorA = makeComposerEditor();
    const editorB = makeComposerEditor();
    const editorC = makeComposerEditor();

    expect(registeredTokenizerCount(marked)).toBe(before);

    editorA.destroy();
    editorB.destroy();
    editorC.destroy();

    expect(registeredTokenizerCount(marked)).toBe(before);
  });

  it("registers each editor's tokenizers on its own private marked instance", () => {
    const editorA = makeComposerEditor();
    const editorB = makeComposerEditor();

    const instanceA = editorA.storage.markdown.manager.instance;
    const instanceB = editorB.storage.markdown.manager.instance;

    expect(registeredTokenizerCount(instanceA)).toBeGreaterThan(0);
    expect(registeredTokenizerCount(instanceB)).toBeGreaterThan(0);

    expect(instanceA).not.toBe(instanceB);
    expect(instanceA).not.toBe(marked);
    expect(instanceB).not.toBe(marked);
  });

  it("still parses pasted markdown through the private instance", () => {
    const editor = makeComposerEditor();

    const parsed = editor.storage.markdown.manager.parse("**bold** text");
    const paragraph = parsed.content?.[0];
    const boldNode = paragraph?.content?.find((node) =>
      node.marks?.some((mark) => mark.type === "bold"),
    );

    expect(boldNode).toBeDefined();
  });
});
