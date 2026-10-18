/**
 * Comment anchors require a Markdown body (`CommentSidebarPanel`'s own
 * comment): html, canvas and file artifacts have no comment room, so the
 * panel must render nothing for them, and in particular must never mount
 * `<CommentSidebar>` - which is what would start the room's poll/subscribe
 * work for a body that does not exist.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import { CommentSidebarPanel } from "@/components/comments/comment-sidebar-panel";

const mocks = vi.hoisted(() => ({
  artifact: null as { readonly kind: EpicArtifactKind } | null,
  commentSidebarMounts: 0,
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
    selector: (state: { setFlashThread: () => void }) => unknown,
  ) => selector({ setFlashThread: vi.fn() }),
}));

vi.mock("@/components/comments/comment-sidebar", () => ({
  CommentSidebar: () => {
    mocks.commentSidebarMounts += 1;
    return <div data-testid="comment-sidebar" />;
  },
}));

afterEach(() => {
  cleanup();
  mocks.artifact = null;
  mocks.commentSidebarMounts = 0;
});

describe("<CommentSidebarPanel />", () => {
  it("renders CommentSidebar for a markdown artifact", () => {
    mocks.artifact = { kind: "spec" };

    render(<CommentSidebarPanel epicId="epic-1" activeArtifactId="a1" />);

    expect(screen.getByTestId("comment-sidebar")).toBeTruthy();
    expect(mocks.commentSidebarMounts).toBe(1);
  });

  it.each(["html", "canvas", "file"] as const)(
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
});
