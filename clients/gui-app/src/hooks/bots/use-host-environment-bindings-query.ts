import { useCallback, useMemo } from "react";
import {
  queryOptions,
  useQueries,
  useQueryClient,
  type QueryKey,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  EnvironmentHostBinding,
  EnvironmentHostReadRequest,
} from "@traycer/protocol/host/environment/contracts";
import type { EnvironmentStatusResponseV12 } from "@traycer/protocol/host/environment-schemas";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { readProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import {
  resolveNamedHostClient,
  resolvePoolTierHostClient,
} from "@/lib/host/binding-host-client";
import { hostQueryKeys } from "@/lib/query-keys";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { useConnectableHostIds } from "@/hooks/host/use-connectable-host-ids";
import { useHostNegotiatedMethodVersions } from "@/hooks/host/use-host-negotiated-method-version";
import { environmentStatusQueryOptions } from "@/hooks/environment/use-registered-host-environment-statuses";
import { localRowCohort } from "@/components/settings/environment/local-row-cohort";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";

const HOST_READ_METHOD = "environment.host.read";
const POOL_READ_METHOD = "environment.binding.read";
const EMPTY_PARAMS: EnvironmentHostReadRequest = {};
const BINDING_STALE_MS = 30_000;

/**
 * Whether this build reads a named host's binding from the server pool
 * (`environment.binding.read`) rather than asking that host for its own
 * (`environment.host.read`). A fact of the build, read from the frozen tier
 * plan and never from reachability: without a pool, a pool-only method goes
 * to the caller's host, and no host serves this one.
 */
export function readsHostBindingsFromPool(): boolean {
  return readProcessHostRpcTierPlan().pool !== null;
}

/**
 * The cache entry every reader of `hostId`'s binding shares in this build,
 * which a bind writes through: the pool's answer for this viewer, or, without
 * a pool, the host's own answer under that host's scope.
 */
export function hostEnvironmentBindingQueryKey(
  hostId: string,
  viewerUserId: string,
): QueryKey {
  if (readsHostBindingsFromPool()) {
    return hostQueryKeys.environmentBindingForViewer(
      POOL_HOST_ID,
      hostId,
      viewerUserId,
    );
  }
  return hostQueryKeys.method<HostRpcRegistry, typeof HOST_READ_METHOD>(
    hostId,
    HOST_READ_METHOD,
    EMPTY_PARAMS,
  );
}

export interface HostEnvironmentBindings {
  /** Each answering host's binding, keyed by the host it was asked of. */
  readonly byHostId: ReadonlyMap<string, EnvironmentHostBinding>;
  /**
   * Hosts that run their own settings, by their own `environment.status`
   * (the picker's Local row). They are in no environment, so they are in
   * neither `byHostId` nor `failedHostIds`: never a binding, never Personal,
   * and never a failure. Their binding is not read.
   */
  readonly ownSettingsHostIds: ReadonlyArray<string>;
  /**
   * Hosts whose read FAILED (refused, timed out, unreachable mid-read). They
   * are not in `byHostId`, and a surface that lists candidates by binding
   * says so rather than silently leaving them out - a host that could not be
   * asked is not a host that runs some other environment.
   */
  readonly failedHostIds: ReadonlyArray<string>;
  /**
   * Asks the failed hosts again: the status of a host whose status failed
   * (its binding follows from the answer), the binding of one whose binding
   * failed. A no-op when none failed.
   */
  readonly retryFailed: () => void;
}

/**
 * SEVERAL hosts' bindings at once - the create form's question "which of my
 * hosts run this environment?" (Tracy Bots) and Settings' host labels. One
 * query per host under {@link hostEnvironmentBindingQueryKey}, so the answer
 * coalesces with the Settings picker's read of the same host and takes its
 * bind. In a build with a pool every row is read from the pool, which needs
 * no connection to the host; without one each host is asked for its own,
 * resolved by name through the binding seam, never by borrowing the
 * subtree's ambient host identity.
 *
 * A host's own `environment.status` comes first: one that runs its own
 * settings is in no environment, which the pool would answer as Personal and
 * the host itself refuses to answer at all. So its status is read, and its
 * binding is not used, before either. Without a pool the binding is asked
 * only once the status has said otherwise, of the same host, so the host is
 * never asked for a binding it refuses. With a pool the status is read for
 * the hosts this client can dial, and the pool's answer for one of them
 * waits for it; a host this client cannot dial, or whose status predates the
 * method, keeps the binding alone, as before. A status read that fails is a
 * failed host, never the pool's Personal.
 */
export function useHostEnvironmentBindings(
  hostIds: ReadonlyArray<string>,
  enabled: boolean,
): HostEnvironmentBindings {
  const binding = useHostBinding();
  const viewerUserId = useCloudChatViewerId();
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const fromPool = readsHostBindingsFromPool();
  const connectable = useConnectableHostIds();
  const idsKey = hostIds.join("\n");
  const hostIdList = useMemo(
    () => idsKey.split("\n").filter((id) => id.length > 0),
    [idsKey],
  );
  // Whose status is read: every host without a pool (the binding is asked
  // of the host anyway), and with one the hosts this client can dial, once
  // the directory has said which those are.
  const readsStatus = useCallback(
    (hostId: string): boolean =>
      !fromPool ||
      (connectable.resolved && connectable.hostIds.includes(hostId)),
    [connectable.hostIds, connectable.resolved, fromPool],
  );
  // A host the directory has not placed yet is waited for, not read alone.
  // With no runtime to ask, nothing is waited for: the binding read reports
  // that it has no client, as it always did.
  const awaitsStatus = useCallback(
    (hostId: string): boolean =>
      binding !== null && (!connectable.resolved || readsStatus(hostId)),
    [binding, connectable.resolved, readsStatus],
  );
  // A status read that errors on a host whose completed handshake lacks the
  // method is a host too old to answer, not a failure: its binding answers
  // alone. A host with no completed handshake is not known to be old, so
  // its failed status stays failed.
  const statusVersions = useHostNegotiatedMethodVersions(
    hostIdList,
    "environment.status",
  );
  // Joined into one string so a re-render that changed no answer keeps the
  // bindings' `combine` below, and what it returns, the same.
  const combineStatuses = useCallback(
    (results: Array<UseQueryResult<EnvironmentStatusResponseV12>>): string =>
      results
        .map((result, index) => {
          const hostId = hostIdList[index] ?? "";
          const answer = hostStatusAnswer(result, awaitsStatus(hostId));
          return answer === "failed" && statusVersions.get(hostId) === false
            ? "other"
            : answer;
        })
        .join("\n"),
    [awaitsStatus, hostIdList, statusVersions],
  );
  const statusKey = useQueries({
    queries: hostIdList.map((hostId) =>
      environmentStatusQueryOptions(
        binding,
        hostId,
        enabled && binding !== null && readsStatus(hostId),
      ),
    ),
    combine: combineStatuses,
  });
  const statusAnswers = useMemo(
    () => statusKey.split("\n").map(parseHostStatusAnswer),
    [statusKey],
  );
  const queryClient = useQueryClient();
  // Once the status answers, the binding follows from it: no-pool reads turn
  // on for a host somewhere else, and the pool's answer is already held.
  const refetchStatus = useCallback(
    (hostId: string): Promise<void> =>
      queryClient.refetchQueries({
        queryKey: environmentStatusQueryOptions(binding, hostId, true).queryKey,
        exact: true,
      }),
    [binding, queryClient],
  );
  const combine = useCallback(
    (
      results: Array<UseQueryResult<EnvironmentHostBinding>>,
    ): HostEnvironmentBindings => {
      const byHostId = new Map<string, EnvironmentHostBinding>();
      const ownSettingsHostIds: string[] = [];
      const failedHostIds: string[] = [];
      const failedRetries: Array<() => Promise<unknown>> = [];
      // Positional, and safe by construction: `useQueries` returns results in
      // the order the queries were given, so index `n` is `hostIdList[n]`.
      results.forEach((result, index) => {
        if (index >= hostIdList.length) return;
        const hostId = hostIdList[index];
        const status = statusAnswers[index];
        if (status === "own_settings") {
          ownSettingsHostIds.push(hostId);
        } else if (status === "unsettled") {
          // Not yet known: neither a binding nor a failure.
        } else if (status === "failed") {
          failedHostIds.push(hostId);
          failedRetries.push(() => refetchStatus(hostId));
        } else if (result.data !== undefined) {
          byHostId.set(hostId, result.data);
        } else if (result.status === "error") {
          // The status that let the binding be asked is re-read too: a host
          // moved to its own settings since then is no longer asked.
          failedHostIds.push(hostId);
          failedRetries.push(() =>
            Promise.all([refetchStatus(hostId), result.refetch()]),
          );
        }
      });
      return {
        byHostId,
        ownSettingsHostIds,
        failedHostIds,
        retryFailed: () => {
          for (const retry of failedRetries) void retry();
        },
      };
    },
    [hostIdList, refetchStatus, statusAnswers],
  );
  return useQueries({
    queries: hostIdList.map((hostId, index) =>
      // `binding` only resolves the client, whose answer the key already
      // names (the pool's for this viewer, or `hostId`'s own); adding it
      // would refetch on binding identity drift alone. `fromPool` is fixed
      // for the process.
      // eslint-disable-next-line @tanstack/query/exhaustive-deps
      queryOptions({
        queryKey: hostEnvironmentBindingQueryKey(hostId, viewerUserId),
        queryFn: ({ signal }): Promise<EnvironmentHostBinding> => {
          if (fromPool) {
            return withHostQueryErrorBoundary(POOL_READ_METHOD, async () => {
              cloudVerdictPreflight(POOL_READ_METHOD)();
              if (binding === null) {
                throw hostClientUnavailableError(POOL_READ_METHOD);
              }
              const client = resolvePoolTierHostClient(binding.hostClient);
              return client.requestWithSignal(
                POOL_READ_METHOD,
                { hostId },
                signal,
              );
            });
          }
          return withHostQueryErrorBoundary(HOST_READ_METHOD, async () => {
            const client = resolveNamedHostClient(binding, hostId);
            if (client === null) {
              throw hostClientUnavailableError(HOST_READ_METHOD);
            }
            return client.requestWithSignal(
              HOST_READ_METHOD,
              EMPTY_PARAMS,
              signal,
            );
          });
        },
        // The pool's answer is the account's: wait for the viewer it is
        // filed under, and for a session the cloud has verified. The host's
        // own is asked only once its status has said it is in an
        // environment.
        enabled:
          enabled &&
          (fromPool
            ? cloudAuthorized && viewerUserId.length > 0
            : statusAnswers[index] === "other"),
        staleTime: BINDING_STALE_MS,
        refetchOnWindowFocus: false,
      }),
    ),
    combine,
  });
}

/**
 * What a host's own `environment.status` says for its binding: it runs its
 * own settings, it is somewhere else (`other`), it has not said yet, or its
 * read `failed`. A failed status is a failed read, never "no answer": the
 * pool would name an unbound host Personal, and that host may run its own
 * settings. A host that is not waited for (`awaited` false), such as one
 * whose status predates the method, is `other` at once, and the binding
 * alone answers for it.
 */
export type HostStatusAnswer =
  | "own_settings"
  | "other"
  | "unsettled"
  | "failed";

export function hostStatusAnswer(
  result: UseQueryResult<EnvironmentStatusResponseV12>,
  awaited: boolean,
): HostStatusAnswer {
  if (!awaited) return "other";
  if (result.status === "error") return "failed";
  if (result.data === undefined) return "unsettled";
  return localRowCohort(result.data).kind === "local"
    ? "own_settings"
    : "other";
}

function parseHostStatusAnswer(value: string): HostStatusAnswer {
  if (value === "own_settings" || value === "unsettled" || value === "failed") {
    return value;
  }
  return "other";
}
