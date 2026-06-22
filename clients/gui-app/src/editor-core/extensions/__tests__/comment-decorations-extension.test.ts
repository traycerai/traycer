import "../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { ThreadAnchor } from "../thread-anchor";
import {
  applyCommentDecorationSnapshot,
  CommentDecorationsExtension,
} from "../comment-decorations-extension";

const editors: Editor[] = [];

function makeEditor(): Editor {
  const editor = new Editor({
    extensions: [StarterKit, ThreadAnchor, CommentDecorationsExtension],
    content: `<p><span data-thread-id="thread-a">hello</span> world</p>`,
  });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
});

describe("CommentDecorationsExtension", () => {
  it("makes resolved anchors inert even when active, hovered, or flashing", () => {
    const editor = makeEditor();

    applyCommentDecorationSnapshot(editor, {
      activeThreadId: "thread-a",
      hoverThreadId: "thread-a",
      flashThreadId: "thread-a",
      resolvedThreadIds: new Set(["thread-a"]),
      liveThreadIds: null,
      draftRange: null,
    });

    const resolved = editor.view.dom.querySelector<HTMLElement>(
      "[data-resolved='true']",
    );
    expect(resolved).not.toBeNull();
    expect(resolved?.dataset.commentAnchor).toBeUndefined();
    expect(resolved?.dataset.active).toBeUndefined();
    expect(resolved?.dataset.hover).toBeUndefined();
    expect(resolved?.dataset.flash).toBeUndefined();
  });

  it("paints unresolved anchors from the decoration layer", () => {
    const editor = makeEditor();

    applyCommentDecorationSnapshot(editor, {
      activeThreadId: null,
      hoverThreadId: null,
      flashThreadId: null,
      resolvedThreadIds: new Set(),
      liveThreadIds: null,
      draftRange: null,
    });

    const visibleAnchor = editor.view.dom.querySelector<HTMLElement>(
      "[data-comment-anchor='true']",
    );
    expect(visibleAnchor).not.toBeNull();
    expect(visibleAnchor?.dataset.resolved).toBeUndefined();
  });

  it("suppresses anchors whose threadId is missing from liveThreadIds", () => {
    const editor = makeEditor();

    applyCommentDecorationSnapshot(editor, {
      activeThreadId: null,
      hoverThreadId: null,
      flashThreadId: null,
      resolvedThreadIds: new Set(),
      liveThreadIds: new Set(["thread-other"]),
      draftRange: null,
    });

    expect(
      editor.view.dom.querySelector<HTMLElement>(
        "[data-comment-anchor='true']",
      ),
    ).toBeNull();
    expect(
      editor.view.dom.querySelector<HTMLElement>("[data-resolved='true']"),
    ).toBeNull();
  });

  it("paints anchors when liveThreadIds includes the threadId", () => {
    const editor = makeEditor();

    applyCommentDecorationSnapshot(editor, {
      activeThreadId: null,
      hoverThreadId: null,
      flashThreadId: null,
      resolvedThreadIds: new Set(),
      liveThreadIds: new Set(["thread-a"]),
      draftRange: null,
    });

    const visibleAnchor = editor.view.dom.querySelector<HTMLElement>(
      "[data-comment-anchor='true']",
    );
    expect(visibleAnchor).not.toBeNull();
  });
});
