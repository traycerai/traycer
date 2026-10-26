import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { settleProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import type { EnvironmentConfigurationItem } from "@traycer/protocol/host/environment/configuration-contracts";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import type { SandboxCatalogue } from "@traycer/protocol/host/sandbox-control";
import {
  configurationItem,
  hostIdsOf,
  mountTeamPageOnPoolBuild,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { SandboxDefaultsSection } from "@/components/settings/panels/sandbox-defaults-section";

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
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({ data: CATALOGUE }),
}));

// The tier plan is frozen per process from the build; this file's build has a pool.
beforeAll(() => {
  settleProcessHostRpcTierPlan(poolEntry);
});

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
});

const CATALOGUE: SandboxCatalogue = {
  providers: [
    {
      provider: "tensorlake",
      os: ["linux"],
      shape: {
        cpuMin: 1,
        cpuMax: 16,
        cpuStep: 1,
        memoryPerCpuMinMb: 1024,
        memoryPerCpuMaxMb: 8192,
        memoryMinMb: 1024,
        memoryMaxMb: 65536,
        memoryStepMb: 512,
        diskMinMb: 10240,
        diskMaxMb: 102400,
        diskDefaultMb: 20480,
      },
      suspendFidelity: "memory",
      stoppedStorage: "snapshot",
      wakeClass: "resume",
      shapes: [
        { cpus: 2, memoryMb: 4096, diskMb: 20_480, default: true },
        { cpus: 4, memoryMb: 8192, diskMb: 40_960, default: false },
      ],
      dockerInGuest: true,
      creatable: true,
      notCreatableReason: null,
      regions: [
        {
          id: "us-east",
          label: "US East",
          fromPriceMcPerHour: { awakeMc: 120, suspendedMc: 4, stoppedMc: 2 },
          pricing: null,
        },
      ],
    },
  ],
};

const TEAM_ENVIRONMENT: EnvironmentDescriptorV11 = {
  environmentId: "env-acme",
  ownerKind: "organization",
  ownerId: "team-1",
  roomId: "room-acme",
  label: "Acme",
  effectiveRole: "viewer",
  kind: "team",
  hostCount: 1,
  providerHandle: "handle-acme",
};

const SANDBOX_DEFAULTS_ITEM = configurationItem({
  kind: "sandbox_defaults",
  key: "sandbox",
  value: {
    os: "linux",
    cpus: 4,
    memoryMb: 8192,
    diskMb: 40_960,
    idleMinutes: 45,
    restingMinutes: null,
  },
});

const MEMBERS = [
  { userId: "u-1", displayName: "Ada", effectiveRole: "admin" as const },
  { userId: "u-2", displayName: "Bo", effectiveRole: "editor" as const },
  { userId: "u-3", displayName: "Cy", effectiveRole: "viewer" as const },
].map((member) => ({
  ...member,
  email: null,
  avatarUrl: null,
  linkedPlan: false,
  inviteState: "accepted" as const,
  invitedAddress: null,
}));

function mountViewer(
  readItems: () => { readonly items: EnvironmentConfigurationItem[] },
): TeamPageHarness {
  const harness = mountTeamPageOnPoolBuild(poolSource("viewer"), {
    "environment.list": () => ({ environments: [TEAM_ENVIRONMENT] }),
    "environment.configuration.items": readItems,
    "environment.members": () => ({
      members: MEMBERS,
      nextCursor: null,
      legacyRoleNoticeSeenAt: null,
      legacyMembers: [],
    }),
  });
  render(
    <SandboxDefaultsSection
      configuration={{
        kind: "team",
        teamId: "team-1",
        teamName: "Acme",
        environmentId: "env-acme",
      }}
    />,
    { wrapper: harness.Wrapper },
  );
  return harness;
}

function everyRequestWentToThePool(
  harness: TeamPageHarness,
  method: string,
): void {
  expect(hostIdsOf(harness, method)).not.toHaveLength(0);
  expect(new Set(hostIdsOf(harness, method))).toEqual(new Set([POOL_HOST_ID]));
}

describe("<SandboxDefaultsSection /> on a build with a server pool", () => {
  it("shows the item's values, read through the server pool", async () => {
    const harness = mountViewer(() => ({ items: [SANDBOX_DEFAULTS_ITEM] }));

    await waitFor(() => {
      expect(
        screen.getByTestId("sandboxes-defaults-shape").textContent,
      ).toContain("4 vCPU");
    });
    expect(screen.getByTestId("sandboxes-defaults-idle").textContent).toContain(
      "45",
    );
    everyRequestWentToThePool(harness, "environment.configuration.items");
  });

  it("names the editors a viewer can ask, read through the server pool", async () => {
    const harness = mountViewer(() => ({ items: [SANDBOX_DEFAULTS_ITEM] }));

    expect(await screen.findByText("Ada, Bo can change them")).toBeTruthy();
    everyRequestWentToThePool(harness, "environment.members");
  });

  it("says the defaults could not be read, with Retry and none of the value rows", async () => {
    mountViewer(() => {
      throw new Error("the host could not read the item");
    });

    expect(
      await screen.findByText("Couldn't read these defaults."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    for (const testId of [
      "sandboxes-defaults-shape",
      "sandboxes-defaults-idle",
      "sandboxes-defaults-resting",
    ]) {
      expect(screen.queryByTestId(testId)).toBeNull();
    }
  });
});
