import { useEffect, useMemo } from "react";
import { readProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import {
  publishEnvironmentArmScope,
  type EnvironmentArmMethod,
} from "@/hooks/environment/use-environment-arms";
import { usePoolTierStreamClient } from "@/hooks/host/use-pool-tier";
import { useHostClient } from "@/lib/host";
import { useStreamMethodSupportFor } from "@/lib/host/stream-runtime-context";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

/**
 * Publishes where the environment arms are read, mounted once per app.
 * Nothing in a build without a server pool, so no surface that composes arm
 * rows reads the pool's client, the verdict or the environment list itself.
 */
export function EnvironmentArmScopeMount() {
  return readProcessHostRpcTierPlan().pool === null ? null : (
    <PoolEnvironmentArmScope />
  );
}

function PoolEnvironmentArmScope(): null {
  const pool = readProcessHostRpcTierPlan().pool;
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const viewerId = useAuthStore(
    (state) => state.contextMetadata?.userId ?? null,
  );
  const client = usePoolTierStreamClient(null, viewerId);
  const chats = useStreamMethodSupportFor(
    client,
    "environment.chats.subscribe",
  );
  const terminals = useStreamMethodSupportFor(
    client,
    "environment.plainTerminals.subscribe",
  );
  const graph = useStreamMethodSupportFor(
    client,
    "environment.communicationGraph.subscribe",
  );
  const environments = useEnvironmentListQuery(useHostClient(), authorized);
  const environmentData = environments.data;
  const scope = useMemo(() => {
    const teams = (environmentData?.environments ?? []).filter(
      (environment) => environment.ownerKind === "organization",
    );
    const environmentIds = teams.map(
      (environment) => environment.environmentId,
    );
    if (
      pool === null ||
      !authorized ||
      viewerId === null ||
      client === null ||
      environmentIds.length === 0
    ) {
      return null;
    }
    const supported = new Set<EnvironmentArmMethod>();
    if (chats === "supported") supported.add("environment.chats.subscribe");
    if (terminals === "supported") {
      supported.add("environment.plainTerminals.subscribe");
    }
    if (graph === "supported") {
      supported.add("environment.communicationGraph.subscribe");
    }
    return {
      poolHostId: pool.hostId,
      client,
      viewerId,
      environmentIds,
      // An organization environment's `ownerId` is its team's id.
      environmentIdByTeamId: new Map(
        teams.map((environment) => [
          environment.ownerId,
          environment.environmentId,
        ]),
      ),
      supported,
    };
  }, [
    authorized,
    chats,
    client,
    environmentData,
    graph,
    pool,
    terminals,
    viewerId,
  ]);
  useEffect(() => {
    publishEnvironmentArmScope(scope);
    return () => publishEnvironmentArmScope(null);
  }, [scope]);
  return null;
}
