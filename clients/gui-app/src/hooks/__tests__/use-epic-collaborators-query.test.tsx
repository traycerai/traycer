import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ListEpicCollaboratorsResponse } from "@traycer/protocol/host/epic/unary-schemas";
import {
  EPIC_COLLABORATORS_CLOSED_STALE_TIME_MS,
  EPIC_COLLABORATORS_OPEN_REFRESH_MS,
  useEpicCollaboratorsQuery,
} from "@/hooks/epics/use-epic-collaborators-query";

interface CapturedHostQuery {
  readonly client: unknown;
  readonly method: string;
  readonly params: { readonly epicId: string };
  readonly options: {
    readonly refetchInterval: number | false | undefined;
    readonly refetchIntervalInBackground: boolean | undefined;
    readonly staleTime: number | undefined;
  } | null;
}

interface MockQueryResult {
  readonly data: ListEpicCollaboratorsResponse | undefined;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly isError: boolean;
  readonly error: Error | null;
}

const capturedQuery = vi.hoisted((): { current: CapturedHostQuery | null } => ({
  current: null,
}));
const mockQueryResult = vi.hoisted((): { current: MockQueryResult } => ({
  current: {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
  },
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useHostClient: () => ({ getActiveHostId: () => "host-remote" }),
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: CapturedHostQuery) => {
    capturedQuery.current = args;
    return mockQueryResult.current;
  },
}));

function makeCollaboratorResponse(
  email: string,
): ListEpicCollaboratorsResponse {
  return {
    collaborators: [
      {
        accessType: "direct",
        grantedAt: 1,
        grantedBy: "user-owner",
        role: "viewer",
        user: {
          userId: `user-${email}`,
          profile: {
            avatarUrl: "https://example.com/avatar.png",
            displayName: email,
            email,
            handle: email,
          },
        },
        team: null,
      },
    ],
    collaboratorsAvailable: true,
  };
}

function makeTeamCollaboratorResponse(): ListEpicCollaboratorsResponse {
  return {
    collaborators: [
      {
        accessType: "organization",
        grantedAt: 1,
        grantedBy: "user-owner",
        role: "editor",
        user: null,
        team: {
          teamId: "team-1",
          teamName: "Acme Team",
          teamMembers: [
            {
              userId: "user-org-member",
              profile: {
                avatarUrl: "",
                displayName: "Org Member",
                email: "member@example.com",
                handle: "member",
              },
            },
          ],
        },
      },
    ],
    collaboratorsAvailable: true,
  };
}

describe("useEpicCollaboratorsQuery", () => {
  beforeEach(() => {
    capturedQuery.current = null;
    mockQueryResult.current = {
      data: undefined,
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
    };
  });

  it("arms focus-gated periodic refetching while the Sharing panel is open", () => {
    renderHook(() =>
      useEpicCollaboratorsQuery("epic-open", {
        refetchInterval: EPIC_COLLABORATORS_OPEN_REFRESH_MS,
        staleTime: EPIC_COLLABORATORS_OPEN_REFRESH_MS,
      }),
    );

    expect(capturedQuery.current?.method).toBe("epic.listCollaborators");
    expect(capturedQuery.current?.params).toEqual({ epicId: "epic-open" });
    expect(capturedQuery.current?.options).toMatchObject({
      refetchInterval: EPIC_COLLABORATORS_OPEN_REFRESH_MS,
      refetchIntervalInBackground: false,
      staleTime: EPIC_COLLABORATORS_OPEN_REFRESH_MS,
    });
  });

  it("keeps the closed-panel query relaxed and non-polling by default", () => {
    renderHook(() => useEpicCollaboratorsQuery("epic-closed", null));

    expect(capturedQuery.current?.options).toMatchObject({
      refetchInterval: false,
      refetchIntervalInBackground: false,
      staleTime: EPIC_COLLABORATORS_CLOSED_STALE_TIME_MS,
    });
  });

  it("projects the latest collaborator list returned by the open-panel refetch", () => {
    mockQueryResult.current = {
      data: makeCollaboratorResponse("after@example.com"),
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
    };

    const hook = renderHook(() =>
      useEpicCollaboratorsQuery("epic-open", {
        refetchInterval: EPIC_COLLABORATORS_OPEN_REFRESH_MS,
        staleTime: EPIC_COLLABORATORS_OPEN_REFRESH_MS,
      }),
    );

    expect(hook.result.current.data?.directUsers[0]?.email).toBe(
      "after@example.com",
    );
    expect(hook.result.current.data?.directUsers[0]?.accessSource).toBe(
      "direct-user",
    );
    expect(hook.result.current.data?.directUsers[0]?.teamId).toBeNull();
    expect(hook.result.current.data?.directUsers[0]?.avatarUrl).toBe(
      "https://example.com/avatar.png",
    );
  });

  it("projects team-derived members with their access source", () => {
    mockQueryResult.current = {
      data: makeTeamCollaboratorResponse(),
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
    };

    const hook = renderHook(() =>
      useEpicCollaboratorsQuery("epic-open", {
        refetchInterval: EPIC_COLLABORATORS_OPEN_REFRESH_MS,
        staleTime: EPIC_COLLABORATORS_OPEN_REFRESH_MS,
      }),
    );

    expect(hook.result.current.data?.teams[0]).toMatchObject({
      teamId: "team-1",
      teamName: "Acme Team",
      role: "editor",
      members: [
        expect.objectContaining({
          accessSource: "team",
          displayName: "Org Member",
          email: "member@example.com",
          avatarUrl: null,
          teamId: "team-1",
          teamName: "Acme Team",
          role: "editor",
          userId: "user-org-member",
        }),
      ],
    });
  });
});
