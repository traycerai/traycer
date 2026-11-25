import { afterEach, describe, expect, it } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { poolHostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  createHostRpcTierPlan,
  hostRpcServingTierHostId,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { CURRENT_TEAM_COMPUTER_METHODS } from "@traycer-clients/shared/test-fixtures/account-wide-manifest";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { queryClient } from "@/lib/query-client";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { readHostServingDecision } from "@/lib/host/serving-decision";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { remoteEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { LIST_CLOUD_TASKS_REQUEST } from "@/lib/cloud-epic-tasks-query";
import { cloudEpicTasksQueryKey } from "@/lib/cloud-epic-tasks-query/query";

const teamComputer: HostDirectoryEntry = {
  hostId: "team-computer",
  label: "Team computer",
  kind: "remote",
  websocketUrl: "wss://team-computer.test/rpc",
  version: "1.0.0",
  transportDialability: "dialable",
  owner: { kind: "team", id: "team-1", name: "Team" },
};
const legacyTeamSandbox: RemoteHostDirectoryEntry = {
  hostId: "legacy-team-sandbox",
  label: "Legacy team sandbox",
  kind: "remote",
  websocketUrl: "wss://legacy-team-sandbox.test/rpc",
  version: "1.0.0",
  transportDialability: "dialable",
  owner: null,
  remoteStatus: {
    connectivity: "connectable",
    viewerReachability: "unknown",
    clientCloud: "ok",
    updateState: "current",
    appVersion: null,
    lastSeenAt: null,
  },
  publicKey: "legacy-team-sandbox-key",
  relayFuseGrace: false,
  sandbox: {
    state: "awake",
    frozen: false,
    profile: "agent",
    ownerTeamName: "Team",
    ownerTeamId: "team-1",
  },
};
const pool = poolHostDirectoryEntry("wss://pool.test/rpc");
if (pool === null) throw new Error("pool fixture must build");

describe("app serving decision uses the cached team binding", () => {
  afterEach(() => {
    queryClient.clear();
    useSelectionAuthorityStore.getState().reset();
    resetNegotiatedManifests();
  });

  it("lets matching Guide calls use the team peer while account policy stays on the pool", () => {
    useSelectionAuthorityStore.setState({
      servingPeer: { kind: "computer", hostId: teamComputer.hostId },
    });
    recordNegotiatedHostMethods(teamComputer.hostId, [
      "autoPolicy.get",
      "environment.configuration.guide.get",
    ]);
    queryClient.setQueryData(
      hostQueryKeys.method<HostRpcRegistry, "environment.binding.read">(
        pool.hostId,
        "environment.binding.read",
        { hostId: teamComputer.hostId },
      ),
      {
        hostId: teamComputer.hostId,
        environment: {
          environmentId: "environment-team",
          ownerKind: "organization",
          ownerId: "team-1",
          roomId: "room-team",
          label: "Team",
        },
        explicit: true,
        enrolledByUserId: "viewer-1",
        canUnbind: false,
      },
    );

    const serving = readHostServingDecision((hostId) =>
      hostId === teamComputer.hostId ? teamComputer : null,
    );
    const plan = createHostRpcTierPlan(pool);
    expect(serving.servingPeerEnvironmentId).toBe("environment-team");
    expect(
      hostRpcServingTierHostId(
        "environment.configuration.guide.get",
        null,
        plan,
        null,
        serving,
        "environment-team",
      ),
    ).toBe(teamComputer.hostId);
    expect(
      hostRpcServingTierHostId(
        "environment.configuration.guide.get",
        null,
        plan,
        null,
        serving,
        "environment-other",
      ),
    ).toBe(pool.hostId);
    expect(
      hostRpcServingTierHostId(
        "autoPolicy.get",
        null,
        plan,
        null,
        serving,
        null,
      ),
    ).toBe(pool.hostId);
  });

  it("uses the cached team binding for a legacy team-owned sandbox", () => {
    useSelectionAuthorityStore.setState({
      servingPeer: {
        kind: "computer",
        hostId: legacyTeamSandbox.hostId,
      },
    });
    recordNegotiatedHostMethods(legacyTeamSandbox.hostId, [
      ...CURRENT_TEAM_COMPUTER_METHODS,
    ]);
    queryClient.setQueryData(
      hostQueryKeys.method<HostRpcRegistry, "environment.binding.read">(
        pool.hostId,
        "environment.binding.read",
        { hostId: legacyTeamSandbox.hostId },
      ),
      {
        hostId: legacyTeamSandbox.hostId,
        environment: {
          environmentId: "environment-team",
          ownerKind: "organization",
          ownerId: "team-1",
          roomId: "room-team",
          label: "Team",
        },
        explicit: true,
        enrolledByUserId: "viewer-1",
        canUnbind: false,
      },
    );

    const serving = readHostServingDecision((hostId) =>
      hostId === legacyTeamSandbox.hostId ? legacyTeamSandbox : null,
    );
    expect(serving.servingPeerEnvironmentId).toBe("environment-team");
    expect(
      hostRpcServingTierHostId(
        "environment.configuration.guide.set",
        null,
        createHostRpcTierPlan(pool),
        null,
        serving,
        "environment-team",
      ),
    ).toBe(legacyTeamSandbox.hostId);
  });

  it("keeps account-wide History keys and dispatch on the effective computer when the build has no pool", async () => {
    const computer = remoteEntry("effective-computer", null);
    const directory = new Map([[computer.hostId, computer]]);
    useSelectionAuthorityStore.getState().applyKernelSnapshot({
      attached: true,
      preferredHostId: computer.hostId,
      targetHostId: computer.hostId,
      effectiveHostId: computer.hostId,
      servingPeer: { kind: "computer", hostId: computer.hostId },
      noPeerPresentation: null,
      leases: [],
      selectionRevision: 4,
    });
    const serving = readHostServingDecision(
      (hostId) => directory.get(hostId) ?? null,
    );
    const plan = createHostRpcTierPlan(poolHostDirectoryEntry(""));
    expect(plan.pool).toBeNull();

    const answerHostId = hostRpcServingTierHostId(
      "epic.listTasks",
      computer.hostId,
      plan,
      null,
      serving,
      null,
    );
    expect(answerHostId).toBe(computer.hostId);
    if (answerHostId === null) throw new Error("effective computer is missing");
    expect(
      cloudEpicTasksQueryKey(
        answerHostId,
        "serving-decision-user",
        LIST_CLOUD_TASKS_REQUEST,
      ).slice(0, 3),
    ).toEqual(["host", computer.hostId, "cloud.listTasks"]);

    const messenger = new MockHostMessenger({
      registry: hostRpcRegistry,
      requestId: () => "no-pool-history-request",
      handlers: {
        "epic.listTasks": () => ({ tasks: [], hasMore: false }),
      },
    });
    const client = new HostClient({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      messenger,
      findHostById: (hostId) => directory.get(hostId) ?? null,
      routing: {
        plan,
        selectedHostId: () => null,
        serving: () =>
          readHostServingDecision((hostId) => directory.get(hostId) ?? null),
      },
    });
    client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "test-token",
        identity: {
          userId: "serving-decision-user",
          username: "Serving decision user",
          providerHandle: "serving-decision-user",
        },
      }),
    );
    try {
      await client
        .createRequesterForHostId(answerHostId)
        .request("epic.listTasks", LIST_CLOUD_TASKS_REQUEST);
      expect(
        messenger.calls.map((call) => call.authority.endpoint.hostId),
      ).toEqual([computer.hostId]);
    } finally {
      client.dispose();
    }
  });
});
