import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { ListEpicCollaboratorsResponse } from "@traycer/protocol/host/epic/unary-schemas";
import {
  EPIC_COLLABORATORS_CLOSED_STALE_TIME_MS,
  EPIC_COLLABORATORS_OPEN_REFRESH_MS,
  useEpicCollaboratorsQuery,
} from "@/hooks/epics/use-epic-collaborators-query";

const guiAppSrc = path.resolve(import.meta.dirname, "../..");

interface CapturedHostQuery {
  readonly client: unknown;
  readonly method: string;
  readonly params: { readonly epicId: string };
  readonly options: {
    readonly poll: boolean | undefined;
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

  it("opts the Sharing panel into table-owned fixed polling while open", () => {
    renderHook(() =>
      useEpicCollaboratorsQuery("epic-open", {
        poll: true,
        staleTime: EPIC_COLLABORATORS_OPEN_REFRESH_MS,
      }),
    );

    expect(capturedQuery.current?.method).toBe("epic.listCollaborators");
    expect(capturedQuery.current?.params).toEqual({ epicId: "epic-open" });
    expect(capturedQuery.current?.options).toMatchObject({
      poll: true,
      staleTime: EPIC_COLLABORATORS_OPEN_REFRESH_MS,
    });
  });

  it("keeps the closed-panel query relaxed and non-polling by default", () => {
    renderHook(() => useEpicCollaboratorsQuery("epic-closed", null));

    expect(capturedQuery.current?.options).toMatchObject({
      poll: false,
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
        poll: true,
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
        poll: true,
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

describe("epic.listCollaborators fixed-path poll inventory", () => {
  it("keeps Sharing opt-in and the two cache readers opt-out", () => {
    const sharing = readFileSync(
      path.join(
        guiAppSrc,
        "components/epic-canvas/panels/epic-sharing/use-controller.ts",
      ),
      "utf8",
    );
    expect(sharing).toMatch(/useEpicCollaboratorsQuery\([\s\S]*?poll:\s*true/);

    const mention = readFileSync(
      path.join(guiAppSrc, "hooks/comments/use-mention-collaborators.ts"),
      "utf8",
    );
    expect(mention).toMatch(/useEpicCollaboratorsQuery\([\s\S]*?poll:\s*false/);

    const chatTile = readFileSync(
      path.join(guiAppSrc, "components/epic-canvas/renderers/chat-tile.tsx"),
      "utf8",
    );
    expect(chatTile).toMatch(
      /method:\s*"epic\.listCollaborators"[\s\S]*?poll:\s*false/,
    );

    const sourcePaths = sourceFiles(guiAppSrc);
    const listCollaboratorsCallSites = sourcePaths.filter((relativePath) => {
      const source = readFileSync(path.join(guiAppSrc, relativePath), "utf8");
      return (
        /method:\s*"epic\.listCollaborators"/.test(source) ||
        /useEpicCollaboratorsQuery\(/.test(source)
      );
    });
    // Mutation activation is not a Query observer and is out of inventory.
    expect(listCollaboratorsCallSites).toEqual(
      expect.arrayContaining([
        "components/epic-canvas/panels/epic-sharing/use-controller.ts",
        "components/epic-canvas/renderers/chat-tile.tsx",
        "hooks/comments/use-mention-collaborators.ts",
        "hooks/epics/use-epic-collaborators-query.ts",
      ]),
    );
  });
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : sourceFiles(absolutePath);
    }
    if (!/\.tsx?$/.test(entry.name)) return [];
    return [path.relative(guiAppSrc, absolutePath)];
  });
}
