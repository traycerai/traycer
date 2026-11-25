import { afterEach, describe, expect, it } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { poolHostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  createHostRpcTierPlan,
  hostRpcServingTierHostId,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { queryClient } from "@/lib/query-client";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { readHostServingDecision } from "@/lib/host/serving-decision";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

const teamComputer: HostDirectoryEntry = {
  hostId: "team-computer",
  label: "Team computer",
  kind: "remote",
  websocketUrl: "wss://team-computer.test/rpc",
  version: "1.0.0",
  transportDialability: "dialable",
  owner: { kind: "team", id: "team-1", name: "Team" },
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
});
