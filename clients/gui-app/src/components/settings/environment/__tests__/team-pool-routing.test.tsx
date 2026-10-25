import "../../../../../__tests__/test-browser-apis";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { settleProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type { EnvironmentMembersResponseV12 } from "@traycer/protocol/host/environment/contracts";
import { PageChip } from "@/components/settings/personal/page-chip";
import { TeamPermissions } from "@/components/settings/environment/team-permissions";
import { TeamPlans } from "@/components/settings/environment/team-plans";
import {
  configurationItem,
  hostIdsOf,
  mountTeamPageOnPoolBuild,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "./team-configuration-test-support";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? null : requireTeamHostClient(),
}));

// The tier plan is frozen per process from the build; this file's build has a pool.
beforeAll(() => {
  settleProcessHostRpcTierPlan(poolEntry);
});

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
});

const environmentList = {
  environments: [
    {
      environmentId: "env-a",
      ownerKind: "organization" as const,
      ownerId: "team-a",
      roomId: "room-a",
      label: "Acme",
      effectiveRole: "admin" as const,
      kind: "team" as const,
      hostCount: 1,
      providerHandle: "handle-a",
    },
  ],
};

const members: EnvironmentMembersResponseV12 = {
  members: [
    {
      userId: "u-1",
      displayName: "Ada",
      email: "ada@acme.test",
      avatarUrl: null,
      effectiveRole: "admin",
      linkedPlan: false,
      inviteState: "accepted",
      invitedAddress: null,
    },
  ],
  nextCursor: null,
  legacyRoleNoticeSeenAt: null,
  legacyMembers: [],
};

describe("team pages on a build with a server pool", () => {
  it("reads the team's data from the window's host and only the environment list from the pool", async () => {
    const harness = mountTeamPageOnPoolBuild(poolSource("editor"), {
      "environment.configuration.items": () => ({
        items: [
          configurationItem({
            kind: "auto_policy",
            key: "policy",
            value: { body: "Allow reads" },
          }),
        ],
      }),
      "environment.members": () => members,
      "environment.list": () => environmentList,
    });
    render(<TeamPermissions>{null}</TeamPermissions>, {
      wrapper: harness.Wrapper,
    });

    expect(await screen.findByText("Admins change this: Ada.")).toBeTruthy();
    await waitFor(() => {
      expect(hostIdsOf(harness, "environment.list")).not.toHaveLength(0);
    });
    for (const method of [
      "environment.configuration.items",
      "environment.members",
    ]) {
      expect(hostIdsOf(harness, method)).not.toHaveLength(0);
      expect(hostIdsOf(harness, method)).toEqual(
        hostIdsOf(harness, method).map(() => mockLocalHostEntry.hostId),
      );
    }
    expect(new Set(hostIdsOf(harness, "environment.list"))).toEqual(
      new Set([POOL_HOST_ID]),
    );
  });

  it("reads the host reports from the window's host", async () => {
    const harness = mountTeamPageOnPoolBuild(poolSource("editor"), {
      "environment.host.list": () => ({ hosts: [] }),
    });
    render(
      <PageChip
        section="shell"
        pick={{ kind: "team", environmentId: "env-a" }}
      />,
      { wrapper: harness.Wrapper },
    );

    await waitFor(() => {
      expect(hostIdsOf(harness, "environment.host.list")).not.toHaveLength(0);
    });
    expect(new Set(hostIdsOf(harness, "environment.host.list"))).toEqual(
      new Set([mockLocalHostEntry.hostId]),
    );
  });

  it("invalidates the pool's environment list after an unlink carried by the window's host", async () => {
    const harness = mountTeamPageOnPoolBuild(poolSource("admin"), {
      "environment.plans.list": () => ({
        plans: [
          {
            profileId: "prof-1",
            harness: "claude",
            status: "linked" as const,
            linkedBy: { name: "Ada", you: false },
          },
        ],
      }),
      "environment.list": () => environmentList,
      "environment.plans.unlinkPreview": () => ({
        activeTurns: 0,
        localHostId: null,
        keepsWorking: [],
      }),
      "environment.plans.unlink": () => ({ outcome: "unlinked" }),
    });
    render(<TeamPlans providerId="claude-code" adminNames={["Ada"]} />, {
      wrapper: harness.Wrapper,
    });

    const card = await screen.findByRole("region", { name: "Plans" });
    await waitFor(() => {
      expect(hostIdsOf(harness, "environment.list")).not.toHaveLength(0);
    });
    const listReadsBefore = hostIdsOf(harness, "environment.list").length;
    await userEvent.click(within(card).getByRole("button", { name: "Unlink" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Unlink" }),
    );

    await waitFor(() => {
      expect(hostIdsOf(harness, "environment.list").length).toBeGreaterThan(
        listReadsBefore,
      );
    });
    expect(hostIdsOf(harness, "environment.plans.unlink")).toEqual([
      mockLocalHostEntry.hostId,
    ]);
    expect(new Set(hostIdsOf(harness, "environment.list"))).toEqual(
      new Set([POOL_HOST_ID]),
    );
  });
});
