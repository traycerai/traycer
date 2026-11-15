import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { CommentThreadWire } from "@traycer/protocol/host/epic/unary-schemas";
import type { EnvironmentListResponseV11 } from "@traycer/protocol/host/environment/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentThreadCard } from "@/components/comments/comment-thread-card";
import { stubImmediateImage } from "@/__tests__/immediate-avatar-image";
import { usePersonIdentity } from "@/hooks/identity/use-person-identity";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  collaboratorEntry,
  collaboratorsResponse,
  type PersonAvatarHarness,
} from "@/components/comments/__tests__/person-avatar-test-support";
import {
  createTeamPeopleHarness,
  environmentListWithTeam,
  FORMER_USER_ID,
  MEMBER_USER_ID,
  TEAM_ENVIRONMENT_ID,
  TEAM_ID,
  TEAM_ONLY_USER_ID,
  VIEWER_USER_ID,
  type TeamPeopleHarness,
} from "./team-host-people-test-support";

const OUTER_USER_ID = "outer-person";
const COLLABORATOR_USER_ID = "collaborator-a";

let harness: TeamPeopleHarness;

function threadBy(userId: string): CommentThreadWire {
  return {
    threadId: "identity-thread",
    resolved: false,
    createdAt: 1,
    comments: [
      {
        commentId: "identity-comment",
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "identity comment" }],
            },
          ],
        },
        createdAt: 1,
        updatedAt: null,
        author: { userId, fallbackHandle: `${userId}-handle` },
      },
    ],
    data: { createdByUserId: userId, quotedText: "quoted" },
  };
}

function CommentAuthor(props: {
  readonly userId: string;
  readonly people: PersonAvatarHarness;
}) {
  return (
    <CommentThreadCard
      epicId="epic-1"
      hostClient={props.people.hostClient}
      artifactType="spec"
      artifactId="spec-1"
      thread={threadBy(props.userId)}
      currentUserId={VIEWER_USER_ID}
      canModerate={false}
      isExpanded
      hasAnchor
      onExpandedChange={() => undefined}
      onActivateAnchor={() => undefined}
    />
  );
}

function IdentityProbe(props: { readonly userId: string }) {
  const identity = usePersonIdentity(props.userId);
  return (
    <output
      data-testid={`identity-${props.userId}`}
      data-name={identity?.displayName ?? ""}
      data-avatar={identity?.avatarUrl ?? ""}
    >
      {identity?.displayName ?? `unknown:${props.userId}`}
    </output>
  );
}

function outerDirectory(userId: string) {
  if (userId === MEMBER_USER_ID) {
    return {
      displayName: "Outer Member",
      avatarUrl: "https://images.example.test/outer.png",
    };
  }
  if (userId === OUTER_USER_ID) {
    return { displayName: "Outer Only", avatarUrl: null };
  }
  if (userId === TEAM_ONLY_USER_ID) {
    return { displayName: "Outer Team Fallback", avatarUrl: null };
  }
  return null;
}

async function renderAuthor(
  userId: string,
  outer: BotMemberResolver,
): Promise<void> {
  render(
    harness.wrap(
      <CommentAuthor userId={userId} people={harness.people} />,
      outer,
    ),
  );
  await screen.findByRole("button", { name: /^Reply/ });
}

function wrapHarness(children: ReactNode): ReactNode {
  return harness.wrap(children, outerDirectory);
}

function identityName(userId: string): string | null {
  return screen.getByTestId(`identity-${userId}`).getAttribute("data-name");
}

beforeEach(async () => {
  stubImmediateImage();
  harness = await createTeamPeopleHarness({});
});

afterEach(() => {
  cleanup();
  harness.dispose();
  vi.restoreAllMocks();
});

describe("team host member identity in a rendered comment", () => {
  it("names a non-collaborator from the team's environment members and draws its picture", async () => {
    await renderAuthor(MEMBER_USER_ID, outerDirectory);

    expect(await screen.findByText("Team Member")).toBeTruthy();
    expect(
      screen
        .getByTestId("person-avatar")
        .querySelector("img")
        ?.getAttribute("src"),
    ).toBe("https://images.example.test/team-member.png");
    await waitFor(() => {
      expect(harness.memberRequests).toEqual([
        { environmentId: TEAM_ENVIRONMENT_ID, cursor: null },
      ]);
    });
    expect(harness.memberRequests[0]?.environmentId).not.toBe(TEAM_ID);
  });

  it("keeps the surface directory on a personal host and sends no team reads", async () => {
    harness.dispose();
    harness = await createTeamPeopleHarness({
      owner: { kind: "user", id: VIEWER_USER_ID },
    });

    render(wrapHarness(<IdentityProbe userId={OUTER_USER_ID} />));

    expect(await screen.findByText("Outer Only")).toBeTruthy();
    expect(harness.environmentListRequests).toBe(0);
    expect(harness.memberRequests).toEqual([]);
    expect(harness.personReads).toEqual([]);
  });

  it("prefers the team's name over the outer directory and still uses the outer directory for other ids", async () => {
    render(
      wrapHarness(
        <>
          <IdentityProbe userId={MEMBER_USER_ID} />
          <IdentityProbe userId={OUTER_USER_ID} />
        </>,
      ),
    );

    expect(await screen.findByText("Team Member")).toBeTruthy();
    expect(screen.getByText("Outer Only")).toBeTruthy();
    expect(identityName(MEMBER_USER_ID)).toBe("Team Member");
  });

  it("does not ask a host that did not advertise environment.members", async () => {
    harness.dispose();
    harness = await createTeamPeopleHarness({ methods: ["environment.list"] });

    render(wrapHarness(<IdentityProbe userId={MEMBER_USER_ID} />));

    expect(await screen.findByText("Outer Member")).toBeTruthy();
    expect(harness.environmentListRequests).toBe(0);
    expect(harness.memberRequests).toEqual([]);
    expect(harness.personReads).toEqual([]);
  });

  it("does not ask while the viewer has no cloud verdict", async () => {
    useAuthStore.getState().setUnverifiedSession(
      {
        userId: VIEWER_USER_ID,
        userName: "Viewer",
        email: "viewer@example.test",
      },
      { userId: VIEWER_USER_ID, username: "Viewer" },
    );

    render(wrapHarness(<IdentityProbe userId={MEMBER_USER_ID} />));

    expect(await screen.findByText("Outer Member")).toBeTruthy();
    expect(harness.environmentListRequests).toBe(0);
    expect(harness.memberRequests).toEqual([]);
    expect(harness.personReads).toEqual([]);
  });
});

describe("former members on a team host", () => {
  it("reads an id missed by the complete directory in the team's environment and shows the returned name and picture", async () => {
    render(wrapHarness(<IdentityProbe userId={FORMER_USER_ID} />));

    expect(await screen.findByText("Former Member")).toBeTruthy();
    expect(harness.personReads).toEqual([
      `https://authn.example.test/api/v3/environments/${TEAM_ENVIRONMENT_ID}/people/${FORMER_USER_ID}`,
    ]);
    expect(harness.memberRequests[0]?.environmentId).toBe(TEAM_ENVIRONMENT_ID);
  });

  it("uses a former member's handle when authn returns a null name", async () => {
    harness.setPersonAnswer(
      {
        userId: FORMER_USER_ID,
        name: null,
        handle: "former-handle",
        avatarUrl: null,
      },
      200,
    );

    render(wrapHarness(<IdentityProbe userId={FORMER_USER_ID} />));

    expect(await screen.findByText("former-handle")).toBeTruthy();
    expect(harness.personReads).toHaveLength(1);
  });

  it("asks once for a person and does not re-ask a 404", async () => {
    harness.setPersonAnswer(null, 404);

    const view = render(wrapHarness(<IdentityProbe userId={FORMER_USER_ID} />));

    expect(await screen.findByText(`unknown:${FORMER_USER_ID}`)).toBeTruthy();
    await waitFor(() => expect(harness.personReads).toHaveLength(1));
    view.rerender(wrapHarness(<IdentityProbe userId={FORMER_USER_ID} />));
    await act(async () => Promise.resolve());
    expect(harness.personReads).toHaveLength(1);
  });

  it("does not read before all member pages answer, for a current member, the viewer, or system", async () => {
    render(
      wrapHarness(
        <>
          <IdentityProbe userId={MEMBER_USER_ID} />
          <IdentityProbe userId={VIEWER_USER_ID} />
          <IdentityProbe userId="system" />
        </>,
      ),
    );

    expect(await screen.findByText("Team Member")).toBeTruthy();
    await waitFor(() => expect(harness.memberRequests).toHaveLength(1));
    expect(harness.personReads).toEqual([]);
    expect(identityName("system")).toBe("");
  });

  it("does not read a former person on a host with no team owner", async () => {
    harness.dispose();
    harness = await createTeamPeopleHarness({
      owner: { kind: "user", id: VIEWER_USER_ID },
    });

    render(wrapHarness(<IdentityProbe userId={FORMER_USER_ID} />));

    expect(await screen.findByText(`unknown:${FORMER_USER_ID}`)).toBeTruthy();
    expect(harness.personReads).toEqual([]);
  });
});

describe("team environment resolution", () => {
  it("uses env-9 for both directory and former-person reads when the team id is team-1", async () => {
    render(wrapHarness(<IdentityProbe userId={FORMER_USER_ID} />));

    expect(await screen.findByText("Former Member")).toBeTruthy();
    expect(harness.memberRequests).toEqual([
      { environmentId: "env-9", cursor: null },
    ]);
    expect(harness.personReads[0]).toContain("/environments/env-9/people/");
    expect(harness.personReads[0]).not.toContain("/environments/team-1/");
  });

  it("keeps task collaborators while the team environment list is pending and after it fails", async () => {
    let rejectList: ((error: Error) => void) | null = null;
    const list = new Promise<EnvironmentListResponseV11>((_resolve, reject) => {
      rejectList = reject;
    });
    harness.dispose();
    harness = await createTeamPeopleHarness({ environmentList: () => list });
    harness.people.publishCollaborators(
      collaboratorsResponse([
        collaboratorEntry(COLLABORATOR_USER_ID, {
          displayName: "Task Collaborator",
          avatarUrl: "https://images.example.test/collaborator.png",
        }),
      ]),
    );
    const view = render(
      wrapHarness(
        <>
          <IdentityProbe userId={COLLABORATOR_USER_ID} />
          <IdentityProbe userId={TEAM_ONLY_USER_ID} />
        </>,
      ),
    );

    expect(await screen.findByText("Task Collaborator")).toBeTruthy();
    expect(screen.getByText(`unknown:${TEAM_ONLY_USER_ID}`)).toBeTruthy();
    expect(harness.memberRequests).toEqual([]);
    expect(harness.personReads).toEqual([]);

    await act(async () => {
      rejectList?.(new Error("environment list unavailable"));
      await Promise.resolve();
    });
    await waitFor(() => expect(harness.environmentListRequests).toBe(1));
    view.rerender(
      wrapHarness(
        <>
          <IdentityProbe userId={COLLABORATOR_USER_ID} />
          <IdentityProbe userId={TEAM_ONLY_USER_ID} />
        </>,
      ),
    );
    expect(screen.getByText("Task Collaborator")).toBeTruthy();
    expect(screen.getByText(`unknown:${TEAM_ONLY_USER_ID}`)).toBeTruthy();
    expect(harness.memberRequests).toEqual([]);
    expect(harness.personReads).toEqual([]);
  });

  it("uses the surface directory when the environment list has no row for the team", async () => {
    harness.dispose();
    harness = await createTeamPeopleHarness({
      environmentList: () => ({ environments: [] }),
    });

    render(wrapHarness(<IdentityProbe userId={OUTER_USER_ID} />));

    expect(await screen.findByText("Outer Only")).toBeTruthy();
    expect(harness.memberRequests).toEqual([]);
    expect(harness.personReads).toEqual([]);
  });

  it("drops names and former-person reads after environment.list refetch fails", async () => {
    let failList = false;
    harness.dispose();
    harness = await createTeamPeopleHarness({
      environmentList: () => {
        if (failList)
          return Promise.reject(new Error("environment list unavailable"));
        return environmentListWithTeam();
      },
    });
    const view = render(wrapHarness(<IdentityProbe userId={MEMBER_USER_ID} />));

    expect(await screen.findByText("Team Member")).toBeTruthy();
    const listQuery = harness.queryClient
      .getQueryCache()
      .getAll()
      .find((query) =>
        JSON.stringify(query.queryKey).includes("environment.list"),
      );
    if (listQuery === undefined) {
      throw new Error("Expected the team environment list query to exist");
    }
    const memberReadCount = harness.memberRequests.length;
    failList = true;
    await act(async () => {
      await harness.queryClient.refetchQueries({
        queryKey: listQuery.queryKey,
        exact: true,
      });
    });
    await waitFor(() => {
      expect(
        harness.queryClient.getQueryCache().find({
          queryKey: listQuery.queryKey,
          exact: true,
        })?.state.status,
      ).toBe("error");
    });
    view.rerender(
      wrapHarness(
        <>
          <IdentityProbe userId={MEMBER_USER_ID} />
          <IdentityProbe userId={FORMER_USER_ID} />
        </>,
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(identityName(MEMBER_USER_ID)).toBe("");
    expect(harness.memberRequests).toHaveLength(memberReadCount);
    expect(harness.personReads).toEqual([]);
  });
});
