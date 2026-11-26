import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  CommentThreadWire,
  ListEpicCollaboratorsResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import { stubImmediateImage } from "@/__tests__/immediate-avatar-image";
import { CommentThreadCard } from "@/components/comments/comment-thread-card";
import { usePersonIdentity } from "@/hooks/identity/use-person-identity";
import { useEpicCollaboratorsQuery } from "@/hooks/epics/use-epic-collaborators-query";
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

function renderCollaboratorsQuery() {
  return renderHook(
    () =>
      useEpicCollaboratorsQuery(EPIC_ID, {
        client: harness.hostClient,
        enabled: true,
        poll: false,
        staleTime: 30_000,
      }),
    { wrapper: (props) => harness.wrap(props.children) },
  );
}

function collaboratorError(code: "E_CLOUD_REQUEST_REFUSED" | "FORBIDDEN") {
  return new HostRpcError({
    code,
    requestId: "person-avatar-collaborators",
    method: "epic.listCollaborators",
    message: "Synthetic collaborators read failure",
    fatalDetails: null,
  });
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

  it("keeps a same-key person through a transient read failure and hides it after access is refused", async () => {
    harness.publishCollaborators(collaboratorsResponse([GRACE]));
    const query = renderCollaboratorsQuery();
    await waitFor(() => {
      expect(query.result.current.data?.directUsers[0]?.userId).toBe(
        AUTHOR_USER_ID,
      );
    });
    await renderCard(threadBy(AUTHOR_USER_ID));
    expect(screen.getByText("Grace Hopper")).not.toBeNull();
    expect(pictureSrc()).toBe(AUTHOR_PICTURE);

    harness.setCollaboratorFailure(
      collaboratorError("E_CLOUD_REQUEST_REFUSED"),
    );
    await act(async () => {
      await query.result.current.query.refetch();
    });
    await waitFor(() => {
      expect(query.result.current.isError).toBe(true);
    });
    expect(query.result.current.data?.directUsers[0]?.userId).toBe(
      AUTHOR_USER_ID,
    );
    expect(screen.getByText("Grace Hopper")).not.toBeNull();
    expect(pictureSrc()).toBe(AUTHOR_PICTURE);

    harness.setCollaboratorFailure(collaboratorError("FORBIDDEN"));
    await act(async () => {
      await query.result.current.query.refetch();
    });
    await waitFor(() => {
      expect(query.result.current.data).toBeUndefined();
    });
    expect(screen.queryByText("Grace Hopper")).toBeNull();
    expect(screen.getByText("grace-handle")).not.toBeNull();
    expect(pictureSrc()).toBeNull();
  });

  it("withholds account A's cached person while account B's answer is pending", async () => {
    harness.publishCollaborators(collaboratorsResponse([GRACE]));
    const query = renderCollaboratorsQuery();
    await waitFor(() => {
      expect(query.result.current.data?.directUsers[0]?.userId).toBe(
        AUTHOR_USER_ID,
      );
    });
    await renderCard(threadBy(AUTHOR_USER_ID));
    expect(screen.getByText("Grace Hopper")).not.toBeNull();

    let resolveAccountB: (
      response: ListEpicCollaboratorsResponse,
    ) => void = () => undefined;
    const accountBAnswer = new Promise<ListEpicCollaboratorsResponse>(
      (resolve) => {
        resolveAccountB = resolve;
      },
    );
    const previousRequests = harness.collaboratorRequests();
    harness.setCollaboratorAnswer(accountBAnswer);
    act(() => {
      harness.setViewer("user-3");
    });

    expect(screen.queryByText("Grace Hopper")).toBeNull();
    expect(screen.getByText("grace-handle")).not.toBeNull();
    expect(pictureSrc()).toBeNull();
    await waitFor(() => {
      expect(harness.collaboratorRequests()).toBe(previousRequests + 1);
    });
    act(() => {
      resolveAccountB(
        collaboratorsResponse([
          collaboratorEntry(AUTHOR_USER_ID, {
            displayName: "Grace for account B",
            avatarUrl: "https://example.com/grace-b.png",
          }),
        ]),
      );
    });
    await waitFor(() => {
      expect(screen.getByText("Grace for account B")).not.toBeNull();
    });
    expect(pictureSrc()).toBe("https://example.com/grace-b.png");
  });
});
