import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useHostScope } from "@/components/settings/host-scope/use-host-scope";
import { useHostNegotiatedMethodVersions } from "@/hooks/host/use-host-negotiated-method-version";
import { usePersonalComputers } from "@/components/settings/personal/use-personal-computers";
import { ConfigurationStatusChip } from "@/components/settings/environment/status-chip";
import type { ConfigurationChipHost } from "@/components/settings/environment/status-chip-model";
import { hostConfigurationChip } from "@/components/settings/environment/status-chip-hosts";
import {
  poolConfigurationChip,
  poolReportPending,
} from "@/components/settings/environment/status-chip-pool-hosts";
import { chipPageKinds } from "@/components/settings/environment/status-chip-page-kinds";
import { useConfigurationSavingOffline } from "@/components/settings/environment/status-chip-mutations";
import { useDetailsRecovery } from "@/components/settings/details/use-details-recovery";
import { useDetailsEnvironmentId } from "@/components/settings/details/use-details-environment-id";
import { SettingsDetailsDialog } from "@/components/settings/details/settings-details-button";
import { hostQueryKeys } from "@/lib/query-keys";
import type { EnvironmentPick } from "@/lib/settings-environment-pages";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { Button } from "@/components/ui/button";
import { startVisibleInterval } from "@/lib/dom/visible-interval";

/** The cadence Personal pages poll `environment.status` at. */
const REPORTS_PENDING_REFRESH_MS = 5_000;

export interface PageChipProps {
  readonly section: SettingsSectionId;
  readonly pick: EnvironmentPick;
}

function PageChipContent(props: {
  readonly section: SettingsSectionId;
  readonly environmentId: string;
  readonly hosts: readonly ConfigurationChipHost[];
  /** The chip while no host runs the configuration. */
  readonly emptyText: string;
}): ReactNode {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const hostIds = useMemo(
    () => new Set(props.hosts.map((host) => host.hostId)),
    [props.hosts],
  );
  const savingOffline = useConfigurationSavingOffline(
    props.environmentId,
    hostIds,
  );
  const recovery = useDetailsRecovery();
  return (
    <>
      <ConfigurationStatusChip
        hosts={props.hosts}
        emptyText={props.emptyText}
        savingOffline={savingOffline}
        local={false}
        onDetails={() => setDetailsOpen(true)}
        onRecover={recovery.recover}
        recoveryPending={recovery.pending}
      />
      <SettingsDetailsDialog
        subject={{
          environmentId: props.environmentId,
          kind: "chip",
          key: props.section,
        }}
        title="Settings delivery"
        controls={null}
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
      />
    </>
  );
}

function PersonalPageChip(props: {
  readonly section: SettingsSectionId;
}): ReactNode {
  const scope = useHostScope();
  const client = useHostClient();
  const environmentId = useDetailsEnvironmentId(client);
  const queryClient = useQueryClient();
  const {
    computers: hosts,
    statuses,
    versions,
    participants,
  } = usePersonalComputers(true);
  const kinds = chipPageKinds(props.section);
  const chips = participants.map((host) => {
    const status = statuses.get(host.hostId) ?? null;
    const readAt =
      queryClient.getQueryState(
        hostQueryKeys.method<HostRpcRegistry, "environment.status">(
          host.hostId,
          "environment.status",
          {},
        ),
      )?.dataUpdatedAt ?? null;
    const lastReportedAt =
      readAt === null || status?.receiptAgeMs === null || status === null
        ? null
        : readAt - status.receiptAgeMs;
    return hostConfigurationChip({
      host,
      status,
      version: versions.get(host.hostId) ?? null,
      kinds,
      lastReportedAt,
    });
  });
  if (environmentId === null || scope.listsFailed || scope.isLoading)
    return null;
  if (
    chips.length === 0 &&
    hosts.some((host) => (statuses.get(host.hostId) ?? null) === null)
  )
    return null;
  return (
    <PageChipContent
      section={props.section}
      environmentId={environmentId}
      hosts={chips}
      emptyText="Not on any computer or sandbox"
    />
  );
}

function TeamPageChip(props: {
  readonly section: SettingsSectionId;
  readonly environmentId: string;
}): ReactNode {
  const client = useHostClient();
  const viewerUserId = useCloudChatViewerId();
  const hosts = useHostQuery<HostRpcRegistry, "environment.host.list">({
    client,
    method: "environment.host.list",
    params: { environmentId: props.environmentId },
    cacheKeyIdentity: [viewerUserId],
    options: { enabled: viewerUserId.length > 0 },
  });
  const hostIds = useMemo(
    () => hosts.data?.hosts.map((host) => host.hostId) ?? [],
    [hosts.data],
  );
  const versions = useHostNegotiatedMethodVersions(
    hostIds,
    "environment.status",
  );
  const kinds = chipPageKinds(props.section);
  // The method is unpolled; only an item still on its way needs a reread,
  // since nothing else tells the page the host finished.
  const pending =
    hosts.data?.hosts.some((host) => poolReportPending(host, kinds)) === true;
  const { refetch } = hosts;
  useEffect(() => {
    if (!pending) return;
    return startVisibleInterval({
      tick: () => {
        void refetch({ cancelRefetch: false });
      },
      intervalMs: REPORTS_PENDING_REFRESH_MS,
      fireOnShow: true,
    });
  }, [pending, refetch]);
  if (hosts.isError)
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => void hosts.refetch()}
      >
        Retry
      </Button>
    );
  if (hosts.data === undefined) return null;
  const chips = hosts.data.hosts.map((host) =>
    poolConfigurationChip(host, kinds, versions.get(host.hostId) ?? null),
  );
  return (
    <PageChipContent
      section={props.section}
      environmentId={props.environmentId}
      hosts={chips}
      emptyText="No hosts yet"
    />
  );
}

/** One delivery status for the page's configuration; Local has no delivery. */
export function PageChip(props: PageChipProps): ReactNode {
  if (props.pick.kind === "local" || props.section === "sandboxes") return null;
  if (props.pick.kind === "team")
    return (
      <TeamPageChip
        section={props.section}
        environmentId={props.pick.environmentId}
      />
    );
  return <PersonalPageChip section={props.section} />;
}
