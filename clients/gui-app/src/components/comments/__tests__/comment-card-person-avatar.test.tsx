import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommentThreadWire } from "@traycer/protocol/host/epic/unary-schemas";
import { stubImmediateImage } from "@/__tests__/immediate-avatar-image";
import { CommentThreadCard } from "@/components/comments/comment-thread-card";
import { usePersonIdentity } from "@/hooks/identity/use-person-identity";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  collaboratorEntry,
  collaboratorsResponse,
  createPersonAvatarHarness,
  EPIC_ID,
  VIEWER_USER_ID,
  type PersonAvatarHarness,
} from "./person-avatar-test-support";

/**
 * A comment author is `{ userId, fallbackHandle }`; the picture and display
 * name come from the task's collaborators list the sharing panel already
 * loaded, read through the real resolver and never fetched by the card.
 */

const AUTHOR_USER_ID = "user-2";
const AUTHOR_PICTURE = "https://example.com/grace.png";

let harness: PersonAvatarHarness;

function threadBy(userId: string): CommentThreadWire {
  return {
    threadId: "thread-1",
    resolved: false,
    createdAt: 1,
    comments: [
      {
        commentId: "comment-1",
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "a comment" }],
            },
          ],
        },
        createdAt: 1,
        updatedAt: null,
        author: { userId, fallbackHandle: "grace-handle" },
      },
    ],
    data: { createdByUserId: userId, quotedText: "quoted" },
  };
}

function card(thread: CommentThreadWire) {
  return harness.wrap(
    <CommentThreadCard
      epicId={EPIC_ID}
      hostClient={harness.hostClient}
      artifactType="spec"
      artifactId="spec-1"
      thread={thread}
      currentUserId={VIEWER_USER_ID}
      canModerate={false}
      isExpanded
      hasAnchor
      onExpandedChange={() => undefined}
      onActivateAnchor={() => undefined}
    />,
  );
}

async function renderCard(thread: CommentThreadWire) {
  const view = render(card(thread));
  await screen.findByRole("button", { name: /^Reply/ });
  return view;
}

function avatar(): HTMLElement {
  return screen.getByTestId("person-avatar");
}

function pictureSrc(): string | null {
  return avatar().querySelector("img")?.getAttribute("src") ?? null;
}

const GRACE = collaboratorEntry(AUTHOR_USER_ID, {
  displayName: "Grace Hopper",
  avatarUrl: AUTHOR_PICTURE,
});

beforeEach(() => {
  harness = createPersonAvatarHarness();
  stubImmediateImage();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  harness.dispose();
});

describe("<CommentThreadCard /> author picture", () => {
  it("draws the author's picture and display name from the collaborators list over the fallback handle", async () => {
    harness.publishCollaborators(collaboratorsResponse([GRACE]));

    await renderCard(threadBy(AUTHOR_USER_ID));

    await waitFor(() => {
      expect(pictureSrc()).toBe(AUTHOR_PICTURE);
    });
    expect(screen.getByText("Grace Hopper")).toBeTruthy();
    expect(screen.queryByText("grace-handle")).toBeNull();
  });

  it("falls back to initials from the display name when the list holds no picture for the author", async () => {
    harness.publishCollaborators(
      collaboratorsResponse([
        collaboratorEntry(AUTHOR_USER_ID, {
          displayName: "Grace Hopper",
          avatarUrl: "",
        }),
      ]),
    );

    await renderCard(threadBy(AUTHOR_USER_ID));

    expect(avatar().textContent).toBe("GH");
    expect(pictureSrc()).toBeNull();
    expect(screen.getByText("Grace Hopper")).toBeTruthy();
  });

  it("shows initials from the fallback handle until the list loads, then the picture", async () => {
    await renderCard(threadBy(AUTHOR_USER_ID));

    expect(avatar().textContent).toBe("GR");
    expect(pictureSrc()).toBeNull();
    expect(screen.getByText("grace-handle")).toBeTruthy();

    act(() => {
      harness.publishCollaborators(collaboratorsResponse([GRACE]));
    });

    await waitFor(() => {
      expect(pictureSrc()).toBe(AUTHOR_PICTURE);
    });
    expect(screen.getByText("Grace Hopper")).toBeTruthy();
  });

  it("withholds a cached list under an unverified session", async () => {
    harness.publishCollaborators(collaboratorsResponse([GRACE]));
    act(() => {
      useAuthStore.getState().setUnverifiedSession(
        {
          userId: VIEWER_USER_ID,
          userName: "Viewer",
          email: "v@example.com",
        },
        { userId: VIEWER_USER_ID, username: "Viewer" },
      );
    });

    await renderCard(threadBy(AUTHOR_USER_ID));

    expect(avatar().textContent).toBe("GR");
    expect(pictureSrc()).toBeNull();
    expect(screen.getByText("grace-handle")).toBeTruthy();
  });

  it("draws the viewer's own picture from their profile with no list loaded", async () => {
    act(() => {
      useAuthStore.getState().setSignedIn(
        {
          userId: VIEWER_USER_ID,
          userName: "Viewer",
          email: "v@example.com",
          avatarUrl: "https://example.com/viewer.png",
        },
        { userId: VIEWER_USER_ID, username: "Viewer" },
        [],
      );
    });

    await renderCard(threadBy(VIEWER_USER_ID));

    await waitFor(() => {
      expect(pictureSrc()).toBe("https://example.com/viewer.png");
    });
    expect(screen.getByText("Viewer")).toBeTruthy();
  });
});

describe("usePersonIdentity", () => {
  it("reads the cached list as it lands and asks the host for nothing", async () => {
    const { result } = renderHook(() => usePersonIdentity(AUTHOR_USER_ID), {
      wrapper: (props) => harness.wrap(props.children),
    });

    expect(result.current).toBeNull();
    expect(harness.queryClient.isFetching()).toBe(0);

    act(() => {
      harness.publishCollaborators(collaboratorsResponse([GRACE]));
    });

    await waitFor(() => {
      expect(result.current).toEqual({
        userId: AUTHOR_USER_ID,
        displayName: "Grace Hopper",
        avatarUrl: AUTHOR_PICTURE,
      });
    });
    expect(harness.queryClient.isFetching()).toBe(0);
    expect(harness.collaboratorRequests()).toBe(0);
  });
});
