import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostScope } from "@/components/settings/host-scope/use-host-scope";
import { useHostNegotiatedMethodVersions } from "@/hooks/host/use-host-negotiated-method-version";
import { usePersonalComputers } from "@/components/settings/personal/use-personal-computers";
import { ConfigurationStatusChip } from "@/components/settings/environment/status-chip";
import {
  APPLYING_BOUND_MS,
  withUnconfirmedHosts,
  type ConfigurationChipHost,
} from "@/components/settings/environment/status-chip-model";
import type {
  HostsRunningConfiguration,
  RunningHost,
} from "@/components/settings/environment/hosts-running-configuration-model";
import {
  useHostsRunningConfiguration,
  useHostsRunningPersonal,
} from "@/components/settings/environment/use-hosts-running-configuration";
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

const NONE: ReadonlySet<string> = new Set();

/**
 * The hosts that have read `applying`, the same set of them without a
 * break, for {@link APPLYING_BOUND_MS}. Any change to the set starts the
 * wait again.
 */
function useUnconfirmedHosts(
  hosts: readonly ConfigurationChipHost[],
): ReadonlySet<string> {
  const applying = hosts
    .filter((host) => host.state === "applying")
    .map((host) => host.hostId)
    .join("\n");
  const [expired, setExpired] = useState<string | null>(null);
  useEffect(() => {
    if (applying.length === 0) return undefined;
    const timer = setTimeout(() => setExpired(applying), APPLYING_BOUND_MS);
    return () => {
      clearTimeout(timer);
      setExpired(null);
    };
  }, [applying]);
  return useMemo(
    () =>
      applying.length > 0 && expired === applying
        ? new Set(applying.split("\n"))
        : NONE,
    [applying, expired],
  );
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
  const unconfirmed = useUnconfirmedHosts(props.hosts);
  return (
    <>
      <ConfigurationStatusChip
        hosts={withUnconfirmedHosts(props.hosts, unconfirmed)}
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
        initialTab="status"
      />
    </>
  );
}

/** A running host's cloud report, as the pool chip reads one. */
function cloudReport(host: RunningHost) {
  return {
    hostId: host.hostId,
    hostLabel: host.name,
    lastReportedAt: host.lastReportedAt,
    applied: host.applied,
  };
}

/**
 * Rereads the host list while a host's cloud report still has an item on its
 * way: the method is unpolled, and nothing else tells the page the host
 * finished.
 */
function useRereadWhilePending(
  running: HostsRunningConfiguration,
  kinds: ReadonlySet<string> | null,
  reported: (host: RunningHost) => boolean,
): void {
  const pending = running.hosts.some(
    (host) => reported(host) && poolReportPending(cloudReport(host), kinds),
  );
  const { reread } = running;
  useEffect(() => {
    if (!pending) return;
    return startVisibleInterval({
      tick: reread,
      intervalMs: REPORTS_PENDING_REFRESH_MS,
      fireOnShow: true,
    });
  }, [pending, reread]);
}

/**
 * Personal's chip over THE hosts running Personal
 * (`useHostsRunningPersonal`). A host this window reads `environment.status`
 * from is judged by that status, which is live; any other by its last report
 * to the cloud. While the list has not answered, or cannot be read, the chip
 * claims nothing: a failed read is not "no computer runs Personal".
 */
function PersonalPageChip(props: {
  readonly section: SettingsSectionId;
}): ReactNode {
  const scope = useHostScope();
  const client = useHostClient();
  const environmentId = useDetailsEnvironmentId(client);
  const queryClient = useQueryClient();
  const running = useHostsRunningPersonal(true);
  const { statuses, versions } = usePersonalComputers(true);
  const kinds = chipPageKinds(props.section);
  const statusOf = (host: RunningHost) => statuses.get(host.hostId) ?? null;
  useRereadWhilePending(running, kinds, (host) => statusOf(host) === null);
  const chips = running.hosts.map((host) => {
    const status = statusOf(host);
    const version = versions.get(host.hostId) ?? null;
    if (status === null)
      return poolConfigurationChip(cloudReport(host), kinds, version);
    const readAt =
      queryClient.getQueryState(
        hostQueryKeys.method<HostRpcRegistry, "environment.status">(
          host.hostId,
          "environment.status",
          {},
        ),
      )?.dataUpdatedAt ?? null;
    const lastReportedAt =
      readAt === null || status.receiptAgeMs === null
        ? null
        : readAt - status.receiptAgeMs;
    return hostConfigurationChip({
      host: { hostId: host.hostId, name: host.name },
      status,
      version,
      kinds,
      lastReportedAt,
    });
  });
  if (
    environmentId === null ||
    scope.listsFailed ||
    scope.isLoading ||
    running.state !== "ready"
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
  const running = useHostsRunningConfiguration(
    {
      kind: "team",
      environmentId: props.environmentId,
    },
    true,
  );
  const hostIds = useMemo(
    () => running.hosts.map((host) => host.hostId),
    [running.hosts],
  );
  const versions = useHostNegotiatedMethodVersions(
    hostIds,
    "environment.status",
  );
  const kinds = chipPageKinds(props.section);
  useRereadWhilePending(running, kinds, () => true);
  if (running.state === "failed")
    return (
      <Button type="button" variant="ghost" size="sm" onClick={running.retry}>
        Retry
      </Button>
    );
  if (running.state === "loading") return null;
  const chips = running.hosts.map((host) =>
    poolConfigurationChip(
      cloudReport(host),
      kinds,
      versions.get(host.hostId) ?? null,
    ),
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
