import "../../../../../__tests__/test-browser-apis";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {
  EnvironmentDescriptorV11,
  EnvironmentHostRecordV12,
} from "@traycer/protocol/host/environment/contracts";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { settleProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { PageChip } from "@/components/settings/personal/page-chip";
import { SecretsHeaderDetails } from "@/components/settings/secrets/secrets-header-details";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { hostQueryKeys } from "@/lib/query-keys";
import type { HostRpcRegistry } from "@/lib/host";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  hostIdsOf,
  mountTeamPageOnPoolBuild,
  personalPoolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
  teamHostBoundary,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";

const reads = vi.hoisted(
  (): {
    scope: HostScope | null;
    readonly statuses: Map<string, unknown>;
    readonly versions: Map<string, unknown>;
  } => ({
    scope: null,
    statuses: new Map(),
    versions: new Map(),
  }),
);

vi.mock("@/components/settings/host-scope/use-host-scope", () => ({
  useHostScope: () => reads.scope,
  useHostScopeFor: () => reads.scope,
  WINDOW_HOST_SELECTION: {
    scopedHostId: null,
    setScopedHostId: () => undefined,
  },
}));
vi.mock("@/hooks/environment/use-registered-host-environment-statuses", () => ({
  useRegisteredHostEnvironmentStatuses: () => reads.statuses,
}));
vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersions: () => reads.versions,
}));
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
vi.mock("@/components/settings/details/use-details-environment-id", () => ({
  useDetailsEnvironmentId: () => "env-personal",
}));
vi.mock("@/components/settings/details/use-details-recovery", () => ({
  useDetailsRecovery: () => ({ recover: vi.fn(), pending: false }),
}));

const personal: EnvironmentDescriptorV11 = {
  environmentId: "env-personal",
  ownerKind: "user",
  ownerId: "user-me",
  roomId: "room-personal",
  label: "Personal",
  effectiveRole: "owner",
  kind: "personal",
  hostCount: 1,
  providerHandle: null,
};

function listed(hostId: string, hostLabel: string): EnvironmentHostRecordV12 {
  return {
    hostId,
    hostLabel,
    hostPlatform: "darwin",
    enrolledByUserId: "user-me",
    kind: "personal",
    boundAt: 1,
    reachable: false,
    lastReportedAt: 1,
    applied: [],
    hasLocalRow: false,
  };
}

beforeAll(() => {
  settleProcessHostRpcTierPlan(poolEntry);
});

beforeEach(() => {
  reads.scope = hostScopeFixture({ host: null });
  reads.statuses.clear();
  reads.versions.clear();
  useSelectionAuthorityStore.getState().reset();
});

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  useSelectionAuthorityStore.getState().reset();
  useSettingsEnvironmentPickStore.setState({ pick: null });
  useAuthStore.setState({ contextMetadata: null });
});

describe("Personal page chip on a build with a server pool", () => {
  it("reads the Personal environment and running hosts from the pool with no active host", async () => {
    const poolHost = listed("pool-personal-runner", "Personal runner");
    const harness = mountTeamPageOnPoolBuild(personalPoolSource(), {
      "environment.list": () => ({ environments: [personal] }),
      "environment.host.list": () => ({ hosts: [poolHost] }),
    });
    const client = requireTeamHostClient();
    const decoyKey = [
      ...hostQueryKeys.method<HostRpcRegistry, "environment.host.list">(
        mockLocalHostEntry.hostId,
        "environment.host.list",
        { environmentId: "env-personal" },
      ),
      "user-me",
    ];
    const poolKey = [
      ...hostQueryKeys.method<HostRpcRegistry, "environment.host.list">(
        POOL_HOST_ID,
        "environment.host.list",
        { environmentId: "env-personal" },
      ),
      "user-me",
    ];
    const decoyHosts = [listed("caller-decoy", "Caller decoy")];
    harness.queryClient.setQueryDefaults(decoyKey, { gcTime: 60_000 });
    harness.queryClient.setQueryData(decoyKey, { hosts: decoyHosts });
    reads.scope = hostScopeFixture({ host: null, hosts: [] });
    useSelectionAuthorityStore.getState().reset();
    teamHostBoundary.client = client.createRequesterForHostId(null);

    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBeNull();
    expect(requireTeamHostClient().getActiveHostId()).toBeNull();
    render(
      <div data-testid="chip">
        <PageChip section="mcp-servers" pick={PERSONAL_PICK} />
      </div>,
      { wrapper: harness.Wrapper },
    );

    await waitFor(() => {
      expect(hostIdsOf(harness, "environment.list")).not.toHaveLength(0);
      expect(hostIdsOf(harness, "environment.host.list")).not.toHaveLength(0);
      expect(screen.getByTestId("chip").textContent).toBe(
        "✓ On Personal runner",
      );
    });
    expect(new Set(hostIdsOf(harness, "environment.list"))).toEqual(
      new Set([POOL_HOST_ID]),
    );
    expect(new Set(hostIdsOf(harness, "environment.host.list"))).toEqual(
      new Set([POOL_HOST_ID]),
    );
    expect(harness.queryClient.getQueryData(decoyKey)).toEqual({
      hosts: decoyHosts,
    });
    expect(harness.queryClient.getQueryData(poolKey)).toEqual({
      hosts: [poolHost],
    });
  });

  it("loads Personal hosts for the Secrets drawer on a Local pick and counts only sandboxes", async () => {
    const computer = listed("computer-1", "dev-box");
    const sandbox: EnvironmentHostRecordV12 = {
      ...listed("sandbox-1", "worker"),
      kind: "sandbox",
    };
    const harness = mountTeamPageOnPoolBuild(personalPoolSource(), {
      "environment.list": () => ({ environments: [personal] }),
      "environment.host.list": () => ({ hosts: [computer, sandbox] }),
      "environment.history": () => ({
        readerScope: "full",
        entries: [],
        hostStates: [
          {
            hostId: "computer-1",
            hostName: "dev-box",
            state: "applied",
            reason: null,
            at: 1,
            lastReportedAt: 1,
          },
          {
            hostId: "sandbox-1",
            hostName: "worker",
            state: "applied",
            reason: null,
            at: 1,
            lastReportedAt: 1,
          },
        ],
      }),
      "environment.secrets.list": () => ({ secrets: [], removed: [] }),
    });
    useAuthStore.setState({
      contextMetadata: { userId: "user-me", username: "me" },
    });
    useSettingsEnvironmentPickStore.setState({
      pick: {
        kind: "local",
        hostId: mockLocalHostEntry.hostId,
        hostName: "Mac",
      },
    });

    render(<SecretsHeaderDetails />, { wrapper: harness.Wrapper });

    await waitFor(() => {
      expect(hostIdsOf(harness, "environment.host.list")).toEqual([
        POOL_HOST_ID,
      ]);
    });
    expect(harness.paramsOf("environment.host.list")).toEqual([
      { environmentId: "env-personal" },
    ]);
    fireEvent.click(await screen.findByRole("button", { name: "Details" }));

    expect(await screen.findByText("Applied on 1 host")).toBeTruthy();
    expect(screen.getByText("worker")).toBeTruthy();
    expect(screen.queryByText("dev-box")).toBeNull();
  });

  it("uses one Personal host-list request for the chip and Secrets header", async () => {
    const harness = mountTeamPageOnPoolBuild(personalPoolSource(), {
      "environment.list": () => ({ environments: [personal] }),
      "environment.host.list": () => ({ hosts: [] }),
    });
    useAuthStore.setState({
      contextMetadata: { userId: "user-me", username: "me" },
    });
    useSettingsEnvironmentPickStore.setState({ pick: PERSONAL_PICK });

    render(
      <>
        <PageChip section="secrets" pick={PERSONAL_PICK} />
        <SecretsHeaderDetails />
      </>,
      { wrapper: harness.Wrapper },
    );

    expect(
      await screen.findByRole("button", {
        name: "Not on any computer or sandbox",
      }),
    ).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Details" })).toBeTruthy();
    expect(hostIdsOf(harness, "environment.host.list")).toEqual([POOL_HOST_ID]);
    expect(harness.paramsOf("environment.host.list")).toEqual([
      { environmentId: "env-personal" },
    ]);
  });
});
