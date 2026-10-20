/**
 * The frame toolbar's comment list is the html/canvas stand-in for the
 * sidebar: it lists threads by document order, filters by Open / Resolved,
 * and opens a thread in place instead of bringing a sidebar forward. The
 * thread data and the card are the only seams faked; the ordering, the
 * stores and the activation hook are real.
 */
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommentThreadWire } from "@traycer/protocol/host/epic/unary-schemas";
import {
  FrameCommentsToolbar,
  FrameCommentThreadPopover,
} from "@/components/comments/frame-comments";
import type { OrderedFrameThread } from "@/components/comments/use-ordered-frame-threads";
import { FrameCommentSurfaceProvider } from "@/components/comments/frame-comment-surface";
import { registerCommentEditor } from "@/lib/comments/comment-editor-registry";
import { useAnchorPositionsStore } from "@/stores/comments/anchor-positions-store";
import { useCommentThreadsStore } from "@/stores/comments/comment-threads-store";
import { useLeftPanelStore } from "@/stores/epics/left-panel-store";
import { useMobileSwitcherStore } from "@/stores/epics/mobile-switcher-store";

const EPIC_ID = "epic-1";
const ARTIFACT_ID = "html-1";
const TAB_ID = "tab-1";

const mocks = vi.hoisted(() => ({
  threads: null as ReadonlyArray<CommentThreadWire> | null,
}));

vi.mock("@/hooks/comments/use-frame-comment-threads", () => ({
  useFrameCommentThreads: () => mocks.threads,
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => false,
  isMobileViewport: () => false,
}));

vi.mock(
  "@/components/comments/comment-thread-card",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/comments/comment-thread-card")
    >()),
    CommentThreadCard: (props: {
      readonly thread: CommentThreadWire;
      readonly framePresentation: { readonly number: number } | undefined;
    }) => (
      <div data-testid="thread-card">
        {props.thread.threadId} #{props.framePresentation?.number}
      </div>
    ),
  }),
);

function thread(
  threadId: string,
  overrides: Partial<CommentThreadWire> & {
    readonly anchorKind: "artifact" | "element";
  },
): CommentThreadWire {
  const { anchorKind, ...rest } = overrides;
  return {
    threadId,
    resolved: false,
    createdAt: 1,
    comments: [
      {
        commentId: `${threadId}-c1`,
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: `text of ${threadId}` }],
            },
          ],
        },
        createdAt: 1,
        updatedAt: null,
        author: { userId: "user-1", fallbackHandle: "someone" },
      },
    ],
    data: { createdByUserId: "user-1", anchorKind },
    ...rest,
  };
}

function toolbar() {
  return (
    <FrameCommentsToolbar
      epicId={EPIC_ID}
      artifactId={ARTIFACT_ID}
      artifactType="html"
      viewTabId={TAB_ID}
    />
  );
}

function renderToolbar(): void {
  render(
    <FrameCommentSurfaceProvider>{toolbar()}</FrameCommentSurfaceProvider>,
  );
}

function pinPopover(entry: OrderedFrameThread) {
  return (
    <FrameCommentThreadPopover
      epicId={EPIC_ID}
      artifactId={ARTIFACT_ID}
      artifactType="html"
      entry={entry}
    >
      <button type="button">pin</button>
    </FrameCommentThreadPopover>
  );
}

function resetStores(): void {
  useAnchorPositionsStore.setState({ mapByKey: {} });
  useCommentThreadsStore.setState({
    activeByEpicId: {},
    hoverByEpicId: {},
    flashByEpicId: {},
    draftByEpicId: {},
    artifactByEpicId: {},
  });
  useLeftPanelStore.setState({
    activePanelIdByTabId: {},
    mainCollapsedByTabId: {},
    commentsPanelRevealedByTabId: {},
  });
  useMobileSwitcherStore.setState({ openTabId: null });
}

beforeEach(() => {
  resetStores();
  // Document order, not creation order, decides the numbers: `below` is the
  // older thread but anchored lower on the page, and the whole-page thread has
  // no position so it sinks to the end.
  mocks.threads = [
    thread("below", { anchorKind: "element", createdAt: 1 }),
    thread("above-resolved", {
      anchorKind: "element",
      createdAt: 2,
      resolved: true,
    }),
    thread("whole-page", { anchorKind: "artifact", createdAt: 3 }),
  ];
  useAnchorPositionsStore.getState().setForArtifact(EPIC_ID, ARTIFACT_ID, {
    positions: new Map([
      ["below", 30],
      ["above-resolved", 10],
    ]),
  });
});

afterEach(() => {
  cleanup();
  resetStores();
  mocks.threads = null;
});

describe("<FrameCommentsToolbar />", () => {
  it("lists open comments first and keeps their numbers when switching to resolved", async () => {
    const user = userEvent.setup();
    renderToolbar();

    await user.click(screen.getByRole("button", { name: "Comments (2 open)" }));

    const openList = screen.getByRole("list");
    expect(
      within(openList)
        .getAllByRole("button")
        .map((summary) => summary.getAttribute("aria-label")),
    ).toEqual(["Open comment 2", "Open comment 3"]);
    expect(screen.queryByRole("tab", { name: "All" })).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Resolved" }));

    expect(
      within(screen.getByRole("list"))
        .getAllByRole("button")
        .map((summary) => summary.getAttribute("aria-label")),
    ).toEqual(["Open comment 1"]);
  });

  it("opens the chosen thread in place and reveals its anchor without touching the sidebar", async () => {
    const user = userEvent.setup();
    const reveal = vi.fn(() => true);
    const unregister = registerCommentEditor({
      epicId: EPIC_ID,
      artifactId: ARTIFACT_ID,
      tileId: "tile-1",
      isActive: true,
      reveal,
    });
    renderToolbar();

    await user.click(screen.getByRole("button", { name: "Comments (2 open)" }));
    await user.click(screen.getByRole("button", { name: "Open comment 3" }));
    unregister();

    expect(useCommentThreadsStore.getState().activeByEpicId[EPIC_ID]).toBe(
      "whole-page",
    );
    expect(reveal).toHaveBeenCalledWith("whole-page");
    // A whole-page thread has no pin, so the toolbar itself hosts it.
    expect(screen.getByTestId("thread-card").textContent).toBe("whole-page #3");
    expect(screen.queryByRole("list")).toBeNull();
    expect(
      useLeftPanelStore.getState().commentsPanelRevealedByTabId[TAB_ID],
    ).toBeUndefined();
    expect(useMobileSwitcherStore.getState().openTabId).toBeNull();
  });

  it("hosts an element thread in the toolbar when no pin of it is mounted", async () => {
    const user = userEvent.setup();
    renderToolbar();

    await user.click(screen.getByRole("button", { name: "Comments (2 open)" }));
    await user.click(screen.getByRole("button", { name: "Open comment 2" }));

    // The page knows the element, but nothing on screen is pinned to it
    // (off-screen, clipped or not measured), so the thread must not vanish.
    expect(useCommentThreadsStore.getState().activeByEpicId[EPIC_ID]).toBe(
      "below",
    );
    expect(screen.getByTestId("thread-card").textContent).toBe("below #2");
  });

  it("hands an active thread between its pin and the toolbar as the pin mounts and unmounts", async () => {
    const pinned = {
      thread: thread("below", { anchorKind: "element", createdAt: 1 }),
      number: 2,
      hasAnchor: true,
    };
    act(() => {
      useCommentThreadsStore.getState().setActiveThread(EPIC_ID, "below");
    });
    const view = (withPin: boolean) => (
      <FrameCommentSurfaceProvider>
        {toolbar()}
        {withPin ? pinPopover(pinned) : null}
      </FrameCommentSurfaceProvider>
    );
    const { rerender } = render(view(false));
    expect(await screen.findAllByTestId("thread-card")).toHaveLength(1);

    rerender(view(true));
    // Only the pin's popover shows the thread now.
    await waitFor(() => {
      expect(screen.getAllByTestId("thread-card")).toHaveLength(1);
    });
    expect(screen.getByRole("dialog", { name: "Comment 2" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Comment thread" })).toBeNull();

    rerender(view(false));
    expect(
      await screen.findByRole("dialog", { name: "Comment thread" }),
    ).toBeTruthy();
    expect(screen.getAllByTestId("thread-card")).toHaveLength(1);
    expect(useCommentThreadsStore.getState().activeByEpicId[EPIC_ID]).toBe(
      "below",
    );
  });
});

describe("<FrameCommentThreadPopover />", () => {
  const entry = {
    thread: thread("pinned", { anchorKind: "element" }),
    number: 4,
    hasAnchor: true,
  };

  function renderPopover(): void {
    render(
      <FrameCommentSurfaceProvider>
        {pinPopover(entry)}
      </FrameCommentSurfaceProvider>,
    );
  }

  it("shows the thread beside its pin only while that thread is active", async () => {
    renderPopover();
    expect(screen.queryByTestId("thread-card")).toBeNull();

    act(() => {
      useCommentThreadsStore.getState().setActiveThread(EPIC_ID, "other");
    });
    expect(screen.queryByTestId("thread-card")).toBeNull();

    act(() => {
      useCommentThreadsStore.getState().setActiveThread(EPIC_ID, "pinned");
    });
    expect((await screen.findByTestId("thread-card")).textContent).toBe(
      "pinned #4",
    );
    expect(screen.getByRole("dialog", { name: "Comment 4" })).toBeTruthy();
  });

  it("clears the active thread when dismissed", async () => {
    const user = userEvent.setup();
    renderPopover();
    act(() => {
      useCommentThreadsStore.getState().setActiveThread(EPIC_ID, "pinned");
    });
    await screen.findByTestId("thread-card");

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(
        useCommentThreadsStore.getState().activeByEpicId[EPIC_ID],
      ).toBeNull();
    });
    expect(screen.queryByTestId("thread-card")).toBeNull();
  });
});
