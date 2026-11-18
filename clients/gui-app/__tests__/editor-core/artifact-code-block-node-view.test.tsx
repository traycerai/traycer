import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { EditorContent, EditorContext } from "@tiptap/react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { buildArtifactExtensions, deriveCollabUser } from "@/editor-core";

const writeText = vi.fn();

function mountCodeBlockEditor(code: string): Editor {
  const ydoc = new Y.Doc();
  const fragment = ydoc.getXmlFragment("default");
  const awareness = new Awareness(ydoc);
  const editor = new Editor({
    extensions: buildArtifactExtensions({
      doc: ydoc,
      fragment,
      awareness,
      user: deriveCollabUser({ userName: "Tester", email: null }),
      onCommentShortcut: null,
      placeholderText: "Start writing…",
      titlePlaceholderText: "Untitled",
    }),
  });
  editor.commands.insertContent({
    type: "codeBlock",
    attrs: { language: "sh" },
    content: [{ type: "text", text: code }],
  });
  return editor;
}

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    writable: true,
    value: { writeText },
  });
});

afterEach(() => {
  cleanup();
});

describe("ArtifactCodeBlockNodeView", () => {
  it("copies raw code without markdown fences", async () => {
    const code = "bun install\nbun run setup";
    const editor = mountCodeBlockEditor(code);
    render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
      </EditorContext.Provider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Copy code" }));

    expect(writeText).toHaveBeenCalledWith(code);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    editor.destroy();
  });

  it("keeps the code content editable", async () => {
    const editor = mountCodeBlockEditor("bun install");
    const { container } = render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
      </EditorContext.Provider>,
    );

    const copyButton = await screen.findByRole("button", { name: "Copy code" });
    const code = container.querySelector("pre code");
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe("bun install");
    expect(code?.getAttribute("contenteditable")).not.toBe("false");
    expect(copyButton.getAttribute("contenteditable")).toBe("false");
    editor.destroy();
  });
});
