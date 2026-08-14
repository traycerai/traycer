import { useMemo } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostInstalledRecord } from "@traycer-clients/shared/platform/runner-host";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useRemoteSessionsPollReadiness } from "@/hooks/host/use-remote-sessions-poll-readiness";
import { useRegisteredHosts } from "@/hooks/auth/use-registered-hosts-query";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useRemoteHostsPlanRestricted } from "@/hooks/host/use-remote-hosts-plan-gate";
import { useNowMs } from "@/components/settings/panels/host-settings-panel-hooks";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useLocalHostSnapshot } from "@/components/settings/panels/host-settings-panel-hooks";
import { deriveStatus } from "@/components/settings/panels/host-settings-panel-model";
import { getViewerReachabilityCheck } from "@/lib/host/viewer-reachability-store";
import {
  useHostBinding,
  useHostClient,
  type HostRpcRegistry,
} from "@/lib/host";
import { runnerQueryKeys } from "@/lib/query-keys/runner-mutation-keys";
import {
  deriveHostScopeStatus,
  hostListReadiness,
  type HostScopeStatus,
} from "@/components/settings/host-scope/host-scope-status";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import {
  buildHostScopeOptions,
  findHostOption,
  resolveScopedHost,
  transientClientEntry,
  type HostScopeOption,
} from "@/components/settings/host-scope/host-scope-model";

export interface HostScope {
  /** Every host this account owns or this client can dial, merged and sorted. */
  readonly hosts: readonly HostScopeOption[];
  /** The host being administered. `null` when there are no hosts, or `vanished`. */
  readonly host: HostScopeOption | null;
  readonly hostId: string | null;
  readonly hostLabel: string;
  /** The id that was picked but is no longer listed — only when `vanished`. */
  readonly vanishedHostId: string | null;
  /** Drop an explicit pick and follow the active host again. */
  readonly returnToActive: () => void;
  /** The app-wide active host — where new work lands and the bell reads from. */
  readonly activeHostId: string | null;
  readonly activeHost: HostScopeOption | null;
  /** True when the administered host is also the active one. */
  readonly isViewingActive: boolean;
  readonly status: HostScopeStatus;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly setHostId: (hostId: string) => void;
  /** Point this window's ambient work at the administered host. */
  readonly makeActive: (hostId: string) => void;
  readonly isLoading: boolean;
  /**
   * A host list came back as an ERROR, so an empty `hosts` means "we could not
   * find out", not "you own no machines". The difference is the whole message:
   * one is recoverable by retrying, the other by installing a host.
   */
  readonly listsFailed: boolean;
  /** Re-request both host lists after a failure. */
  readonly retryLists: () => void;
  /** Reference "now" for relative timestamps; ticks once a minute. */
  readonly nowMs: number;
}

/**
 * Stand-in `queryFn` for the disabled installed-record query.
 *
 * TanStack requires one even when `enabled` is false, and a rejecting stub is
 * the honest shape: if it ever runs, the `enabled` guard above it is wrong and
 * should fail loudly rather than resolve a fake `null` that would read as
 * "nothing is installed".
 */
function skipInstalledRecord(): Promise<HostInstalledRecord | null> {
  return Promise.reject(new Error("host management bridge unavailable"));
}

/**
 * The one host-scope hook for Settings. Every host-scoped panel reads this and
 * nothing else, which is what makes the sidebar switcher authoritative rather
 * than one more picker among five.
 */
export function useHostScope(): HostScope {
  const ambientClient = useHostClient();
  const binding = useHostBinding();
  const runnerHost = useRunnerHost();
  const activeHostId = useReactiveActiveHostId();
  const nowMs = useNowMs();

  const directoryQuery = useHostDirectoryList();
  const registryQuery = useRegisteredHosts();
  const localSnapshot = useLocalHostSnapshot(runnerHost);
  // Same gate the header and workspace pickers consult, so Settings cannot
  // offer a remote route the other two surfaces already refuse.
  const remoteHostsPlanRestricted = useRemoteHostsPlanRestricted();

  const scopedHostId = useSettingsHostScopeStore((s) => s.scopedHostId);
  const setScopedHostId = useSettingsHostScopeStore((s) => s.setScopedHostId);

  const directory = directoryQuery.data;
  const registry = registryQuery.data;

  // Which host id is THIS computer's, asked of the directory rather than of
  // `getLocalEntry()`.
  //
  // `getLocalEntry()` is backed by the live local snapshot, so it goes null the
  // moment the local host stops — exactly when "is this my machine?" has to
  // keep answering yes, because the answer gates install / restart / recovery.
  // The directory keeps answering: while the local host is down it presents the
  // registry twin carrying this machine's id as a non-dialable `kind: "local"`
  // entry (`bootingLocalEntry`). Reading the list is therefore the durable
  // question; the live entry is only a faster path to the same id.
  const localHostId = useMemo(() => {
    const fromDirectory = (directory ?? []).find(
      (entry) => entry.kind === "local",
    );
    if (fromDirectory !== undefined) return fromDirectory.hostId;
    return binding?.directory.getLocalEntry()?.hostId ?? null;
  }, [directory, binding]);

  // The installed record is what separates "stopped" from "not installed" — the
  // two local states a person can actually act on. Without it `deriveStatus`
  // can only answer `running` or `undefined`, and a stopped local host falls
  // through to its registry lease and reads "Offline · last seen 3h ago": true
  // of the lease, useless to someone whose host is sitting there stopped with a
  // Start button one click away.
  //
  // Same query key as the Host panel's, so the two share one request rather
  // than doubling it, and `enabled` keeps shells without the CLI bridge on the
  // old honest-`undefined` path instead of guessing.
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

  // Subscribed, not read ambiently: the session cache is pull-only, and the
  // memo below would otherwise keep answering with whatever was true at its
  // last directory/registry recompute - a session dying (or appearing) under
  // an `offline`/`local-only` entry would leave rows connectable/unreachable
  // until some unrelated input churned.
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

  const hosts = useMemo(
    () =>
      buildHostScopeOptions({
        directory: directory ?? [],
        registry: registry?.hosts ?? [],
        localHostId,
        activeHostId,
        localService,
        hasLiveSession,
        viewerCheck: getViewerReachabilityCheck,
        remoteHostsPlanRestricted,
        nowMs,
      }),
    [
      directory,
      registry,
      localHostId,
      activeHostId,
      localService,
      hasLiveSession,
      remoteHostsPlanRestricted,
      nowMs,
    ],
  );

  // `data !== undefined` rather than `!isLoading`, because a background refetch
  // of an already-resolved list must not re-open the "still loading" window and
  // un-say `vanished`. The rule itself — including that an error is an ANSWER —
  // lives in `hostListReadiness`, where a test can reach it.
  const lists = hostListReadiness(
    { hasData: directory !== undefined, isError: directoryQuery.isError },
    { hasData: registry !== undefined, isError: registryQuery.isError },
  );
  const listsResolved = lists.resolved;
  const listsFailed = lists.failed;

  // Still loading is not the same as gone, and a list that FAILED cannot prove
  // a host was removed. Both rules — and the reason the `vanished` verdict is
  // never allowed to resolve silently to the active host — live in
  // `resolveScopedHost`, where a test can reach them.
  const resolved = useMemo(
    () =>
      resolveScopedHost({
        hosts,
        scopedHostId,
        activeHostId,
        listsResolved,
        listsFailed,
      }),
    [hosts, scopedHostId, activeHostId, listsResolved, listsFailed],
  );

  const host = resolved.host;
  const isFollowing =
    resolved.vanishedHostId === null &&
    host !== null &&
    host.hostId === activeHostId;

  // Gated on `connectable`, not on the entry's mere existence: an unavailable
  // entry can still carry a stale URL, and a plan-restricted remote advertises
  // one the server will refuse, so keying on the entry built a live-looking
  // client for a host the status machine was about to call `unreachable`.
  // The rule itself lives in `transientClientEntry`, where a test can reach it.
  const overrideEntry = useMemo(
    () => transientClientEntry(host, isFollowing),
    [isFollowing, host],
  );
  const overrideClient = useHostClientFor(overrideEntry);

  // The transient client is built SYNCHRONOUSLY (`createRequester` is a Proxy),
  // so for a connectable host the only reason one comes back null is a missing
  // request context or unbound user. That is a credential gap, not a connection
  // in progress, and it must not render as a spinner that can never resolve.
  const hasRequestAuthority =
    ambientClient.getRequestContext() !== null &&
    ambientClient.getRequestContextUserId() !== null;

  const status = deriveHostScopeStatus({
    isFollowing,
    host,
    vanishedHostId: resolved.vanishedHostId,
    overrideClient,
    hasRequestAuthority,
    listsResolved,
  });

  return {
    hosts,
    host,
    hostId: host?.hostId ?? null,
    hostLabel: host?.name ?? resolved.vanishedHostId ?? "No host",
    vanishedHostId: resolved.vanishedHostId,
    returnToActive: () => setScopedHostId(null),
    activeHostId,
    activeHost: findHostOption(hosts, activeHostId),
    isViewingActive: isFollowing,
    status,
    // `overrideClient` is null for `connecting`, `unreachable` and `vanished`
    // — guaranteed by the `connectable` gate on `overrideEntry` above, not by
    // hope — so only the `following` branch may swap in the ambient client.
    // Any other branch handing back `ambientClient` would be the exact
    // substitution this status enum exists to make impossible.
    client: status === "following" ? ambientClient : overrideClient,
    setHostId: setScopedHostId,
    makeActive: (hostId: string) => {
      binding?.directory.selectById(hostId);
    },
    isLoading: directoryQuery.isLoading || registryQuery.isLoading,
    listsFailed,
    retryLists: () => {
      void directoryQuery.refetch();
      void registryQuery.refetch();
    },
    nowMs,
  };
}
