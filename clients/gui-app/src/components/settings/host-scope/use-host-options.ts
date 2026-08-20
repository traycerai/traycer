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
import { useRemoteHostsPlanRestricted } from "@/hooks/host/use-remote-hosts-plan-gate";
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

/**
 * THE answer to "what hosts does this account have, and can I reach them".
 *
 * Every host picker in the app reads this and nothing else. It used to be
 * private to `useHostScopeFor`, which meant Settings answered the question from
 * the merged view (directory + account registry + this machine's own service)
 * while the composer, the file tree, the git-diff panel and the terminal picker
 * answered it from the raw directory alone. The two lists disagreed by design:
 * a host you own but cannot currently dial existed in one and simply did not
 * exist in the others, so "my other laptop is gone" and "my other laptop is
 * offline" were the same picture depending on which picker you happened to open.
 *
 * What a surface DOES with a listed host still differs — see `HostPickIntent` —
 * but which hosts exist no longer does.
 */
export interface HostOptions {
  /** Every host this account owns or this client can dial, merged and sorted. */
  readonly hosts: readonly HostScopeOption[];
  /** The app-wide active host — where new work lands and the bell reads from. */
  readonly activeHostId: string | null;
  readonly isLoading: boolean;
  /**
   * The DIRECTORY has answered (an error is an answer) — i.e. we know which
   * hosts this client can dial right now.
   *
   * It is separate from `listsResolved` because the two lists do not carry the
   * same weight for every surface. The registry can only ever ADD rows that
   * cannot be dialled, so a surface whose whole job is to point the app at a
   * host must not wait on a cloud call to show the machine sitting on the desk.
   * Gating the Select host dialog on `isLoading` (which folds in the registry
   * query) left it spinning "Loading hosts…" over a resolved, non-empty
   * directory whenever that call was slow or refused — which is exactly when a
   * person is most likely to be opening it.
   */
  readonly directoryResolved: boolean;
  /** The directory request itself failed — nothing dialable could be listed. */
  readonly directoryFailed: boolean;
  /**
   * Both lists have ANSWERED (an error is an answer). Callers that decide a
   * host is gone must wait for this, or a slow request reads as a removal.
   */
  readonly listsResolved: boolean;
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
 * Whether a mutation lane's KIND brings the local host UP - the sense M5's
 * row means by "setting up or starting". `deregister`, `uninstallHost` and
 * `removeTraycer` are TEARDOWN lanes: they are just as busy, but crediting
 * them with "setting up" tells the person watching the row the opposite of
 * what is happening to their machine.
 *
 * Exhaustive over `MutationKind` (not an exclude-list) so a new lane kind
 * fails to compile here naming its missing arm, rather than silently
 * defaulting to one reading or the other.
 */
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
  // The SELECTION, not addressability. `useAddressableHostId()` answers
  // "is the derived host addressable yet" and goes `null` while its directory
  // row is still resolving; every picker here is narrating which host the
  // authority chose, so the tag and the sort must not blink off for the length
  // of a directory round trip. That distinction is P4.2's, written at the
  // hook - narrators take this one, gates take that one - and this file is a
  // narrator in all four of its consumers.
  const activeHostId = useEffectiveHostId();
  const nowMs = useNowMs();

  const directoryQuery = useHostDirectoryList();
  const registryQuery = useRegisteredHosts();
  const localSnapshot = useLocalHostSnapshot(runnerHost);
  // Same gate the header and workspace pickers consult, so no picker can offer
  // a remote route another one already refuses.
  const remoteHostsPlanRestricted = useRemoteHostsPlanRestricted();

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
  // two local states worth telling apart (one is being restarted for the user,
  // the other installed; a removed one gets Reinstall). Without it
  // `deriveStatus` can only answer `running` or `undefined`, and a stopped
  // local host falls through to its registry lease and reads "Offline · last
  // seen 3h ago": true of the lease, useless to someone whose host is sitting
  // right there on this machine.
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

  // M5's "setting up" row state, sourced HERE rather than in the row component.
  // Every picker suite mocks this module wholesale, so a runner-host read down
  // in the row sat below that boundary and threw in each of them while
  // production was fine - the fact belongs where its siblings
  // (`connectable`, `health`) are built. Actor-agnostic by construction: the
  // lane is the host controller's own, so it is busy whether the desktop's
  // launch reconciler, the authority's ensure, or a user's Retry asked.
  //
  // Read the SAME status source `useHostProvisioningProgress` reads (the
  // controller status query), not that hook itself: its view answers "what
  // copy names this lane", which is total over every kind including the
  // teardown ones, and going through it here would lose the KIND this row
  // needs to tell "being installed or started" apart from "being removed".
  const provisioningLaneKind =
    useRunnerHostControllerStatusQuery().data?.mutation?.kind ?? null;
  const localHostSettingUp =
    provisioningLaneKind !== null && mutationBringsHostUp(provisioningLaneKind);

  // The authority's own verdicts, and the flag that says whether it has
  // reached any. These are what make every row below say the same thing the
  // tiles say: `use-host-lease.ts` has carried the rule as a doc comment since
  // P3.3 - all status UI derives from the lease vocabulary, no surface reads
  // sockets, probe caches or the cloud DTO directly - and until this read
  // existed, Settings and the pickers were the sentence's counterexample.
  //
  // `attached` is threaded beside the leases rather than inferred from an
  // empty array: before the bridge mounts EVERY host has no lease, and a
  // derivation that could not tell that apart from a real verdict would blank
  // the fleet on every cold start.
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
        remoteHostsPlanRestricted,
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
