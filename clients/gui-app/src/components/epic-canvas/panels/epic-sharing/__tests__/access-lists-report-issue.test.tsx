import "../../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { PeopleWithAccess, TeamsAccess } from "../access-lists";

function renderPeopleError(): void {
  render(
    <TooltipProvider>
      <PeopleWithAccess
        loadState="error"
        collaborators={[]}
        accessPermission="owner"
        directOwnerCount={1}
        batchUpdateRolesPending={false}
        pendingRoleUserId={null}
        pendingRevokeUserId={null}
        onRoleChange={() => undefined}
        onRevokeRequest={() => undefined}
      />
    </TooltipProvider>,
  );
}

function renderTeamsError(): void {
  render(
    <TooltipProvider>
      <TeamsAccess
        loadState="error"
        rows={[]}
        accessPermission="owner"
        pending={{
          anyMutation: false,
          shareTeamId: null,
          roleTeamId: null,
          revokeTeamId: null,
        }}
        teamRolesById={{}}
        onPendingTeamRoleChange={() => undefined}
        onShareTeam={() => undefined}
        onRoleChange={() => undefined}
        onRevokeRequest={() => undefined}
      />
    </TooltipProvider>,
  );
}

describe("epic-sharing access lists report action", () => {
  afterEach(() => {
    cleanup();
    useDesktopDialogStore.setState({
      activeDialog: null,
      reportIssueAvailable: false,
      reportIssueContext: null,
    });
  });

  it("hides the report action on the collaborators error state when capability is unavailable", () => {
    renderPeopleError();

    screen.getByText("Couldn't load collaborators.");
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();
  });

  it("reports only fixed generic context for a collaborators load failure", () => {
    renderPeopleError();

    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));

    expect(useDesktopDialogStore.getState()).toMatchObject({
      activeDialog: "report-issue",
      reportIssueContext: {
        title: "Couldn't load collaborators",
        message: "Epic collaborators could not be loaded.",
        code: null,
        source: "Epic sharing",
      },
    });
  });

  it("hides the report action on the teams error state when capability is unavailable", () => {
    renderTeamsError();

    screen.getByText("Couldn't load teams.");
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();
  });

  it("reports only fixed generic context for a teams load failure", () => {
    renderTeamsError();

    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));

    expect(useDesktopDialogStore.getState()).toMatchObject({
      activeDialog: "report-issue",
      reportIssueContext: {
        title: "Couldn't load teams",
        message: "Epic teams could not be loaded.",
        code: null,
        source: "Epic sharing",
      },
    });
  });
});
