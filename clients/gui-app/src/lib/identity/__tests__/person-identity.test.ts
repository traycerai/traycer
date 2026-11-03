import { describe, expect, it } from "vitest";
import type { CollaboratorEntry } from "@traycer/protocol/host/epic/unary-schemas";
import { flattenCollaborators } from "@/hooks/epics/use-epic-collaborators-query";
import {
  UNRESOLVED_BOT_MEMBERS,
  type BotMemberResolver,
} from "@/lib/bots/bot-member-names";
import {
  resolvePersonIdentity,
  type PersonIdentitySources,
} from "@/lib/identity/person-identity";
import type { AuthProfile } from "@/stores/auth/auth-store";

function collaboratorRow(
  userId: string,
  profile: {
    readonly displayName: string;
    readonly avatarUrl: string;
  } | null,
): CollaboratorEntry {
  return {
    role: "editor",
    accessType: "direct",
    environmentId: null,
    grantedAt: 1,
    grantedBy: "owner",
    user: {
      userId,
      profile: profile === null ? null : { ...profile, email: "", handle: "" },
    },
    team: null,
  };
}

function sources(args: {
  readonly viewer: AuthProfile | null;
  readonly collaborators: ReadonlyArray<CollaboratorEntry>;
  readonly resolveMember: BotMemberResolver;
}): PersonIdentitySources {
  return {
    viewer: args.viewer,
    collaborators: flattenCollaborators(args.collaborators),
    resolveMember: args.resolveMember,
  };
}

const VIEWER: AuthProfile = {
  userId: "user-1",
  userName: "Viewer Name",
  email: "viewer@example.com",
  avatarUrl: "https://example.com/viewer.png",
};

const everyoneKnown: BotMemberResolver = (userId) => ({
  displayName: `Member ${userId}`,
  avatarUrl: `https://example.com/member-${userId}.png`,
});

describe("resolvePersonIdentity", () => {
  it("answers the viewer from their own profile before any list", () => {
    const resolved = resolvePersonIdentity(
      sources({
        viewer: VIEWER,
        collaborators: [
          collaboratorRow("user-1", {
            displayName: "Collaborator Name",
            avatarUrl: "https://example.com/collaborator.png",
          }),
        ],
        resolveMember: everyoneKnown,
      }),
      "user-1",
    );

    expect(resolved).toEqual({
      userId: "user-1",
      displayName: "Viewer Name",
      avatarUrl: "https://example.com/viewer.png",
    });
  });

  it("answers another person from the collaborators before the members", () => {
    const resolved = resolvePersonIdentity(
      sources({
        viewer: VIEWER,
        collaborators: [
          collaboratorRow("user-2", {
            displayName: "Collaborator Name",
            avatarUrl: "https://example.com/collaborator.png",
          }),
        ],
        resolveMember: everyoneKnown,
      }),
      "user-2",
    );

    expect(resolved).toEqual({
      userId: "user-2",
      displayName: "Collaborator Name",
      avatarUrl: "https://example.com/collaborator.png",
    });
  });

  it("answers from the members when no collaborator is that person", () => {
    const resolved = resolvePersonIdentity(
      sources({
        viewer: VIEWER,
        collaborators: [],
        resolveMember: everyoneKnown,
      }),
      "user-3",
    );

    expect(resolved).toEqual({
      userId: "user-3",
      displayName: "Member user-3",
      avatarUrl: "https://example.com/member-user-3.png",
    });
  });

  it("answers null for a person no source knows", () => {
    const resolved = resolvePersonIdentity(
      sources({
        viewer: null,
        collaborators: [],
        resolveMember: UNRESOLVED_BOT_MEMBERS,
      }),
      "user-9",
    );

    expect(resolved).toBeNull();
  });

  it("reads a collaborator whose wire picture is an empty string as having no picture", () => {
    const resolved = resolvePersonIdentity(
      sources({
        viewer: null,
        collaborators: [
          collaboratorRow("user-2", {
            displayName: "No Picture",
            avatarUrl: "",
          }),
        ],
        resolveMember: UNRESOLVED_BOT_MEMBERS,
      }),
      "user-2",
    );

    expect(resolved).toEqual({
      userId: "user-2",
      displayName: "No Picture",
      avatarUrl: null,
    });
  });

  it("leaves the name null for a member who has none, so the caller keeps its own", () => {
    const resolved = resolvePersonIdentity(
      sources({
        viewer: null,
        collaborators: [],
        resolveMember: () => ({
          displayName: null,
          avatarUrl: "https://example.com/nameless.png",
        }),
      }),
      "user-4",
    );

    expect(resolved).toEqual({
      userId: "user-4",
      displayName: null,
      avatarUrl: "https://example.com/nameless.png",
    });
  });

  it("keeps searching past a collaborator row that names only the id", () => {
    const resolved = resolvePersonIdentity(
      sources({
        viewer: null,
        collaborators: [collaboratorRow("user-2", null)],
        resolveMember: everyoneKnown,
      }),
      "user-2",
    );

    expect(resolved).toEqual({
      userId: "user-2",
      displayName: "Member user-2",
      avatarUrl: "https://example.com/member-user-2.png",
    });
  });
});
