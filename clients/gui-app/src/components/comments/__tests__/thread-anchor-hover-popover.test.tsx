import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { CommentThreadWire } from "@traycer/protocol/host/epic/unary-schemas";
import { ThreadAnchorHoverPopover } from "@/components/comments/thread-anchor-hover-popover";
import { useCommentThreadsStore } from "@/stores/comments/comment-threads-store";

const EPIC_ID = "epic-1";
const ARTIFACT_ID = "spec-1";
const THREAD_ID = "thread-1";
const QUOTED_TEXT = "the sentence this thread hangs off";

// The popover reads the thread payload from the cache only (`enabled: false`),
// so the query is stood in for rather than driven through a host: what is under
// test is which GESTURE reaches which surface.
const threads: { value: ReadonlyArray<CommentThreadWire> } = { value: [] };
vi.mock("@/hooks/comments/use-epic-comment-threads", () => ({
  useEpicCommentThreadsForClient: () => ({ data: { threads: threads.value } }),
}));

function threadFixture(): CommentThreadWire {
  return {
    threadId: THREAD_ID,
    resolved: false,
    createdAt: 1,
    comments: [
      {
        commentId: "comment-1",
        content: { type: "doc", content: [] },
        createdAt: 1,
        updatedAt: null,
        author: { userId: "user-1", fallbackHandle: "someone" },
      },
    ],
    data: { createdByUserId: "user-1", quotedText: QUOTED_TEXT },
  };
}

const editors: Editor[] = [];
const elements: HTMLElement[] = [];

/**
 * A live editor with one `threadAnchor`-shaped span in its document DOM. The
 * span is appended directly because the component's whole bridge to ProseMirror
 * is a delegated listener on `editor.view.dom` plus a `[data-thread-id]`
 * `closest()` walk - the mark's own rendering is not what is under test.
 */
function makeEditorWithAnchor(): { editor: Editor; anchor: HTMLElement } {
  const element = document.createElement("div");
  document.body.appendChild(element);
  elements.push(element);
  const editor = new Editor({
    element,
    extensions: [StarterKit],
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
  editors.push(editor);
  const anchor = document.createElement("span");
  anchor.dataset.threadId = THREAD_ID;
  anchor.textContent = QUOTED_TEXT;
  editor.view.dom.appendChild(anchor);
  return { editor, anchor };
}

/**
 * The overlap case: a thread anchor sitting ON a link. `ThreadAnchor` sets
 * `excludes: ""`, so commenting on linked text produces exactly this, and the
 * artifact link layer listens for `click` on the same editor root - so a tap
 * here is a tap both surfaces can see.
 */
function makeEditorWithLinkedAnchor(): {
  editor: Editor;
  anchor: HTMLElement;
} {
  const { editor, anchor } = makeEditorWithAnchor();
  const link = document.createElement("a");
  link.href = "https://example.com/spec";
  link.dataset.linkHref = "https://example.com/spec";
  anchor.replaceWith(link);
  link.appendChild(anchor);
  return { editor, anchor };
}

function renderPopover(
  editor: Editor,
  onActivateThread: (threadId: string) => void,
) {
  return render(
    <ThreadAnchorHoverPopover
      epicId={EPIC_ID}
      hostClient={null}
      artifactType="spec"
      artifactId={ARTIFACT_ID}
      editor={editor}
      resolvedThreadIds={new Set<string>()}
      onActivateThread={onActivateThread}
    />,
  );
}

const HOVER_DELAY_MS = 300;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  threads.value = [threadFixture()];
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  editors.splice(0).forEach((editor) => editor.destroy());
  elements.splice(0).forEach((element) => element.remove());
  useCommentThreadsStore.setState({
    activeByEpicId: {},
    hoverByEpicId: {},
    flashByEpicId: {},
    draftByEpicId: {},
    artifactByEpicId: {},
  });
});

describe("<ThreadAnchorHoverPopover /> touch", () => {
  it("activates the thread on a tap, with no dwell to wait out", () => {
    const { editor, anchor } = makeEditorWithAnchor();
    const onActivateThread = vi.fn();
    renderPopover(editor, onActivateThread);

    fireEvent.pointerDown(anchor, { pointerType: "touch" });
    fireEvent.click(anchor);

    expect(onActivateThread).toHaveBeenCalledWith(THREAD_ID);
  });

  it("yields a tap on a commented LINK to the link", () => {
    // Both surfaces listen for `click` on the same editor root, so without an
    // explicit rule the tap runs both: comments open and the link routes, and
    // for an internal link the tile underneath changes - taking the very thread
    // the tap was meant to reveal with it. The link wins because it is the only
    // one of the two with no other route on a phone; the thread is still listed
    // in the comments panel.
    const { editor, anchor } = makeEditorWithLinkedAnchor();
    const onActivateThread = vi.fn();
    renderPopover(editor, onActivateThread);

    fireEvent.pointerDown(anchor, { pointerType: "touch" });
    fireEvent.click(anchor);

    expect(onActivateThread).not.toHaveBeenCalled();
  });

  it("offers no dwell preview to a touch pointer", () => {
    // A touch `pointerout` lands immediately after `pointerup`, so a pending
    // show would be cancelled before it ever fired - and there is no hover state
    // to reach the preview from either.
    const { editor, anchor } = makeEditorWithAnchor();
    renderPopover(editor, vi.fn());

    fireEvent.pointerOver(anchor, { pointerType: "touch" });
    // Block body, not a concise one: `advanceTimersByTime` returns the timer
    // instance, and returning it selects `act`'s thenable overload.
    act(() => {
      vi.advanceTimersByTime(HOVER_DELAY_MS * 2);
    });

    expect(screen.queryByRole("button", { name: "Open thread" })).toBeNull();
  });
});

describe("<ThreadAnchorHoverPopover /> mouse", () => {
  it("still opens the preview after the dwell", () => {
    const { editor, anchor } = makeEditorWithAnchor();
    renderPopover(editor, vi.fn());

    fireEvent.pointerOver(anchor, { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(HOVER_DELAY_MS);
    });

    expect(screen.getByRole("button", { name: "Open thread" })).toBeTruthy();
  });

  it("leaves a click on the anchor to the editor, so the caret still lands", () => {
    // The preview is the desktop route to a thread; activating on the click too
    // would open the panel every time the user placed a caret in a commented
    // sentence.
    const { editor, anchor } = makeEditorWithAnchor();
    const onActivateThread = vi.fn();
    renderPopover(editor, onActivateThread);

    fireEvent.pointerDown(anchor, { pointerType: "mouse" });
    fireEvent.click(anchor);

    expect(onActivateThread).not.toHaveBeenCalled();
  });
});
