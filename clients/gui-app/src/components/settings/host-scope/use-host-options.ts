import { useMemo } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import type {
  HostInstalledRecord,
  MutationKind,
} from "@traycer-clients/shared/platform/runner-host";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useRemoteSessionsPollReadiness } from "@/hooks/host/use-remote-sessions-poll-readiness";
import { useRunnerHostControllerStatusQuery } from "@/hooks/runner/use-runner-host-controller-status-query";
import { useRegisteredHosts } from "@/hooks/auth/use-registered-hosts-query";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostLeases } from "@/hooks/host/use-host-lease";
import { useSelectionAuthorityAttached } from "@/hooks/host/use-selection-authority-attached";
import { useNowMs } from "@/components/settings/panels/host-settings-panel-hooks";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useLocalHostSnapshot } from "@/components/settings/panels/host-settings-panel-hooks";
import { deriveStatus } from "@/components/settings/panels/host-settings-panel-model";
import { useHostBinding } from "@/lib/host";
import { runnerQueryKeys } from "@/lib/query-keys/runner-mutation-keys";
import {
  buildHostScopeOptions,
  type HostScopeOption,
} from "@/components/settings/host-scope/host-scope-model";
import { hostListReadiness } from "@/components/settings/host-scope/host-scope-status";

/** The two lists disagreed by design: a host you own but cannot currently dial existed in one and simply did
 * not exist in the others. */
export interface HostOptions {
  readonly hosts: readonly HostScopeOption[];
  readonly activeHostId: string | null;
  readonly isLoading: boolean;
  /** The registry can only ever add rows that cannot be dialled, so a surface whose whole job is to point the app
   * at a host must not wait on a cloud call to show the machine sitting on the desk. */
  readonly directoryResolved: boolean;
  readonly directoryFailed: boolean;
  /** Callers that decide a host is gone must wait for this, or a slow request reads as a removal. */
  readonly listsResolved: boolean;
  /** A host list came back as an error, so an empty `hosts` means "we could not find out", not "you own no
   * machines". */
  readonly listsFailed: boolean;
  /** Re-request both host lists after a failure. */
  readonly retryLists: () => void;
  readonly nowMs: number;
}

/** TanStack requires one even when `enabled` is false, and a rejecting stub is the honest shape. */
function skipInstalledRecord(): Promise<HostInstalledRecord | null> {
  return Promise.reject(new Error("host management bridge unavailable"));
}

/** Exhaustive over `MutationKind` (not an exclude-list) so a new lane kind fails to compile here naming its
 * missing arm, rather than silently defaulting to one reading or the other. */
function mutationBringsHostUp(kind: MutationKind): boolean {
  switch (kind) {
    case "ensure":
    case "apply":
    case "activate":
    case "install":
    case "register":
    case "respawn":
    case "recoverIfDown":
    case "freePortAndRestart":
      return true;
    case "deregister":
    case "uninstallHost":
    case "removeTraycer":
      return false;
  }
}

export function useHostOptions(): HostOptions {
  const binding = useHostBinding();
  const runnerHost = useRunnerHost();
  // `useAddressableHostId` answers "is the derived host addressable yet" and goes `null` while its directory row
  // is still resolving.
  const activeHostId = useEffectiveHostId();
  const nowMs = useNowMs();

  const directoryQuery = useHostDirectoryList();
  const registryQuery = useRegisteredHosts();
  const localSnapshot = useLocalHostSnapshot(runnerHost);
  const directory = directoryQuery.data;
  const registry = registryQuery.data;

  // Which host id is this computer's, asked of the directory rather than of `getLocalEntry`. Reading the list is
  // therefore the durable question; the live entry is only a faster path to the same id.
  const localHostId = useMemo(() => {
    const fromDirectory = (directory ?? []).find(
      (entry) => entry.kind === "local",
    );
    if (fromDirectory !== undefined) return fromDirectory.hostId;
    return binding?.directory.getLocalEntry()?.hostId ?? null;
  }, [directory, binding]);

  // Same query key as the Host panel's, so the two share one request rather than doubling it, and `enabled`
  // keeps shells without the CLI bridge on the old honest-`undefined` path instead of guessing.
  const management = runnerHost.hostManagement;
  const installedQuery = useQuery(
    queryOptions<HostInstalledRecord | null>({
      queryKey:
        management === null
          ? runnerQueryKeys.hostInstalledRecordUnavailable()
          : runnerQueryKeys.hostInstalledRecord(management),
      queryFn:
        management === null
          ? skipInstalledRecord
          : () => management.installedRecord(),
      enabled: management !== null,
      staleTime: 30_000,
    }),
  );

  const localService = useMemo(
    () => deriveStatus(localSnapshot, installedQuery.data),
    [localSnapshot, installedQuery.data],
  );

  // Subscribed, not read ambiently: the session cache is pull-only, and the memo below would otherwise keep
  // answering with whatever was true at its last directory/registry recompute.
  const scopeHostIds = useMemo(
    () => [
      ...new Set([
        ...(directory ?? []).map((entry) => entry.hostId),
        ...(registry?.hosts ?? []).map((item) => item.hostId),
      ]),
    ],
    [directory, registry],
  );
  const hasLiveSession = useRemoteSessionsPollReadiness(scopeHostIds);

  // "setting up" row state, sourced here rather than in the row component.
  const provisioningLaneKind =
    useRunnerHostControllerStatusQuery().data?.mutation?.kind ?? null;
  const localHostSettingUp =
    provisioningLaneKind !== null && mutationBringsHostUp(provisioningLaneKind);

  // `attached` is threaded beside the leases rather than inferred from an empty array.
  const leases = useHostLeases();
  const authorityAttached = useSelectionAuthorityAttached();

  const hosts = useMemo(
    () =>
      buildHostScopeOptions({
        directory: directory ?? [],
        registry: registry?.hosts ?? [],
        localHostId,
        activeHostId,
        localService,
        hasLiveSession,
        leases,
        authorityAttached,
        localHostSettingUp,
        nowMs,
      }),
    [
      directory,
      registry,
      localHostId,
      activeHostId,
      localService,
      hasLiveSession,
      leases,
      authorityAttached,
      localHostSettingUp,
      nowMs,
    ],
  );

  // `data !== undefined` rather than `!isLoading`, because a background refetch of an already-resolved list must
  // not re-open the "still loading" window and un-say `vanished`.
  const lists = hostListReadiness(
    { hasData: directory !== undefined, isError: directoryQuery.isError },
    { hasData: registry !== undefined, isError: registryQuery.isError },
  );

  return {
    hosts,
    activeHostId,
    isLoading: directoryQuery.isLoading || registryQuery.isLoading,
    directoryResolved: directory !== undefined || directoryQuery.isError,
    directoryFailed: directoryQuery.isError,
    listsResolved: lists.resolved,
    listsFailed: lists.failed,
    retryLists: () => {
      void directoryQuery.refetch();
      void registryQuery.refetch();
    },
    nowMs,
  };
}
