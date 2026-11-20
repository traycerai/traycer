import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { CollaboratorEntry } from "@traycer/protocol/host/epic/unary-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import { projectCollaborators } from "@/hooks/epics/use-epic-collaborators-query";
import { PeopleWithAccess } from "../access-lists";

afterEach(cleanup);

function userEntry(
  userId: string,
  displayName: string,
  role: CollaboratorEntry["role"],
): CollaboratorEntry {
  return {
    role,
    accessType: "direct",
    environmentId: null,
    grantedAt: 1,
    grantedBy: "user-1",
    user: {
      userId,
      profile: {
        avatarUrl: "",
        displayName,
        email: `${userId}@example.com`,
        handle: userId,
      },
    },
  };
}

function renderPeople(entries: ReadonlyArray<CollaboratorEntry>) {
  const view = projectCollaborators(entries);
  render(
    <TooltipProvider>
      <PeopleWithAccess
        loadState="ready"
        ownerTeam={null}
        collaborators={view.directUsers}
        accessPermission="owner"
        directOwnerCount={1}
        batchUpdateRolesPending={false}
        pendingRoleUserId={null}
        pendingRevokeUserId={null}
        onRoleChange={vi.fn()}
        onRevokeRequest={() => undefined}
      />
    </TooltipProvider>,
  );
  return { view };
}

describe("a collaborator stored on the viewer role", () => {
  it("is listed as an Editor, and has no role control beside the other editor", () => {
    const { view } = renderPeople([
      userEntry("user-1", "Ada Owner", "owner"),
      userEntry("user-2", "Priya Editor", "editor"),
      userEntry("user-3", "Vic Viewer", "viewer"),
    ]);

    expect(view.directUsers.map((row) => [row.userId, row.role])).toEqual([
      ["user-1", "owner"],
      ["user-2", "editor"],
      ["user-3", "editor"],
    ]);
    const list = screen.getByTestId("epic-sharing-people-list");
    expect(within(list).getByText("Vic Viewer")).toBeTruthy();
    // The one owner is the last owner and an editor has no second role to move
    // to, so no row offers a role menu.
    expect(within(list).queryByTestId("collaborator-role-select")).toBeNull();
  });

  it("is listed on a shared team as an Editor", () => {
    const view = projectCollaborators([
      {
        role: "viewer",
        accessType: "organization",
        environmentId: null,
        grantedAt: 1,
        grantedBy: "user-1",
        team: {
          teamId: "team-1",
          teamName: "traycerai",
          teamMembers: [
            {
              userId: "user-9",
              profile: null,
            },
          ],
        },
      },
    ]);

    expect(view.teams.map((team) => [team.teamId, team.role])).toEqual([
      ["team-1", "editor"],
    ]);
    expect(view.flatRows.map((row) => [row.userId, row.role])).toEqual([
      ["user-9", "editor"],
    ]);
  });

  it("is dropped, with every other row, only when its role is one nothing recognises", () => {
    const view = projectCollaborators([
      userEntry("user-1", "Ada Owner", "owner"),
      userEntry("user-4", "Newer Role", "supervisor" as "editor"),
    ]);

    expect(view.directUsers.map((row) => row.userId)).toEqual(["user-1"]);
  });
});
