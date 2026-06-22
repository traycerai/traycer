import "../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { ThreadAnchor } from "@/editor-core";
import {
  clearCommentEditorRegistryForTests,
  revealCommentThreadAnchor,
  registerCommentEditor,
} from "@/lib/comments/comment-editor-registry";

const editors: Editor[] = [];

function makeEditor(content: string): Editor {
  const editor = new Editor({
    extensions: [StarterKit, ThreadAnchor],
    content,
  });
  editors.push(editor);
  return editor;
}

function addThreadAnchor(editor: Editor, threadId: string): void {
  editor.view.dispatch(
    editor.state.tr.addMark(
      1,
      6,
      editor.schema.marks.threadAnchor.create({ threadId }),
    ),
  );
}

afterEach(() => {
  clearCommentEditorRegistryForTests();
  editors.splice(0).forEach((editor) => editor.destroy());
});

describe("comment editor registry", () => {
  it("reveals the active registered editor containing the requested thread anchor without selecting it", () => {
    const inactiveEditor = makeEditor("hello inactive");
    const activeEditor = makeEditor("hello active");
    addThreadAnchor(inactiveEditor, "thread-a");
    addThreadAnchor(activeEditor, "thread-a");
    activeEditor.commands.setTextSelection(7);

    registerCommentEditor({
      epicId: "epic-a",
      artifactId: "spec-a",
      tileId: "tile-inactive",
      editor: inactiveEditor,
      isActive: false,
    });
    registerCommentEditor({
      epicId: "epic-a",
      artifactId: "spec-a",
      tileId: "tile-active",
      editor: activeEditor,
      isActive: true,
    });

    expect(revealCommentThreadAnchor("epic-a", "spec-a", "thread-a")).toBe(
      true,
    );
    expect(activeEditor.state.selection.from).toBe(7);
    expect(activeEditor.state.selection.to).toBe(7);
  });

  it("returns false when no registered editor has the anchor", () => {
    const editor = makeEditor("hello world");
    registerCommentEditor({
      epicId: "epic-a",
      artifactId: "spec-a",
      tileId: "tile-a",
      editor,
      isActive: true,
    });

    expect(revealCommentThreadAnchor("epic-a", "spec-a", "missing")).toBe(
      false,
    );
  });
});
