/**
 * The sidebar now lists threads for every artifact kind that has a comment
 * room - Markdown, html and canvas alike, since pins on a frame hand off to
 * the same shared sidebar rather than their own list. Only a kind with no
 * comment room at all (a plain file) renders nothing, and in particular must
 * never mount `<CommentSidebar>` - which is what would start the room's
 * poll/subscribe work for a body the sidebar does not list.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import { CommentSidebarPanel } from "@/components/comments/comment-sidebar-panel";
import {
  requestCommentThreadAnchorReveal,
  revealCommentThreadAnchor,
} from "@/lib/comments/comment-editor-registry";

const mocks = vi.hoisted(() => ({
  artifact: null as { readonly kind: EpicArtifactKind } | null,
  commentSidebarMounts: 0,
  onActivateThread: null as ((threadId: string) => void) | null,
  setFlashThread: vi.fn<(epicId: string, threadId: string) => void>(),
}));

vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => null,
}));

vi.mock("@/hooks/comments/use-lane-comment-threads", () => ({
  useEpicLaneCommentThreads: () => null,
  useEpicLaneCommentThreadsDroppedAt: () => null,
}));

vi.mock("@/lib/comments/comment-editor-registry", () => ({
  revealCommentThreadAnchor: vi.fn(),
  requestCommentThreadAnchorReveal: vi.fn(),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicArtifact: () => mocks.artifact,
  useEpicCommentRoomAvailability: () => ({ kind: "available" as const }),
}));

vi.mock("@/stores/auth/auth-store", () => ({
  useAuthStore: (
    selector: (state: { profile: { userId: string } | null }) => unknown,
  ) => selector({ profile: { userId: "user-1" } }),
}));

vi.mock("@/stores/comments/anchor-positions-store", () => ({
  useArtifactAnchorPositions: () => ({}),
}));

vi.mock("@/stores/comments/comment-threads-store", () => ({
  useCommentThreadsStore: (
    selector: (state: {
      setFlashThread: (epicId: string, threadId: string) => void;
    }) => unknown,
  ) => selector({ setFlashThread: mocks.setFlashThread }),
}));

vi.mock("@/components/comments/comment-sidebar", () => ({
  CommentSidebar: (props: {
    readonly onActivateThread: (threadId: string) => void;
  }) => {
    mocks.commentSidebarMounts += 1;
    mocks.onActivateThread = props.onActivateThread;
    return <div data-testid="comment-sidebar" />;
  },
}));

afterEach(() => {
  cleanup();
  mocks.artifact = null;
  mocks.commentSidebarMounts = 0;
  mocks.onActivateThread = null;
  mocks.setFlashThread.mockClear();
  vi.mocked(revealCommentThreadAnchor).mockClear();
  vi.mocked(requestCommentThreadAnchorReveal).mockClear();
});

describe("<CommentSidebarPanel />", () => {
  it.each(["spec", "ticket", "story", "review", "html", "canvas"] as const)(
    "renders CommentSidebar for a %s artifact",
    (kind) => {
      mocks.artifact = { kind };

      render(<CommentSidebarPanel epicId="epic-1" activeArtifactId="a1" />);

      expect(screen.getByTestId("comment-sidebar")).toBeTruthy();
      expect(mocks.commentSidebarMounts).toBe(1);
    },
  );

  it.each(["file"] as const)(
    "renders nothing and never mounts CommentSidebar for a %s artifact",
    (kind) => {
      mocks.artifact = { kind };

      const { container } = render(
        <CommentSidebarPanel epicId="epic-1" activeArtifactId="a1" />,
      );

      expect(container.childNodes).toHaveLength(0);
      expect(screen.queryByTestId("comment-sidebar")).toBeNull();
      expect(mocks.commentSidebarMounts).toBe(0);
    },
  );

  it("renders nothing while the artifact has not resolved yet", () => {
    mocks.artifact = null;

    render(<CommentSidebarPanel epicId="epic-1" activeArtifactId="a1" />);

    expect(screen.queryByTestId("comment-sidebar")).toBeNull();
    expect(mocks.commentSidebarMounts).toBe(0);
  });

  it("flashes the thread and reveals it through the frame's pending-reveal path for a canvas artifact", () => {
    mocks.artifact = { kind: "canvas" };
    render(<CommentSidebarPanel epicId="epic-1" activeArtifactId="a1" />);

    mocks.onActivateThread?.("thread-1");

    expect(mocks.setFlashThread).toHaveBeenCalledWith("epic-1", "thread-1");
    expect(requestCommentThreadAnchorReveal).toHaveBeenCalledWith(
      "epic-1",
      "a1",
      "thread-1",
    );
    expect(revealCommentThreadAnchor).not.toHaveBeenCalled();
  });

  it("flashes the thread and reveals it through the Markdown editor registry for a spec artifact", () => {
    mocks.artifact = { kind: "spec" };
    render(<CommentSidebarPanel epicId="epic-1" activeArtifactId="a1" />);

    mocks.onActivateThread?.("thread-1");

    expect(mocks.setFlashThread).toHaveBeenCalledWith("epic-1", "thread-1");
    expect(revealCommentThreadAnchor).toHaveBeenCalledWith(
      "epic-1",
      "a1",
      "thread-1",
    );
    expect(requestCommentThreadAnchorReveal).not.toHaveBeenCalled();
  });
});
