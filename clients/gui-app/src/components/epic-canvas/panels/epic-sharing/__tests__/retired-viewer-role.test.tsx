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
  const onRoleChange = vi.fn();
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
        onRoleChange={onRoleChange}
        onRevokeRequest={() => undefined}
      />
    </TooltipProvider>,
  );
  return { view, onRoleChange };
}

describe("a collaborator stored on the retired viewer role", () => {
  it("is not listed as having access, and has no role control", () => {
    const { view, onRoleChange } = renderPeople([
      userEntry("user-1", "Ada Owner", "owner"),
      userEntry("user-2", "Priya Editor", "editor"),
      userEntry("user-3", "Vic Retired", "viewer"),
    ]);

    expect(view.directUsers.map((row) => row.userId)).toEqual([
      "user-1",
      "user-2",
    ]);
    const list = screen.getByTestId("epic-sharing-people-list");
    expect(within(list).queryByText("Vic Retired")).toBeNull();
    expect(within(list).queryByText(/viewer/i)).toBeNull();
    // The one owner is the last owner and the editor has no second role to
    // move to, so neither row offers a role menu a retired row could share.
    expect(within(list).queryAllByRole("combobox")).toEqual([]);
    expect(within(list).queryByTestId("collaborator-role-select")).toBeNull();
    expect(onRoleChange).not.toHaveBeenCalled();
  });

  it("is dropped from a shared team too, so no team is listed on it", () => {
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

    expect(view.teams).toEqual([]);
    expect(view.ownerTeam).toBeNull();
    expect(view.flatRows).toEqual([]);
  });
});
