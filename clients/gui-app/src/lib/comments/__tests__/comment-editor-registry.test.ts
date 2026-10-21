import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { ThreadAnchor } from "@/editor-core";
import {
  clearCommentEditorRegistryForTests,
  requestCommentThreadAnchorReveal,
  revealCommentThreadAnchor,
  registerCommentEditor,
} from "@/lib/comments/comment-editor-registry";
import { useCommentThreadsStore } from "@/stores/comments/comment-threads-store";

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
  useCommentThreadsStore.setState({ activeByEpicId: {} });
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

describe("requestCommentThreadAnchorReveal", () => {
  const EPIC = "epic-a";
  const ARTIFACT = "html-a";

  function activate(threadId: string | null): void {
    useCommentThreadsStore.getState().setActiveThread(EPIC, threadId);
  }

  function registerFrame(reveal: (threadId: string) => boolean): () => void {
    return registerCommentEditor({
      epicId: EPIC,
      artifactId: ARTIFACT,
      tileId: "tile-1",
      isActive: true,
      reveal,
    });
  }

  it("reveals once the artifact's view registers after the request", () => {
    activate("thread-a");
    requestCommentThreadAnchorReveal(EPIC, ARTIFACT, "thread-a");
    const reveal = vi.fn(() => true);

    registerFrame(reveal);

    expect(reveal).toHaveBeenCalledExactlyOnceWith("thread-a");
  });

  it("keeps retrying on each registration until the view reports it is ready", () => {
    activate("thread-a");
    requestCommentThreadAnchorReveal(EPIC, ARTIFACT, "thread-a");
    const notReady = vi.fn(() => false);
    const ready = vi.fn(() => true);

    // A view that has mounted but whose bridge is not ready answers false.
    registerFrame(notReady);
    registerFrame(ready);
    registerFrame(ready);

    expect(notReady).toHaveBeenCalledTimes(1);
    // Once a reveal succeeds the request is spent: re-registering on a view
    // change must not scroll the page again.
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("attempts the reveal immediately when the view is already registered", () => {
    const reveal = vi.fn(() => true);
    registerFrame(reveal);
    activate("thread-a");

    requestCommentThreadAnchorReveal(EPIC, ARTIFACT, "thread-a");

    expect(reveal).toHaveBeenCalledExactlyOnceWith("thread-a");
  });

  it.each([
    ["another thread becomes active", "thread-b"],
    ["the thread is dismissed", null],
  ])("is cancelled when %s", (_label, nextActive) => {
    activate("thread-a");
    requestCommentThreadAnchorReveal(EPIC, ARTIFACT, "thread-a");
    activate(nextActive);
    const reveal = vi.fn(() => true);

    registerFrame(reveal);

    expect(reveal).not.toHaveBeenCalled();
  });

  it("is superseded by a later request for the same epic", () => {
    activate("thread-a");
    requestCommentThreadAnchorReveal(EPIC, ARTIFACT, "thread-a");
    activate("thread-b");
    requestCommentThreadAnchorReveal(EPIC, ARTIFACT, "thread-b");
    const reveal = vi.fn(() => true);

    registerFrame(reveal);

    expect(reveal).toHaveBeenCalledExactlyOnceWith("thread-b");
  });

  it("does not reveal for a view registered under another artifact", () => {
    activate("thread-a");
    requestCommentThreadAnchorReveal(EPIC, ARTIFACT, "thread-a");
    const reveal = vi.fn(() => true);

    registerCommentEditor({
      epicId: EPIC,
      artifactId: "other-artifact",
      tileId: "tile-2",
      isActive: true,
      reveal,
    });

    expect(reveal).not.toHaveBeenCalled();
  });
});
