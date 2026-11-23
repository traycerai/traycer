import type { ReactNode } from "react";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { StoredCliInstallManifest } from "@traycer/protocol/config/installation-records";
import {
  useHostScopeForHostId,
  type HostScope,
} from "@/components/settings/host-scope/use-host-scope";
import {
  managedInstallation,
  useHostInstallationInfoQuery,
  useHostOverviewStatusQuery,
} from "@/components/settings/panels/host-overview-rpc";
import { inFlightUpdateKind } from "@/components/settings/panels/host-overview-status-model";
import {
  hostStatusReadHealth,
  hostUpdateActivationDebt,
  hostUpdateDegrades,
  updateHoldsLifecycleGate,
  useHostForegroundUpdateLine,
  useHostUpdateCapabilities,
  useHostUpdateOperation,
  useOverviewIncarnation,
  useUpdateDispatchUpkeep,
  useUpdateInstallAcceptedLatch,
  type HostUpdateCapabilities,
  type HostUpdateOperation,
} from "@/components/settings/panels/host-overview-update-reads";
import { HostOverviewUpdateAction } from "@/components/settings/panels/host-overview-updates";
import { useHostOverviewUpdates } from "@/components/settings/panels/host-overview-updates-state";
import { useDesktopAppUpdates } from "@/hooks/runner/use-desktop-app-updates";
import type { HostRpcRegistry } from "@/lib/host";
import { canonicalReadIsLive } from "@/lib/host/fleet-update/canonical-status-observation";

/**
 * Host Overview's Update now for `hostId`, on a page that computer lacks until
 * it is updated: the same reads, the same gates and the same install of the
 * latest version. Restart, Force and the version list stay on Host Overview.
 * Renders nothing where Host Overview would offer no Update now.
 */
export function HostUpdateNowAction(props: {
  readonly hostId: string;
}): ReactNode {
  const reads = useHostUpdateNowReads(props.hostId);
  const { scope, status, operation } = reads;
  const { reportedOperation } = reads;
  const incarnation = useOverviewIncarnation();
  useUpdateDispatchUpkeep(scope.hostId, reportedOperation);
  const acceptedAt = useUpdateInstallAcceptedLatch(
    scope.hostId,
    reads.updateProgress,
  );
  const updateInFlight = updateHoldsLifecycleGate({
    view: operation.operationView,
    observation: operation.projection.observation,
    peerReportedOperation: reportedOperation,
  });
  const foregroundUpdateLine = useHostForegroundUpdateLine(
    reads.isLocalMachine,
  );
  const degrades = hostUpdateDegrades(status, reads.capabilities);
  const desktopUpdates = useDesktopAppUpdates();
  const updates = useHostOverviewUpdates({
    client: scope.client,
    hostName: scope.hostLabel,
    hostId: scope.hostId,
    runningVersion: reads.runningVersion,
    storeFormats: reads.storeFormats,
    install: reads.install,
    activationDebt: hostUpdateActivationDebt(operation, reads.statusLive),
    platformKey: reads.platformKey,
    cliManifest: reads.cliManifest,
    isLocalMachine: reads.isLocalMachine,
    desktopUpdate:
      desktopUpdates.bridge === null ? null : desktopUpdates.snapshot,
    stagedVersion: reads.stagedVersion,
    enabled: reads.usable && status !== undefined,
    checkDegrade: degrades.check,
    installDegrade: degrades.install,
    busy: updateInFlight || acceptedAt !== null,
    foregroundUpdateLine,
    incarnation,
  });
  return HostOverviewUpdateAction(
    {
      summary: updates.summary,
      degrade: updates.degrade,
      foregroundUpdateLine,
    },
    inFlightUpdateKind(operation.operationView) !== null,
    false,
  );
}

type HostStatusResponse = ResponseOfMethod<HostRpcRegistry, "host.status">;

interface StatusUpdateFields {
  readonly reportedOperation: HostStatusResponse["updateOperation"] | null;
  readonly updateProgress: HostStatusResponse["updateProgress"] | null;
  readonly runningVersion: string | null;
  readonly storeFormats: HostStatusResponse["storeFormats"] | null;
  readonly install: HostStatusResponse["install"] | null;
}

/** The `host.status` fields the update story reads, as Host Overview reads them. */
function statusUpdateFields(
  status: HostStatusResponse | undefined,
): StatusUpdateFields {
  return {
    reportedOperation: status?.updateOperation ?? null,
    updateProgress: status?.updateProgress ?? null,
    runningVersion: status?.hostVersion ?? null,
    storeFormats: status?.storeFormats ?? null,
    install: status?.install ?? null,
  };
}

interface HostUpdateNowReads extends StatusUpdateFields {
  readonly scope: HostScope;
  readonly usable: boolean;
  readonly isLocalMachine: boolean;
  readonly capabilities: HostUpdateCapabilities;
  readonly status: HostStatusResponse | undefined;
  readonly platformKey: string | null;
  readonly stagedVersion: string | null;
  readonly statusLive: boolean;
  readonly cliManifest: StoredCliInstallManifest | null;
  readonly operation: HostUpdateOperation;
}

/** The queries Host Overview reads for `hostId`'s update, read the same way. */
function useHostUpdateNowReads(hostId: string): HostUpdateNowReads {
  const scope = useHostScopeForHostId(hostId);
  const { client } = scope;
  const usable = isHostScopeUsable(scope.status) && client !== null;
  const isLocalMachine = scope.host?.isLocalMachine ?? false;
  const capabilities = useHostUpdateCapabilities(
    scope.hostId,
    scope.localMaintenanceFallback,
  );
  const statusQuery = useHostOverviewStatusQuery({
    client,
    enabled: usable,
    hostId: scope.hostId,
  });
  const installationQuery = useHostInstallationInfoQuery({
    client,
    enabled: usable && capabilities.installInfo === null,
    runningVersion: statusQuery.data?.hostVersion ?? null,
  });
  const statusHealth = hostStatusReadHealth(statusQuery, usable);
  const operation = useHostUpdateOperation({
    hostId: scope.hostId,
    isLocalMachine,
    usable,
    statusQuery,
    statusHealth,
    installationQuery,
    installInfoDegrade: capabilities.installInfo,
  });
  return {
    scope,
    usable,
    isLocalMachine,
    capabilities,
    status: statusQuery.data,
    ...statusUpdateFields(statusQuery.data),
    platformKey: scope.host?.platform ?? null,
    stagedVersion: operation.legacyFacts?.stagedWait?.stagedVersion ?? null,
    statusLive: canonicalReadIsLive(statusHealth),
    cliManifest:
      managedInstallation(installationQuery.data)?.cliManifest ?? null,
    operation,
  };
}
