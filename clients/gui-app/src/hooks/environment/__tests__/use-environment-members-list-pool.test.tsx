import "../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentListResponse,
  EnvironmentMembersResponseV12,
} from "@traycer/protocol/host/environment/contracts";
import { useEnvironmentMembersList } from "@/hooks/environment/use-environment-members-list";
import { useEnvironmentMembersWrites } from "@/hooks/environment/use-environment-members-writes";
import { MembersPage } from "@/components/settings/members/members-page";
import {
  mountTeamPage,
  poolSource,
  resetTeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useAuthStore } from "@/stores/auth/auth-store";

const ENVIRONMENT_ID = "env-a";
const VIEWER_ID = "u-admin";
type MemberRole =
  EnvironmentMembersResponseV12["members"][number]["effectiveRole"];
interface MemberFixture {
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly avatarUrl: null;
  readonly effectiveRole: MemberRole;
  readonly linkedPlan: false;
  readonly inviteState: null;
  readonly invitedAddress: null;
}

vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => VIEWER_ID,
}));

function member(userId: string, effectiveRole: MemberRole): MemberFixture {
  return {
    userId,
    displayName: userId,
    email: `${userId}@acme.test`,
    avatarUrl: null,
    effectiveRole,
    linkedPlan: false as const,
    inviteState: null,
    invitedAddress: null,
  };
}

function page(
  members: ReadonlyArray<MemberFixture>,
  nextCursor: string | null,
): EnvironmentMembersResponseV12 {
  return {
    members: [...members],
    nextCursor,
    legacyRoleNoticeSeenAt: null,
    legacyMembers: [],
  };
}

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  useSelectionAuthorityStore.getState().reset();
  useAuthStore.setState({ profile: null });
});

const TEAM_ENVIRONMENTS: EnvironmentListResponse = {
  environments: [
    {
      environmentId: ENVIRONMENT_ID,
      ownerKind: "organization",
      ownerId: "team-a",
      roomId: "room-a",
      label: "Acme",
      effectiveRole: "admin",
      kind: "team",
      hostCount: 1,
      providerHandle: "handle-a",
    },
  ],
};

describe("useEnvironmentMembersList", () => {
  it("refreshes its pages through each real members write", async () => {
    let revision = 0;
    const harness = mountTeamPage(poolSource("admin"), {
      "environment.list": () => TEAM_ENVIRONMENTS,
      "environment.members": () =>
        page(
          [
            member("u-admin", "admin"),
            ...(revision === 0
              ? []
              : [member(`u-revision-${String(revision)}`, "viewer")]),
          ],
          null,
        ),
      "environment.members.invite": () => {
        revision += 1;
        return { outcome: "sent", seatDelta: null };
      },
      "environment.members.setRole": () => {
        revision += 1;
        return { outcome: "changed" };
      },
      "environment.members.remove": () => {
        revision += 1;
        return { outcome: "revoked" };
      },
    });
    harness.queryClient.setDefaultOptions({
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
      mutations: { retry: false },
    });

    const { result } = renderHook(
      () => ({
        list: useEnvironmentMembersList(ENVIRONMENT_ID, true),
        writes: useEnvironmentMembersWrites(ENVIRONMENT_ID),
      }),
      { wrapper: harness.Wrapper },
    );

    await waitFor(() => {
      expect(result.current.list.members.map(({ userId }) => userId)).toEqual([
        "u-admin",
      ]);
    });

    const expectRefreshedPage = async (
      write: () => Promise<unknown>,
      nextRevision: number,
    ): Promise<void> => {
      const readsBefore = harness.paramsOf("environment.members").length;
      await act(async () => {
        await write();
      });
      await waitFor(() => {
        expect(
          result.current.list.members.some(
            ({ userId }) => userId === `u-revision-${String(nextRevision)}`,
          ),
        ).toBe(true);
      });
      expect(harness.paramsOf("environment.members").length).toBeGreaterThan(
        readsBefore,
      );
    };

    await expectRefreshedPage(
      () =>
        result.current.writes.invite({
          email: "new@acme.test",
          role: "editor",
        }),
      1,
    );
    expect(harness.paramsOf("environment.members.invite")).toHaveLength(1);

    await expectRefreshedPage(
      () => result.current.writes.setRole({ userId: "u-admin", role: "admin" }),
      2,
    );
    expect(harness.paramsOf("environment.members.setRole")).toHaveLength(1);

    await expectRefreshedPage(
      () => result.current.writes.remove({ userId: "u-admin" }),
      3,
    );
    expect(harness.paramsOf("environment.members.remove")).toHaveLength(1);
  });

  it("sends the real Members invite dialog with no active host", async () => {
    const inviteRequests: Array<{ email: string; role: MemberRole }> = [];
    const harness = mountTeamPage(poolSource("admin"), {
      "environment.list": () => TEAM_ENVIRONMENTS,
      "environment.members": () => page([member(VIEWER_ID, "admin")], null),
      "environment.members.seats": () => ({ seats: null }),
      "environment.members.invite": (request) => {
        inviteRequests.push({ email: request.email, role: request.role });
        return { outcome: "sent", seatDelta: null };
      },
    });
    useSelectionAuthorityStore.getState().reset();
    useAuthStore.setState({
      profile: {
        userId: VIEWER_ID,
        userName: "Ada",
        email: "u-admin@acme.test",
      },
    });

    render(<MembersPage environmentId={ENVIRONMENT_ID} />, {
      wrapper: harness.Wrapper,
    });

    await userEvent.click(
      await screen.findByRole("button", { name: "Invite" }),
    );
    await screen.findByTestId("members-invite-email");
    await waitFor(() => {
      expect(harness.paramsOf("environment.members.seats")).toHaveLength(1);
    });
    await userEvent.type(
      screen.getByTestId("members-invite-email"),
      "new@acme.test",
    );
    await userEvent.click(screen.getByTestId("members-invite-submit"));

    expect(await screen.findByText("Invitation sent")).toBeTruthy();
    expect(inviteRequests).toEqual([
      { email: "new@acme.test", role: "editor" },
    ]);
    expect(harness.paramsOf("environment.members.invite")).toHaveLength(1);
  });
});
