import { afterEach, describe, expect, it } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { EditorContent, EditorContext } from "@tiptap/react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import {
  ArtifactToolbar,
  buildArtifactExtensions,
  deriveCollabUser,
} from "@/editor-core";

function mountToolbarEditor(): Editor {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("default");
  const awareness = new Awareness(doc);
  const user = deriveCollabUser({ userName: "T", email: "t@x.io" });
  return new Editor({
    extensions: buildArtifactExtensions({
      doc,
      fragment,
      awareness,
      user,
      onCommentShortcut: null,
      placeholderText: "Start writing…",
      titlePlaceholderText: "Untitled",
    }),
  });
}

/**
 * `BubbleMenu` only mounts its children when the editor has a non-empty
 * selection. Seed a paragraph, select it, and wait for the popover to
 * attach before asserting on toolbar contents.
 */
async function revealBubbleMenu(editor: Editor): Promise<void> {
  editor.commands.setContent("hello world");
  editor.commands.selectAll();
  await waitFor(
    () => {
      if (
        screen.queryByRole("toolbar", { name: /editor formatting/i }) === null
      ) {
        throw new Error("bubble menu not shown yet");
      }
    },
    { timeout: 1000 },
  );
}

afterEach(() => {
  cleanup();
});

describe("ArtifactToolbar", () => {
  it("exposes a toolbar region with formatting buttons when selection active", async () => {
    const editor = mountToolbarEditor();
    render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
        <ArtifactToolbar
          editor={editor}
          className={undefined}
          commentAction={null}
          suppressBubbleMenu={false}
        />
      </EditorContext.Provider>,
    );
    await revealBubbleMenu(editor);
    expect(screen.getByRole("button", { name: /bold/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /heading 1/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^undo$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^redo$/i })).toBeNull();
    editor.destroy();
  });

  it("stays hidden while the editor is not editable", () => {
    const editor = mountToolbarEditor();
    editor.setEditable(false);
    editor.commands.setContent("hello world");
    editor.commands.selectAll();
    render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
        <ArtifactToolbar
          editor={editor}
          className={undefined}
          commentAction={null}
          suppressBubbleMenu={false}
        />
      </EditorContext.Provider>,
    );
    // The shouldShow callback on the bubble menu short-circuits on
    // `!editor.isEditable`, so the popover is never mounted.
    expect(
      screen.queryByRole("toolbar", { name: /editor formatting/i }),
    ).toBeNull();
    editor.destroy();
  });

  it("stays hidden while the comment draft composer owns the selection", () => {
    const editor = mountToolbarEditor();
    editor.commands.setContent("hello world");
    editor.commands.selectAll();
    render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
        <ArtifactToolbar
          editor={editor}
          className={undefined}
          commentAction={{ onStart: () => {} }}
          suppressBubbleMenu
        />
      </EditorContext.Provider>,
    );

    expect(
      screen.queryByRole("toolbar", { name: /editor formatting/i }),
    ).toBeNull();
    editor.destroy();
  });
});
