import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentInvitation } from "@traycer/protocol/host/environment/contracts";
import { InviteAcceptDialog } from "@/components/settings/members/invite-accept-dialog";
import { TeamRows } from "@/components/settings/environment/team-rows";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { negotiateMethods } from "./mcp-skills-test-support";
import {
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "./team-configuration-test-support";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));
vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostClient: () => requireTeamHostClient(),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
});

const V10 = { major: 1, minor: 0 } as const;

const INVITATION: EnvironmentInvitation = {
  environmentId: "env-beta",
  teamName: "Beta",
  role: "viewer",
  paidPlan: true,
};

const NO_ENVIRONMENTS = { environments: [] };

function renderRows(onReview: (invitation: EnvironmentInvitation) => void) {
  return (harnessWrapper: TeamPageHarness["Wrapper"]) =>
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup value="personal">
            <TeamRows
              pick={PERSONAL_PICK}
              onPick={() => undefined}
              onReview={onReview}
            />
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>,
      { wrapper: harnessWrapper },
    );
}

describe("the invited rows of the Environment dropdown", () => {
  it("lists an invited team as 'invited' with Review, and hands the invitation to Review", async () => {
    negotiateMethods({ "environment.invitations.list": V10 });
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.list": () => NO_ENVIRONMENTS,
      "environment.invitations.list": () => ({ invitations: [INVITATION] }),
    });
    const onReview = vi.fn();
    renderRows(onReview)(harness.Wrapper);

    const row = await screen.findByTestId("environment-invitation-env-beta");
    expect(row.textContent).toContain("Beta");
    expect(row.textContent).toContain("invited");
    await userEvent.click(
      screen.getByTestId("environment-invitation-review-env-beta"),
    );
    expect(onReview).toHaveBeenCalledExactlyOnceWith(INVITATION);
  });

  it("neither asks for invitations nor draws a row on a host that does not serve them", async () => {
    negotiateMethods({});
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.list": () => NO_ENVIRONMENTS,
      "environment.invitations.list": () => ({ invitations: [INVITATION] }),
    });
    renderRows(vi.fn())(harness.Wrapper);

    await waitFor(() => {
      expect(harness.paramsOf("environment.list")).toHaveLength(1);
    });
    expect(screen.queryByTestId("environment-invitation-env-beta")).toBeNull();
    expect(harness.paramsOf("environment.invitations.list")).toHaveLength(0);
  });
});

describe("InviteAcceptDialog", () => {
  function renderDialog(
    outcome: "accepted" | "not_found",
    onAccepted: (environmentId: string) => void,
  ) {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.invitations.accept": () => ({ outcome }),
    });
    render(
      <InviteAcceptDialog
        invitation={INVITATION}
        onClose={() => undefined}
        onAccepted={onAccepted}
      />,
      { wrapper: harness.Wrapper },
    );
    return harness;
  }

  it("shows the grant and accepts only when Accept is pressed, then reports the team to pick", async () => {
    const onAccepted = vi.fn();
    const harness = renderDialog("accepted", onAccepted);

    expect(
      screen.getByRole("heading", { name: "You're invited to Beta" }),
    ).toBeTruthy();
    expect(screen.getByTestId("invite-accept-grant")).toBeTruthy();
    expect(harness.paramsOf("environment.invitations.accept")).toHaveLength(0);

    await userEvent.click(screen.getByTestId("invite-accept"));

    await waitFor(() => {
      expect(onAccepted).toHaveBeenCalledExactlyOnceWith("env-beta");
    });
    expect(harness.paramsOf("environment.invitations.accept")).toEqual([
      { environmentId: "env-beta" },
    ]);
  });

  it("says the invitation is no longer open, and picks nothing, when it was withdrawn", async () => {
    const onAccepted = vi.fn();
    renderDialog("not_found", onAccepted);

    await userEvent.click(screen.getByTestId("invite-accept"));

    expect((await screen.findByTestId("invite-accept-gone")).textContent).toBe(
      "This invitation is no longer open.",
    );
    expect(onAccepted).not.toHaveBeenCalled();
    expect(screen.queryByTestId("invite-accept")).toBeNull();
  });
});
