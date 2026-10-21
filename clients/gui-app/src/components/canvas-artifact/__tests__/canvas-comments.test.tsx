/**
 * `CanvasCommentIndex` registers the canvas as the place a thread's anchor is
 * revealed. The registration closes over the thread list and the frame
 * registry's view, so a deep link that lands before either exists must be
 * retried when each arrives - the generic registry test cannot see that
 * dependency. The frame registry and the comment editor registry are real; only
 * the thread data seam is faked.
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommentThreadWire } from "@traycer/protocol/host/epic/unary-schemas";
import { CanvasCommentIndex } from "@/components/canvas-artifact/canvas-comments";
import {
  CanvasFrameRegistry,
  type CanvasCommentView,
} from "@/components/canvas-artifact/canvas-frame-registry";
import {
  clearCommentEditorRegistryForTests,
  requestCommentThreadAnchorReveal,
} from "@/lib/comments/comment-editor-registry";
import { createAppQueryClient } from "@/lib/query-client";
import { useAnchorPositionsStore } from "@/stores/comments/anchor-positions-store";
import { useCommentThreadsStore } from "@/stores/comments/comment-threads-store";

const EPIC_ID = "epic-1";
const ARTIFACT_ID = "canvas-1";
const THREAD_ID = "thread-1";
const BOARD = "boards/a.html";

const mocks = vi.hoisted(() => ({
  threads: null as ReadonlyArray<CommentThreadWire> | null,
}));

vi.mock("@/hooks/comments/use-frame-comment-threads", () => ({
  useFrameCommentThreads: () => mocks.threads,
}));

const scope = {
  epicId: EPIC_ID,
  artifactId: ARTIFACT_ID,
  artifactTitle: "Canvas",
  hostId: "host-1",
  viewTabId: "tab-1",
};

const boardThread: CommentThreadWire = {
  threadId: THREAD_ID,
  resolved: false,
  createdAt: 1,
  comments: [],
  data: {
    createdByUserId: "user-1",
    anchorKind: "element",
    elementId: "hero",
    artboard: BOARD,
  },
};

function viewWith(revealBoard: (path: string) => boolean): CanvasCommentView {
  return {
    tool: "select",
    play: false,
    viewOnly: false,
    order: [BOARD],
    sourceForBoard: () => null,
    revealBoard,
    setTool: () => undefined,
    clearNodeSelection: () => undefined,
  };
}

let registry: CanvasFrameRegistry;

function tree() {
  return (
    <QueryClientProvider client={createAppQueryClient()}>
      <CanvasCommentIndex scope={scope} tileId="tile-1" registry={registry} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  registry = new CanvasFrameRegistry();
  mocks.threads = null;
  useCommentThreadsStore.setState({ activeByEpicId: {} });
  useAnchorPositionsStore.setState({ mapByKey: {} });
});

afterEach(() => {
  cleanup();
  clearCommentEditorRegistryForTests();
  useCommentThreadsStore.setState({ activeByEpicId: {} });
});

describe("<CanvasCommentIndex /> anchor reveal", () => {
  it("completes a deep link requested before the threads and the view existed, once", () => {
    useCommentThreadsStore.getState().setActiveThread(EPIC_ID, THREAD_ID);
    requestCommentThreadAnchorReveal(EPIC_ID, ARTIFACT_ID, THREAD_ID);
    const view = render(tree());

    // The thread list has not arrived: nothing to reveal yet.
    const notReady = vi.fn(() => false);
    act(() => registry.setView(viewWith(notReady)));
    expect(notReady).not.toHaveBeenCalled();

    // The thread arrives, and its board's view answers that it is not ready.
    mocks.threads = [boardThread];
    view.rerender(tree());
    expect(notReady).toHaveBeenCalledWith(BOARD);

    // A replacement view that is ready takes the reveal.
    const ready = vi.fn(() => true);
    act(() => registry.setView(viewWith(ready)));
    expect(ready).toHaveBeenCalledExactlyOnceWith(BOARD);

    // The request is spent: a later view must not pan the canvas again.
    const later = vi.fn(() => true);
    act(() => registry.setView(viewWith(later)));
    view.rerender(tree());
    expect(later).not.toHaveBeenCalled();
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("does not reveal for a thread the user has since moved off", () => {
    useCommentThreadsStore.getState().setActiveThread(EPIC_ID, THREAD_ID);
    requestCommentThreadAnchorReveal(EPIC_ID, ARTIFACT_ID, THREAD_ID);
    mocks.threads = [boardThread];
    render(tree());
    useCommentThreadsStore.getState().setActiveThread(EPIC_ID, null);

    const ready = vi.fn(() => true);
    act(() => registry.setView(viewWith(ready)));

    expect(ready).not.toHaveBeenCalled();
  });
});
