/**
 * `CanvasCommentIndex` registers the canvas as the place a thread's anchor is
 * revealed. The registration closes over the thread list and the frame
 * registry's view, so a deep link that lands before either exists must be
 * retried when each arrives - the generic registry test cannot see that
 * dependency. The frame registry and the comment editor registry are real; only
 * the thread data seam is faked.
 */
import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realBridge, quotedSelection } from "./canvas-edit-test-support";
import type { CommentThreadWire } from "@traycer/protocol/host/epic/unary-schemas";
import {
  CanvasCommentAction,
  CanvasCommentIndex,
  CanvasCommentPointPins,
} from "@/components/canvas-artifact/canvas-comments";
import {
  CanvasFrameRegistry,
  type CanvasCommentView,
} from "@/components/canvas-artifact/canvas-frame-registry";
import {
  clearCommentEditorRegistryForTests,
  requestCommentThreadAnchorReveal,
} from "@/lib/comments/comment-editor-registry";
import { openFrameCommentDraft } from "@/lib/comments/open-frame-comment-draft";
import { createAppQueryClient } from "@/lib/query-client";
import { useAnchorPositionsStore } from "@/stores/comments/anchor-positions-store";
import { useCommentThreadsStore } from "@/stores/comments/comment-threads-store";

const EPIC_ID = "epic-1";
const ARTIFACT_ID = "canvas-1";
const THREAD_ID = "thread-1";
const BOARD = "boards/a.html";

vi.mock("@/hooks/comments/use-frame-comments-enabled", () => ({
  useFrameCommentsEnabled: () => true,
}));
vi.mock("@/lib/comments/open-frame-comment-draft", () => ({
  openFrameCommentDraft: vi.fn(() => Promise.resolve(null)),
}));

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
  artifactType: "canvas" as const,
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

function viewWith(
  revealBoard: (path: string) => boolean,
  commenting: boolean,
): CanvasCommentView {
  return {
    tool: "select",
    play: false,
    commenting,
    setCommenting: () => undefined,
    order: [BOARD],
    sourceForBoard: () => null,
    revealBoard,
    revealCanvasPoint: () => true,
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
    act(() => registry.setView(viewWith(notReady, false)));
    expect(notReady).not.toHaveBeenCalled();

    // The thread arrives, and its board's view answers that it is not ready.
    mocks.threads = [boardThread];
    view.rerender(tree());
    expect(notReady).toHaveBeenCalledWith(BOARD);

    // A replacement view that is ready takes the reveal.
    const ready = vi.fn(() => true);
    act(() => registry.setView(viewWith(ready, false)));
    expect(ready).toHaveBeenCalledExactlyOnceWith(BOARD);

    // The request is spent: a later view must not pan the canvas again.
    const later = vi.fn(() => true);
    act(() => registry.setView(viewWith(later, false)));
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
    act(() => registry.setView(viewWith(ready, false)));

    expect(ready).not.toHaveBeenCalled();
  });
});

describe("<CanvasCommentPointPins />", () => {
  const POINT_THREAD: CommentThreadWire = {
    ...boardThread,
    threadId: "point-1",
    data: {
      createdByUserId: "user-1",
      anchorKind: "canvas-point",
      page: "flow",
      x: 100,
      y: 50,
    },
  };
  const VIEWPORT = { x: 30, y: 10, zoom: 2 };

  function pinsTree(page: string) {
    return (
      <QueryClientProvider client={createAppQueryClient()}>
        <CanvasCommentPointPins
          scope={scope}
          page={page}
          viewport={VIEWPORT}
          registry={registry}
        />
      </QueryClientProvider>
    );
  }

  it("pins only this page's canvas-point threads, once comment mode is on, at their viewport position", () => {
    mocks.threads = [
      POINT_THREAD,
      {
        ...POINT_THREAD,
        threadId: "elsewhere",
        data: { ...POINT_THREAD.data, page: "other" },
      },
      boardThread,
    ];
    render(pinsTree("flow"));
    expect(document.querySelector("[data-comment-pin]")).toBeNull();

    act(() => registry.setView(viewWith(() => true, true)));

    const pins = document.querySelectorAll<HTMLElement>("[data-comment-pin]");
    expect(pins).toHaveLength(1);
    expect(pins[0].dataset.commentPin).toBe("point-1");
    expect(pins[0].style.left).toBe("230px");
    expect(pins[0].style.top).toBe("110px");

    fireEvent.click(screen.getByRole("button", { name: /^Open comment/ }));
    expect(useCommentThreadsStore.getState().activeByEpicId[EPIC_ID]).toBe(
      "point-1",
    );
  });
});

describe("<CanvasCommentAction />", () => {
  it("opens one draft for the element without entering comment mode", () => {
    const setCommenting = vi.fn<(enabled: boolean) => void>();
    act(() =>
      registry.setView({ ...viewWith(() => true, false), setCommenting }),
    );
    const frame = document.createElement("iframe");
    registry.update(BOARD, { bridge: realBridge(), frame });
    const selection = quotedSelection("Hello", 0, 5, { tid: "t" });

    render(
      <QueryClientProvider client={createAppQueryClient()}>
        <CanvasCommentAction
          scope={{ ...scope, artifactType: "html" }}
          tileId="tile-1"
          selection={{ ...selection, boardPath: BOARD }}
          registry={registry}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(openFrameCommentDraft).toHaveBeenCalledOnce();
    expect(vi.mocked(openFrameCommentDraft).mock.calls[0][0]).toMatchObject({
      epicId: EPIC_ID,
      artifactType: "html",
      frame,
    });
    expect(setCommenting).not.toHaveBeenCalled();
  });
});
