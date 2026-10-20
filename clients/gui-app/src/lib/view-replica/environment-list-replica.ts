import {
  environmentListResponseSchema,
  type EnvironmentDescriptor,
  type EnvironmentListResponse,
} from "@traycer/protocol/host/environment/contracts";
import {
  hostRpcServingTierHostId,
  readProcessHostRpcTierPlan,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import {
  clientUnaryCanonicalVersion,
  viewReplicaRequestScope,
  type ViewReplicaAddress,
} from "@traycer-clients/shared/view-replica/identity";
import {
  ACCOUNT_ROW_SCOPE,
  organizationRowScope,
  type ViewReplicaRowScope,
} from "@traycer-clients/shared/view-replica/row-scope";
import { ViewReplicaService } from "@traycer-clients/shared/view-replica/service";
import { viewReplicaStore } from "@/lib/view-replica/view-replica-store";

const SERVICE = "environment.list";

/**
 * The environment list in the replica tier. A team's environment is that
 * team's row, so leaving the team withdraws it from the cached list; the
 * personal environment is the account's.
 */
export const environmentListReplicaService =
  new ViewReplicaService<EnvironmentListResponse>({
    service: SERVICE,
    canonicalVersion: clientUnaryCanonicalVersion(SERVICE),
    split: (page) => ({
      shell: {},
      rows: page.environments.map((environment) => ({
        scope: environmentRowScope(environment),
        value: environment,
      })),
    }),
    join: (_shell, rows) => {
      const parsed = environmentListResponseSchema.safeParse({
        environments: rows,
      });
      return parsed.success ? parsed.data : null;
    },
    asCached: (page) => page,
  });

function environmentRowScope(
  environment: EnvironmentDescriptor,
): ViewReplicaRowScope {
  return environment.ownerKind === "organization"
    ? organizationRowScope(environment.ownerId)
    : ACCOUNT_ROW_SCOPE;
}

export function environmentListReplicaAddress(
  accountId: string,
  servingHostId: string | null,
): ViewReplicaAddress | null {
  const servingTier = hostRpcServingTierHostId(
    SERVICE,
    servingHostId,
    readProcessHostRpcTierPlan(),
    null,
  );
  if (servingTier === null) return null;
  return {
    accountId,
    service: SERVICE,
    servingTier,
    requestScope: viewReplicaRequestScope({}),
  };
}

/** Records an answer; `observedAt` is when its request was sent. */
export function rememberEnvironmentList(input: {
  readonly accountId: string;
  readonly servingHostId: string | null;
  readonly page: EnvironmentListResponse;
  readonly observedAt: number;
}): void {
  const address = environmentListReplicaAddress(
    input.accountId,
    input.servingHostId,
  );
  if (address === null) return;
  viewReplicaStore.write(environmentListReplicaService, address, input.page, {
    observedAt: input.observedAt,
    sourceGeneration: null,
  });
}
