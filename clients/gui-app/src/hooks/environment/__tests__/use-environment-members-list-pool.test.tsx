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
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { settleProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type { EnvironmentMembersResponseV12 } from "@traycer/protocol/host/environment/contracts";
import { useEnvironmentMembersList } from "@/hooks/environment/use-environment-members-list";
import { useEnvironmentMembersWrites } from "@/hooks/environment/use-environment-members-writes";
import { MembersPage } from "@/components/settings/members/members-page";
import {
  hostIdsOf,
  mountTeamPageOnPoolBuild,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
  teamHostBoundary,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { queryKeys } from "@/lib/query-keys";
import type { HostRpcRegistry } from "@/lib/host";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useAuthStore } from "@/stores/auth/auth-store";

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
  useHostMethodSchemaVersion: () => ({ major: 1, minor: 1 }),
  useHostSupportsMethod: () => true,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
  useOptionalHostClient: () => requireTeamHostClient(),
  useHostDirectory: () => ({
    findById: (hostId: string) =>
      hostId === mockLocalHostEntry.hostId ? { label: "This Mac" } : null,
  }),
}));

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

beforeAll(() => {
  settleProcessHostRpcTierPlan(poolEntry);
});

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  useSelectionAuthorityStore.getState().reset();
  useAuthStore.setState({ profile: null });
});

describe("useEnvironmentMembersList on a pooled build", () => {
  it("reads cached pages and refreshes them through each real members write on the pool", async () => {
    let revision = 0;
    const requestedCursors: Array<string | null> = [];
    const harness = mountTeamPageOnPoolBuild(poolSource("admin"), {
      "environment.members": ({ cursor }) => {
        requestedCursors.push(cursor);
        if (cursor === null)
          return page([member("u-admin", "admin")], "page-1");
        return page([member(`u-revision-${String(revision)}`, "viewer")], null);
      },
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
    harness.queryClient.setQueryDefaults(
      ["host", POOL_HOST_ID, "environment.members"],
      { gcTime: Infinity, staleTime: Infinity },
    );
    const poolSecondPageKey = [
      ...queryKeys.hostMethod<HostRpcRegistry, "environment.members">(
        POOL_HOST_ID,
        "environment.members",
        { environmentId: ENVIRONMENT_ID, cursor: "page-1" },
      ),
      VIEWER_ID,
    ];
    const callerSecondPageKey = [
      ...queryKeys.hostMethod<HostRpcRegistry, "environment.members">(
        mockLocalHostEntry.hostId,
        "environment.members",
        { environmentId: ENVIRONMENT_ID, cursor: "page-1" },
      ),
      VIEWER_ID,
    ];
    harness.queryClient.setQueryData(
      poolSecondPageKey,
      page([member("u-pool-page-2", "viewer")], null),
    );
    harness.queryClient.setQueryData(
      callerSecondPageKey,
      page([member("u-caller-decoy", "viewer")], null),
    );

    const { result } = renderHook(
      () => {
        const client = requireTeamHostClient();
        return {
          list: useEnvironmentMembersList(client, ENVIRONMENT_ID, true),
          writes: useEnvironmentMembersWrites(client, ENVIRONMENT_ID),
        };
      },
      { wrapper: harness.Wrapper },
    );

    await waitFor(() => {
      expect(result.current.list.members.map(({ userId }) => userId)).toEqual([
        "u-admin",
        "u-pool-page-2",
      ]);
    });
    expect(requestedCursors).toEqual([null]);
    expect(hostIdsOf(harness, "environment.members")).toEqual([POOL_HOST_ID]);

    const expectRefreshedPage = async (
      write: () => Promise<unknown>,
      nextRevision: number,
    ): Promise<void> => {
      const readsBefore = hostIdsOf(harness, "environment.members").length;
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
      expect(hostIdsOf(harness, "environment.members").length).toBeGreaterThan(
        readsBefore,
      );
      expect(
        hostIdsOf(harness, "environment.members").every(
          (hostId) => hostId === POOL_HOST_ID,
        ),
      ).toBe(true);
      expect(requestedCursors).toContain("page-1");
    };

    await expectRefreshedPage(
      () =>
        result.current.writes.invite({
          email: "new@acme.test",
          role: "editor",
        }),
      1,
    );
    expect(hostIdsOf(harness, "environment.members.invite")).toEqual([
      POOL_HOST_ID,
    ]);

    await expectRefreshedPage(
      () => result.current.writes.setRole({ userId: "u-admin", role: "admin" }),
      2,
    );
    expect(hostIdsOf(harness, "environment.members.setRole")).toEqual([
      POOL_HOST_ID,
    ]);

    await expectRefreshedPage(
      () => result.current.writes.remove({ userId: "u-admin" }),
      3,
    );
    expect(hostIdsOf(harness, "environment.members.remove")).toEqual([
      POOL_HOST_ID,
    ]);
  });

  it("sends the real Members invite dialog through the pool with no active host", async () => {
    const inviteRequests: Array<{ email: string; role: MemberRole }> = [];
    const harness = mountTeamPageOnPoolBuild(poolSource("admin"), {
      "environment.list": () => ({
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
      }),
      "environment.members": () => page([member(VIEWER_ID, "admin")], null),
      "environment.members.seats": () => ({ seats: null }),
      "environment.members.invite": (request) => {
        inviteRequests.push({ email: request.email, role: request.role });
        return { outcome: "sent", seatDelta: null };
      },
    });
    const client = requireTeamHostClient();
    teamHostBoundary.client = client.createRequesterForHostId(null);
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
      expect(hostIdsOf(harness, "environment.members.seats")).toEqual([
        POOL_HOST_ID,
      ]);
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
    expect(new Set(hostIdsOf(harness, "environment.members"))).toEqual(
      new Set([POOL_HOST_ID]),
    );
    expect(hostIdsOf(harness, "environment.members.invite")).toEqual([
      POOL_HOST_ID,
    ]);
  });
});
