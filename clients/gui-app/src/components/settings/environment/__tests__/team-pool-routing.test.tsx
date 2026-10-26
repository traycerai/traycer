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
import type { EnvironmentMembersResponseV12 } from "@traycer/protocol/host/environment/contracts";
import { PageChip } from "@/components/settings/personal/page-chip";
import { TeamPermissions } from "@/components/settings/environment/team-permissions";
import { TeamPlans } from "@/components/settings/environment/team-plans";
import { TeamVariablesAndShells } from "@/components/settings/environment/team-variables-and-shells";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import {
  configurationItem,
  hostIdsOf,
  mountTeamPageOnPoolBuild,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
  teamHostBoundary,
} from "./team-configuration-test-support";

// These cases are about the environments-on behaviour.
vi.mock("@/hooks/auth/use-preview-feature", () => ({
  usePreviewFeature: () => "on" as const,
}));

// A team page reads its hosts from the host list; this window's own host
// scope has no hosts here.
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const scope = hostScopeFixture({ host: null });
  return { useHostScope: () => scope };
});
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
  useSelectionAuthorityStore.getState().reset();
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

function removeSurfaceHost(): void {
  useSelectionAuthorityStore.getState().reset();
  teamHostBoundary.client =
    requireTeamHostClient().createRequesterForHostId(null);
  expect(useSelectionAuthorityStore.getState().effectiveHostId).toBeNull();
  expect(requireTeamHostClient().getActiveHostId()).toBeNull();
}

describe("team pages on a build with a server pool", () => {
  it("reads the team's records and members from the pool, whichever host the window is on", async () => {
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
    removeSurfaceHost();
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
      "environment.list",
    ]) {
      expect(hostIdsOf(harness, method)).not.toHaveLength(0);
      expect(new Set(hostIdsOf(harness, method))).toEqual(
        new Set([POOL_HOST_ID]),
      );
    }
  });

  it("reads the host reports from the pool", async () => {
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
      new Set([POOL_HOST_ID]),
    );
  });

  it("invalidates the pool's environment list after an unlink the pool carries", async () => {
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
    removeSurfaceHost();
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
      POOL_HOST_ID,
    ]);
    expect(new Set(hostIdsOf(harness, "environment.list"))).toEqual(
      new Set([POOL_HOST_ID]),
    );
    expect(new Set(hostIdsOf(harness, "environment.plans.list"))).toEqual(
      new Set([POOL_HOST_ID]),
    );
  });

  it("rereads pool environment membership after a forbidden item save with no surface host", async () => {
    const harness = mountTeamPageOnPoolBuild(poolSource("editor"), {
      "environment.configuration.items": () => ({
        items: [
          configurationItem({
            kind: "variable",
            key: "NODE_ENV",
            os: "any",
            value: { value: "production" },
          }),
        ],
      }),
      "environment.configuration.items.put": () => ({
        outcome: "forbidden",
      }),
      "environment.host.list": () => ({ hosts: [] }),
      "environment.list": () => environmentList,
    });
    removeSurfaceHost();
    render(<TeamVariablesAndShells />, { wrapper: harness.Wrapper });

    const value = await screen.findByLabelText("NODE_ENV value");
    const listReadsBefore = hostIdsOf(harness, "environment.list").length;
    await userEvent.clear(value);
    await userEvent.type(value, "staging");
    await userEvent.click(
      within(screen.getByRole("region", { name: "NODE_ENV" })).getByRole(
        "button",
        { name: "Save" },
      ),
    );

    await waitFor(() => {
      expect(hostIdsOf(harness, "environment.configuration.items.put")).toEqual(
        [POOL_HOST_ID],
      );
      expect(hostIdsOf(harness, "environment.list").length).toBeGreaterThan(
        listReadsBefore,
      );
    });
    expect(new Set(hostIdsOf(harness, "environment.list"))).toEqual(
      new Set([POOL_HOST_ID]),
    );
  });
});
