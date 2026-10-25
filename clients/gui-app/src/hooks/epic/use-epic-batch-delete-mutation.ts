import { useCallback, useMemo } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  useMutationState,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { BatchDeleteItemResult } from "@traycer/protocol/host/epic/unary-schemas";
import {
  useHostBinding,
  useHostClient,
  type HostRpcRegistry,
} from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { activeHostIdOrNull } from "@/lib/host/runtime";
import { readLocalHostIdSnapshot } from "@/lib/host/local-host-id-snapshot";
import {
  readSelectionFleetSnapshot,
  routeOwnerGoneWrite,
} from "@/lib/host/owner-gone-write-routing";
import type { SurfacePinFleetView } from "@/stores/host/surface-host-selection-store";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { hostQueryKeys, epicMutationKeys } from "@/lib/query-keys";
import { invalidateWorktreeListingAndBindingCaches } from "@/hooks/worktree/invalidations";
import { useWorktreeDeleteStreamTransportFactory } from "@/lib/host/use-worktree-delete-stream-transport";
import {
  runWorktreeCleanup,
  worktreeCleanupFailureDetail,
  type WorktreeCleanupOutcome,
} from "@/lib/epics/run-worktree-cleanup";
import {
  OWNER_HOST_UNREACHABLE_NOTICE,
  isOwnerHostUnreachableFailure,
  toastFromOwnerHostWriteError,
} from "@/lib/owner-host-write-error-toast";
import { progressToast } from "@/lib/toast/progress-toast";
import { LANDING_ROUTE } from "@/lib/routes";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import {
  readEpicTitlesFromCloudTaskCaches,
  removeDeletedEpicsFromCloudTaskCaches,
  type CloudEpicTasksCacheScope,
} from "@/lib/cloud-epic-tasks-query/cache";
import { publishDeletedEpicNotification } from "@/lib/epics/deleted-epic-events";
import {
  clearDeletedEpicRunSettings,
  epicIdsLostInWindow,
} from "@/lib/epics/deleted-epic-scope";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { pickNeighborAfterRemovingTabs } from "@/stores/tabs/neighbor";
import { tabResolveIntent } from "@/stores/tabs/registry";
import type { HeaderTab } from "@/stores/tabs/types";
import { getHeaderTabs } from "@/stores/tabs/use-header-tabs";
import {
  reportableErrorToast,
  reportableWarningToast,
} from "@/lib/reportable-error-toast";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

interface BatchDeleteEpicMutationContext {
  /** The active host: the scope the person deleted from. */
  readonly hostId: string | null;
  /** Where the call goes - the active host, or a live host standing in for it. */
  readonly destination: EpicBatchDeleteDestination;
  /**
   * The host that enacts the delete, decided once with the destination: the
   * active host on a direct route, the stand-in on a fallback.
   * Every host-scoped follow-up (tombstone, the cross-window notice, the
   * cache refresh) is keyed to it, never to `hostId` alone.
   */
  readonly enactingHostId: string | null;
  readonly userId: string | null;
  readonly epicTitlesById: Readonly<Record<string, string>>;
  /**
   * The progress toast this dispatch put up in `onMutate`. The confirm dialog
   * closes at kickoff, so this toast is what stays in front of the person
   * while the host deletes - on whatever surface they have moved to by then.
   * Per dispatch, because two batches can be in flight at once.
   */
  readonly progressToastId: string;
}

let epicDeleteProgressToastSequence = 0;

function nextEpicDeleteProgressToastId(): string {
  epicDeleteProgressToastSequence += 1;
  return `epic-delete-progress:${epicDeleteProgressToastSequence}`;
}

/**
 * One approved worktree-cleanup candidate. `ownerEpicIds` lets `onSuccess`
 * re-confirm — once the batch result is known — that EVERY owner actually
 * succeeded before removing the worktree, so a partial-failure never deletes a
 * worktree still referenced by a Task that failed to delete.
 */
export interface BatchDeleteWorktreeCandidate {
  readonly worktreePath: string;
  readonly ownerEpicIds: ReadonlyArray<string>;
}

/**
 * Mutation variables. `worktreeCleanup` is `null` when the user approved no
 * worktrees (or none were offered), in which case the flow is identical to
 * before this feature. The wire request carries only `ids`.
 */
export interface BatchDeleteEpicVariables {
  readonly ids: ReadonlyArray<string>;
  /**
   * Whether a Task's row is local-homed right now, asked when the request is
   * built rather than recorded at confirm: a local row can finish promotion
   * to cloud while the person confirms or the mutation starts. Never sent on
   * the wire. Also read when the active host is down: a local-homed Task
   * exists on that machine alone, so no other host can delete it.
   */
  readonly isLocalHomedNow: (epicId: string) => boolean;
  /**
   * The account the selection and the confirm dialog were built under (the
   * host client's request identity then). The request is refused at send when
   * the host client would carry it as anyone else: a delete chosen under one
   * account must never be carried out as another. `null` when there was no
   * signed-in identity to bind to, which no request can match.
   */
  readonly boundUserId: string | null;
  readonly worktreeCleanup: {
    readonly candidates: ReadonlyArray<BatchDeleteWorktreeCandidate>;
  } | null;
}

/**
 * Where one `epic.batchDelete` dispatch goes.
 *
 * - `direct`: the active host, every id - what this hook always did, and still
 *   does while the active host can serve, or when no other host is live.
 * - `fallback`: the active host is down and another host is live. That host
 *   deletes the cloud-homed ids from the account; the local-homed ids exist
 *   only on the down host and are refused (`refusedIds`).
 * - `refused`: as `fallback`, but every id is local-homed, so nothing is sent.
 */
export type EpicBatchDeleteRoute =
  | {
      readonly kind: "direct";
      readonly hostId: string | null;
      readonly sentIds: ReadonlyArray<string>;
      readonly refusedIds: ReadonlyArray<string>;
    }
  | {
      readonly kind: "fallback";
      readonly hostId: string;
      readonly sentIds: ReadonlyArray<string>;
      readonly refusedIds: ReadonlyArray<string>;
    }
  | {
      readonly kind: "refused";
      readonly hostId: null;
      readonly sentIds: ReadonlyArray<string>;
      readonly refusedIds: ReadonlyArray<string>;
    };

/**
 * The host one `epic.batchDelete` dispatch is sent to, decided ONCE, when the
 * mutation starts (`onMutate`), and shared by the client choice and every
 * lifecycle callback.
 *
 * - `direct`: the active host - while its session can serve, or when no
 *   other host is live.
 * - `fallback`: the active host is down and `hostId` is a live host that
 *   stands in for it.
 */
export type EpicBatchDeleteDestination =
  | { readonly kind: "direct"; readonly hostId: string | null }
  | { readonly kind: "fallback"; readonly hostId: string };

/**
 * {@link EpicBatchDeleteDestination} for one dispatch. The active host keeps
 * the call while its session can serve; when it cannot, this machine's host is
 * tried first and then any other live host of the account
 * (`routeOwnerGoneWrite`).
 */
export function chooseEpicBatchDeleteDestination(args: {
  readonly activeHostId: string | null;
  readonly fleet: SurfacePinFleetView;
  readonly localHostId: () => string | null;
}): EpicBatchDeleteDestination {
  const { activeHostId } = args;
  if (activeHostId === null) return { kind: "direct", hostId: null };
  const route = routeOwnerGoneWrite({
    ownerHostId: activeHostId,
    fleet: args.fleet,
    preferredHostIds: () => [args.localHostId()],
    // Deleting a cloud-homed Task from the account is what every host's
    // `epic.batchDelete` already does, so no minor is asked of the stand-in.
    fallbackAccepts: () => true,
  });
  return route.fellBack
    ? { kind: "fallback", hostId: route.hostId }
    : { kind: "direct", hostId: activeHostId };
}

/**
 * {@link EpicBatchDeleteRoute} for one dispatch: its destination, with the ids
 * split on each row's home as it is when the request is built. A stand-in is
 * sent only the cloud-homed ids; a local-homed one exists on the down active
 * host alone.
 */
export function splitEpicBatchDelete(
  destination: EpicBatchDeleteDestination,
  ids: ReadonlyArray<string>,
  isLocalHomedNow: (epicId: string) => boolean,
): EpicBatchDeleteRoute {
  if (destination.kind === "direct") {
    return {
      kind: "direct",
      hostId: destination.hostId,
      sentIds: ids,
      refusedIds: [],
    };
  }
  const sentIds = ids.filter((id) => !isLocalHomedNow(id));
  const refusedIds = ids.filter((id) => isLocalHomedNow(id));
  if (sentIds.length === 0) {
    return { kind: "refused", hostId: null, sentIds, refusedIds };
  }
  return { kind: "fallback", hostId: destination.hostId, sentIds, refusedIds };
}

/** {@link splitEpicBatchDelete} over {@link chooseEpicBatchDeleteDestination}. */
export function routeEpicBatchDelete(args: {
  readonly activeHostId: string | null;
  readonly ids: ReadonlyArray<string>;
  readonly isLocalHomedNow: (epicId: string) => boolean;
  readonly fleet: SurfacePinFleetView;
  readonly localHostId: () => string | null;
}): EpicBatchDeleteRoute {
  return splitEpicBatchDelete(
    chooseEpicBatchDeleteDestination(args),
    args.ids,
    args.isLocalHomedNow,
  );
}

/**
 * The answer for a local-homed Task a stand-in host was not asked to delete:
 * it exists only on the active host, which cannot be reached.
 */
export const EPIC_DELETE_HOST_UNREACHABLE_MESSAGE =
  "This task was not deleted because Traycer can't reach the host it is on. Try again once that host is reachable.";

/**
 * Each dispatch's destination, decided ONCE in `onMutate` and shared by the
 * client choice and every lifecycle callback: TanStack hands all of them the
 * same variables object, and two reads of the fleet could disagree about
 * where the call went. Weakly keyed, so a settled dispatch's entry goes with
 * it.
 */
const batchDeleteDestinations = new WeakMap<
  BatchDeleteEpicVariables,
  EpicBatchDeleteDestination
>();

/**
 * Each dispatch's route: its destination with the ids split on each row's
 * home, read when the request is built (`client`, the first step of the
 * dispatch) - a row that finished promotion to cloud after the mutation
 * started is sent - and then shared by the payload and the callbacks.
 */
const batchDeleteRoutes = new WeakMap<
  BatchDeleteEpicVariables,
  EpicBatchDeleteRoute
>();

type DeleteNavigationTarget = HeaderTab | null | undefined;

// Byte-identical with the host's `CLOUD_DELETE_NOT_AUTHORIZED_DETAIL`
// (traycer-internal `epic-batch-delete-resolver.ts`), which answers the same
// refusal per item: the toast dedupes reasons by exact text
// (`epicDeleteFailureDetail`), so a client-refused id and a host-refused one
// read as one reason, not two that fill `MAX_LISTED_DELETE_REASONS`.
const EPIC_DELETE_SIGNED_OUT_MESSAGE =
  "This task was not deleted because Traycer couldn't confirm your sign-in. Try again once you're signed in.";

export const EPIC_DELETE_ACCOUNT_CHANGED_MESSAGE =
  "This task was not deleted because the signed-in account changed after you chose it. Choose it again to delete it.";

/**
 * The ids each dispatch did not send, answered "not deleted" with the reason,
 * merged into its answer so the outcome toast counts them.
 */
const epicDeleteRefusedResults = new WeakMap<
  BatchDeleteEpicVariables,
  ReadonlyArray<BatchDeleteItemResult>
>();

/**
 * The route's local-homed ids a stand-in host was not sent, then the ids it
 * would have sent that admission refused, each answered with its reason.
 */
function refusedEpicDeleteResults(
  route: EpicBatchDeleteRoute,
  refusedSentIds: ReadonlyArray<string>,
  refusedSentMessage: string,
): BatchDeleteItemResult[] {
  const refused = (
    taskIds: ReadonlyArray<string>,
    errorMessage: string,
  ): BatchDeleteItemResult[] =>
    taskIds.map((taskId) => ({ taskId, success: false, errorMessage }));
  return [
    ...refused(route.refusedIds, EPIC_DELETE_HOST_UNREACHABLE_MESSAGE),
    ...refused(refusedSentIds, refusedSentMessage),
  ];
}

/**
 * The one `epic.batchDelete` request, admitted at the latest point before it
 * is sent, from live state, over the ids its route sends (a stand-in host is
 * never sent a local-homed id).
 *
 * First, the account: `requestUserId` is the identity the host client will
 * send this request under, read in the same tick it schedules the request
 * (`useHostMutation` builds and sends without an await between). When it is
 * not the account the delete was chosen under (`boundUserId`), nothing is
 * sent and every id the route would send is answered "not deleted". The host
 * acts as whoever the request carries and has no way to tell who confirmed
 * it, so this is the one place a switch between choosing and sending can be
 * caught.
 *
 * Then the verdict. While the session is signed in every one goes.
 * Otherwise only the ids whose row is local-homed now go - deleting those
 * spends nothing on the account - and the rest are answered "not deleted".
 * A same-user demotion to `unverified` keeps the bearer, so this is what stops
 * a cloud delete from going out on it. With nothing admitted no request is
 * sent and `onError` says why.
 *
 * One request carries every admitted id: the cloud bounds it itself, deleting
 * ten Tasks per transaction within the request's time limit and answering the
 * rest "not deleted", so a very large selection can come back partly not
 * deleted and deleting again finishes it.
 */
function admitEpicDeleteRequest(
  variables: BatchDeleteEpicVariables,
  route: EpicBatchDeleteRoute,
  requestUserId: string | null,
): {
  ids: string[];
} {
  if (
    variables.boundUserId === null ||
    requestUserId !== variables.boundUserId
  ) {
    // No identity to send as is a sign-in problem, not an account switch:
    // choosing the tasks again cannot help until someone is signed in.
    epicDeleteRefusedResults.set(
      variables,
      refusedEpicDeleteResults(
        route,
        route.sentIds,
        requestUserId === null
          ? EPIC_DELETE_SIGNED_OUT_MESSAGE
          : EPIC_DELETE_ACCOUNT_CHANGED_MESSAGE,
      ),
    );
    throw new Error(
      "epic.batchDelete: the account changed after the tasks were chosen",
    );
  }
  const signedIn = authorizesCloudCapability(useAuthStore.getState().status);
  const ids = signedIn
    ? [...route.sentIds]
    : route.sentIds.filter((id) => variables.isLocalHomedNow(id));
  epicDeleteRefusedResults.set(
    variables,
    refusedEpicDeleteResults(
      route,
      route.sentIds.filter((id) => !ids.includes(id)),
      EPIC_DELETE_SIGNED_OUT_MESSAGE,
    ),
  );
  if (ids.length === 0) {
    throw new Error("epic.batchDelete: no task admitted without a sign-in");
  }
  return { ids };
}

/**
 * The failure of the one request when part of the selection was refused
 * before it was sent: for the sign-in, or because its row is local-homed on a
 * host a stand-in was dispatched around (`refusedEpicDeleteResults`).
 *
 * A request that never reached its host deleted nothing, so the sent ids and
 * the refused ones were all not deleted, and one notice gives every reason.
 * Any other failure proves nothing about the ids it carried - the host can
 * commit a purge and then throw - so the refused ids' notice says they were
 * never sent, and the request's failure gets the notice it gets with nothing
 * refused. Two notices under their own ids, so neither replaces the other.
 */
function toastDeleteFailureWithRefusals(
  error: HostRpcError,
  ids: ReadonlyArray<string>,
  refused: ReadonlyArray<BatchDeleteItemResult>,
  epicTitlesById: Readonly<Record<string, string>>,
): void {
  if (isOwnerHostUnreachableFailure(error)) {
    const refusedIds = new Set(refused.map((result) => result.taskId));
    const sentIds = ids.filter((id) => !refusedIds.has(id));
    const parts = epicDeleteToastParts({
      failures: [
        ...sentIds.map((taskId) => ({
          taskId,
          success: false,
          errorMessage: OWNER_HOST_UNREACHABLE_NOTICE,
        })),
        ...refused,
      ],
      successes: 0,
      total: ids.length,
      deletedIds: [],
      epicTitlesById,
    });
    emitEpicDeleteToast(parts.level, parts.message, parts.detail);
    return;
  }
  const parts = epicDeleteToastParts({
    failures: [...refused],
    successes: 0,
    total: refused.length,
    deletedIds: [],
    epicTitlesById,
  });
  emitEpicDeleteToast(parts.level, parts.message, parts.detail);
  toastFromOwnerHostWriteError(error, "Couldn't delete tasks.");
}

/**
 * Reads the account `useEpicBatchDelete` would send a delete as, now. It is
 * the same host client, so the account a caller binds a delete to
 * (`BatchDeleteEpicVariables.boundUserId`) is read exactly as
 * `admitEpicDeleteRequest` reads the one it is checked against.
 */
export function useEpicDeleteRequestUserId(): () => string | null {
  const client = useHostClient();
  return useCallback(() => client.getRequestContextUserId(), [client]);
}

export function useEpicBatchDelete(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "epic.batchDelete">,
  HostRpcError,
  BatchDeleteEpicVariables,
  BatchDeleteEpicMutationContext
> {
  const activeClient = useHostClient();
  const binding = useHostBinding();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const openStreamTransport = useWorktreeDeleteStreamTransportFactory();
  const destinationFor = (
    variables: BatchDeleteEpicVariables,
  ): EpicBatchDeleteDestination => {
    const known = batchDeleteDestinations.get(variables);
    if (known !== undefined) return known;
    const destination = chooseEpicBatchDeleteDestination({
      activeHostId: activeClient.getActiveHostId(),
      fleet: readSelectionFleetSnapshot(),
      localHostId: readLocalHostIdSnapshot,
    });
    batchDeleteDestinations.set(variables, destination);
    return destination;
  };
  const routeFor = (
    variables: BatchDeleteEpicVariables,
  ): EpicBatchDeleteRoute => {
    const known = batchDeleteRoutes.get(variables);
    if (known !== undefined) return known;
    const route = splitEpicBatchDelete(
      destinationFor(variables),
      variables.ids,
      variables.isLocalHomedNow,
    );
    batchDeleteRoutes.set(variables, route);
    return route;
  };
  const activePathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  return useHostMutation<
    HostRpcRegistry,
    "epic.batchDelete",
    BatchDeleteEpicMutationContext,
    BatchDeleteEpicVariables
  >({
    client: (variables) => {
      const route = routeFor(variables);
      switch (route.kind) {
        case "direct":
          return activeClient;
        case "fallback":
          return resolveNamedHostClient(binding, route.hostId);
        case "refused":
          // Nothing to send: `onError` says why (the preflight rejects).
          return null;
      }
    },
    method: "epic.batchDelete",
    mapVariables: (variables) =>
      admitEpicDeleteRequest(
        variables,
        routeFor(variables),
        // A requester for a stand-in host shares this client's request
        // context, so this is the account the request carries on any route.
        activeClient.getRequestContextUserId(),
      ),
    resolveResponse: (response, variables) => {
      const refused = epicDeleteRefusedResults.get(variables) ?? [];
      if (refused.length === 0) return Promise.resolve(response);
      return Promise.resolve({
        ...response,
        results: [...response.results, ...refused],
      });
    },
    options: {
      mutationKey: epicMutationKeys.batchDelete(),
      onMutate: (variables) => {
        const hostId = activeClient.getActiveHostId();
        const destination = destinationFor(variables);
        const userId = activeClient.getRequestContextUserId();
        const epicTitlesById = collectDeletedEpicTitles(
          variables.ids,
          getHeaderTabs(),
          queryClient,
          userId === null ? null : { hostId, userId },
        );
        const progressToastId = nextEpicDeleteProgressToastId();
        progressToast(
          epicDeleteProgressToastMessage(variables.ids, epicTitlesById),
          { id: progressToastId, duration: Infinity },
        );
        return {
          hostId,
          destination,
          enactingHostId: destination.hostId,
          userId,
          epicTitlesById,
          progressToastId,
        };
      },
      onSuccess: (data, variables, ctx) => {
        const failures = data.results.filter((r) => !r.success);
        const deletedIds = data.results.flatMap((result) =>
          result.success ? [result.taskId] : [],
        );
        const successes = data.results.length - failures.length;
        if (variables.ids.length === 1 && successes === 1) {
          Analytics.getInstance().track(AnalyticsEvent.TaskDeleted, {
            source: "direct_ui",
            cleanup_worktrees:
              (variables.worktreeCleanup?.candidates.length ?? 0) > 0,
          });
        }
        const { accountWideIds, hostScopedIds } = splitEpicDeleteScopes(
          data.results,
          deletedIds,
          ctx.destination,
        );
        // Local teardown follows each success's scope, keyed to the host that
        // enacted the delete: a stand-in's local-homed delete removed ITS
        // Task, and this window's same-id Task on the active host is still
        // there (`epicIdsLostInWindow`).
        const scopes = {
          accountWideIds,
          hostScopedIds,
          deletingHostId: ctx.enactingHostId,
        };
        const lostIds = epicIdsLostInWindow(scopes, ctx.hostId);
        const navigationTarget = pickNeighborAfterDeletingEpics(
          getHeaderTabs(),
          activePathname,
          new Set(lostIds),
        );
        clearDeletedEpicRunSettings(scopes);
        tabCommandCoordinator.handleEpicAccessLoss(lostIds);
        if (ctx.userId !== null) {
          // Tombstone each success in the scope its deletion actually had.
          //
          // A cloud-homed epic is deleted from the ACCOUNT, so every host
          // scope must stop showing it - `hostId: null` is the store's
          // account-wide bucket, which `deletedEpicIdsForScope` unions into
          // every host's read. A local-homed one exists on the machine that
          // held it, and an account-wide tombstone there would hide a row a
          // sibling host can still serve.
          //
          // The split itself is `splitEpicDeleteScopes`.
          const userId = ctx.userId;
          // A host-scoped success belongs to the host that deleted it: on a
          // fallback route that is the stand-in, not the down host.
          if (hostScopedIds.length > 0) {
            removeDeletedEpicsFromCloudTaskCaches(
              queryClient,
              { hostId: ctx.enactingHostId, userId },
              hostScopedIds,
            );
          }
          if (accountWideIds.length > 0) {
            removeDeletedEpicsFromCloudTaskCaches(
              queryClient,
              { hostId: null, userId },
              accountWideIds,
            );
          }
        }
        if (navigationTarget !== undefined) {
          if (navigationTarget === null) {
            void navigate(LANDING_ROUTE);
          } else {
            navigateToTabIntent(
              navigate,
              tabResolveIntent(navigationTarget),
              undefined,
            );
          }
        }
        const epicToast = withSkippedWorktreeCleanup(
          epicDeleteToastParts({
            failures,
            successes,
            total: data.results.length,
            deletedIds,
            epicTitlesById: ctx.epicTitlesById,
          }),
          skippedWorktreeCleanupCount(
            ctx.destination,
            variables.worktreeCleanup,
            deletedIds,
            successes,
          ),
        );
        const eligibleWorktreePaths = routedWorktreeCleanupPaths(
          ctx.destination,
          variables.worktreeCleanup,
          deletedIds,
          successes,
        );
        // The outcome toast takes the progress toast's place. Dismiss-then-emit
        // rather than an update by id: Sonner MERGES updates that reuse an id,
        // so the outcome would inherit the progress toast's infinite lifetime
        // and spinner unless every emitter below reset both.
        if (ctx.hostId === null || eligibleWorktreePaths.length === 0) {
          toast.dismiss(ctx.progressToastId);
          emitEpicDeleteToast(
            epicToast.level,
            epicToast.message,
            epicToast.detail,
          );
        } else {
          // The Task(s) are already deleted; stream the approved worktree
          // removals and report a single combined summary once they settle.
          // Deletion is never blocked or delayed on this cleanup - a slow or
          // failing worktree delete only affects its own toast line. `hostId`
          // is frozen from `onMutate` so a host swap mid-flight can't redirect
          // the cleanup or its cache invalidation to the wrong scope.
          const hostId = ctx.hostId;
          const progressToastId = ctx.progressToastId;
          // Same toast, next phase: the Task(s) are gone and the approved
          // worktrees are what is still being removed. Only while it is still
          // up: an update by id re-creates a toast the person has closed, and
          // a dismissed progress toast stays dismissed (as the worktree
          // delete bridge keeps it). The summary below is shown either way.
          if (toast.getToasts().some((entry) => entry.id === progressToastId)) {
            progressToast(
              worktreeCleanupProgressToastMessage(eligibleWorktreePaths.length),
              { id: progressToastId, duration: Infinity },
            );
          }
          void runWorktreeCleanup(openStreamTransport, {
            hostId,
            paths: eligibleWorktreePaths,
            source: "task_cleanup",
            epicId: undefined,
            stopOwnersPaths: new Set(),
          }).then(
            (outcome) => {
              toast.dismiss(progressToastId);
              emitTaskDeleteSummaryToast(epicToast, outcome);
              invalidateWorktreeCachesForHost(queryClient, hostId);
            },
            () => {
              // The cleanup reports failures as an outcome and is not
              // expected to reject; if it ever does, the Task deletion still
              // happened, so say so rather than leave the spinner up.
              toast.dismiss(progressToastId);
              emitEpicDeleteToast(
                epicToast.level,
                epicToast.message,
                epicToast.detail,
              );
            },
          );
        }
        // Other windows tombstone in the same scopes as this one: the
        // host-scoped successes under the enacting host, the rest account-wide.
        if (ctx.enactingHostId !== null && ctx.userId !== null) {
          publishDeletedEpicNotification({
            hostId: ctx.enactingHostId,
            userId: ctx.userId,
            epicIds: deletedIds,
            hostScopedEpicIds: hostScopedIds,
            epicTitlesById: ctx.epicTitlesById,
          });
        }
        // The window's current host too: the selection may have moved while
        // the delete travelled, and that host's lists were read before it.
        invalidateBatchDeleteHostScopes(queryClient, [
          ctx.hostId,
          ctx.enactingHostId,
          activeHostIdOrNull(),
        ]);
      },
      onError: (error, variables, ctx) => {
        // Explicit, never left to the error toast: `toastFromHostError` stays
        // silent for an aborted or recoverable-unauthorized request, and a
        // progress toast nothing dismisses would spin forever.
        if (ctx !== undefined) toast.dismiss(ctx.progressToastId);
        // A `refused` route sends nothing, so admission never ran for it.
        const route = batchDeleteRoutes.get(variables);
        const refused =
          epicDeleteRefusedResults.get(variables) ??
          (route?.kind === "refused"
            ? refusedEpicDeleteResults(
                route,
                [],
                EPIC_DELETE_SIGNED_OUT_MESSAGE,
              )
            : undefined);
        if (refused !== undefined && refused.length === variables.ids.length) {
          // Refused before any request: nothing was sent, so say why.
          const parts = epicDeleteToastParts({
            failures: refused,
            successes: 0,
            total: variables.ids.length,
            deletedIds: [],
            epicTitlesById: ctx?.epicTitlesById ?? {},
          });
          emitEpicDeleteToast(parts.level, parts.message, parts.detail);
          return;
        }
        // A request was sent and its answer is unknown: the host may have
        // purged before it failed. Refresh every scope it could have changed -
        // the active host's at the start, the enacting host's and the
        // window's current host's - as success does.
        if (ctx !== undefined) {
          invalidateBatchDeleteHostScopes(queryClient, [
            ctx.hostId,
            ctx.enactingHostId,
            activeHostIdOrNull(),
          ]);
        }
        if (refused !== undefined && refused.length > 0) {
          toastDeleteFailureWithRefusals(
            error,
            variables.ids,
            refused,
            ctx?.epicTitlesById ?? {},
          );
          return;
        }
        // The one request failed. When it never reached the host, nothing on
        // it was changed - neither the ids it carried nor any refused above.
        toastFromOwnerHostWriteError(error, "Couldn't delete tasks.");
      },
    },
  });
}

/**
 * epicIds with an in-flight `epic.batchDelete`. Deletion runs in the
 * background - the confirm dialog closes at kickoff - so a row whose Task is
 * still being deleted is rendered again with its delete control, and nothing
 * on the wire deduplicates a second `epic.batchDelete` for the same id. This
 * is read from the mutation cache by the shared key rather than off one hook
 * instance, for the reason `usePendingSetPinnedEpicIds` gives: two batches can
 * be in flight at once and each row must track its own.
 */
export function usePendingDeleteEpicIds(): ReadonlySet<string> {
  const pendingVariables = useMutationState({
    filters: {
      mutationKey: epicMutationKeys.batchDelete(),
      status: "pending",
    },
    select: (mutation) => mutation.state.variables,
  });
  return useMemo(
    () => pendingDeleteEpicIdsFromVariables(pendingVariables),
    [pendingVariables],
  );
}

/** Reads pending deletes at callback time, avoiding a render-time snapshot. */
export function readPendingDeleteEpicIds(
  queryClient: QueryClient,
): ReadonlySet<string> {
  const pendingVariables = queryClient
    .getMutationCache()
    .findAll({
      mutationKey: epicMutationKeys.batchDelete(),
      status: "pending",
    })
    .map((mutation) => mutation.state.variables);
  return pendingDeleteEpicIdsFromVariables(pendingVariables);
}

function pendingDeleteEpicIdsFromVariables(
  pendingVariables: ReadonlyArray<unknown>,
): ReadonlySet<string> {
  return new Set(
    pendingVariables.flatMap((variables) =>
      isBatchDeleteEpicVariables(variables) ? variables.ids : [],
    ),
  );
}

/**
 * Whether this task's `epic.batchDelete` is still in flight. The confirm
 * dialog closes at kickoff, so a row is back on screen while the host deletes
 * the task, and opening it then raced the delete. A row that lists a task
 * reads this to show the delete in progress.
 */
export function useIsEpicDeleteInFlight(epicId: string): boolean {
  return usePendingDeleteEpicIds().has(epicId);
}

/**
 * The same question, asked at the moment of an open rather than rendered:
 * every surface that opens a task from a list refuses one whose delete is in
 * flight. Reads the mutation cache when CALLED, so it costs the list no
 * subscription and cannot answer from a stale render.
 */
export function useEpicDeleteInFlightReader(): (epicId: string) => boolean {
  const queryClient = useQueryClient();
  return useCallback(
    (epicId: string) =>
      queryClient
        .getMutationCache()
        .findAll({
          mutationKey: epicMutationKeys.batchDelete(),
          status: "pending",
        })
        .some((mutation) => {
          const variables: unknown = mutation.state.variables;
          return (
            isBatchDeleteEpicVariables(variables) &&
            variables.ids.includes(epicId)
          );
        }),
    [queryClient],
  );
}

/**
 * Reads the `ids` of a pending delete dispatch. It checks nothing beyond that
 * shape on purpose: the mutation cache has already scoped these variables by
 * `epicMutationKeys.batchDelete()`, and an entry this guard drops reads as
 * SETTLED - the row re-enables mid-flight - which is the direction a pending
 * guard must never fail in.
 */
function isBatchDeleteEpicVariables(
  value: unknown,
): value is { readonly ids: ReadonlyArray<string> } {
  if (value === null || typeof value !== "object") return false;
  return (
    "ids" in value &&
    Array.isArray(value.ids) &&
    value.ids.every((id) => typeof id === "string")
  );
}

export function pickNeighborAfterDeletingEpics(
  tabs: ReadonlyArray<HeaderTab>,
  activePathname: string,
  deletedEpicIds: ReadonlySet<string>,
): DeleteNavigationTarget {
  if (deletedEpicIds.size === 0) return undefined;
  const activeIndex = tabs.findIndex(
    (tab) =>
      tab.kind === "epic" &&
      tab.route === activePathname &&
      deletedEpicIds.has(tab.epicId),
  );
  if (activeIndex === -1) return undefined;
  return pickNeighborAfterRemovingTabs(
    tabs,
    activeIndex,
    (tab) => tab.kind === "epic" && deletedEpicIds.has(tab.epicId),
    isWorkTab,
  );
}

function isWorkTab(tab: HeaderTab): boolean {
  return tab.kind === "epic" || tab.kind === "draft";
}

function collectDeletedEpicTitles(
  epicIds: ReadonlyArray<string>,
  tabs: ReadonlyArray<HeaderTab>,
  queryClient: QueryClient,
  scope: CloudEpicTasksCacheScope | null,
): Record<string, string> {
  const targetEpicIds = new Set(epicIds);
  if (targetEpicIds.size === 0) return {};
  const titles: Record<string, string> =
    scope === null
      ? {}
      : readEpicTitlesFromCloudTaskCaches(queryClient, scope, epicIds);
  for (const tab of tabs) {
    if (tab.kind !== "epic") continue;
    if (!targetEpicIds.has(tab.epicId)) continue;
    const title = normalizeEpicTitle(tab.name);
    if (title === null) continue;
    titles[tab.epicId] = title;
  }
  return titles;
}

/**
 * What the progress toast says while the host deletes. The in-progress form of
 * {@link deletedEpicSuccessToastMessage}, so the toast reads as one sentence
 * changing tense when the outcome takes its place.
 */
export function epicDeleteProgressToastMessage(
  epicIds: ReadonlyArray<string>,
  epicTitlesById: Readonly<Record<string, string | undefined>>,
): string {
  if (epicIds.length === 1) {
    const title = readEpicTitle(epicTitlesById, epicIds[0]);
    return title === null ? "Deleting epic…" : `Deleting epic "${title}"…`;
  }
  return `Deleting ${epicIds.length} epics…`;
}

export function worktreeCleanupProgressToastMessage(
  worktreeCount: number,
): string {
  return `Removing ${worktreeCount} worktree${worktreeCount === 1 ? "" : "s"}…`;
}

export function deletedEpicSuccessToastMessage(
  deletedEpicIds: ReadonlyArray<string>,
  epicTitlesById: Readonly<Record<string, string | undefined>>,
): string {
  if (deletedEpicIds.length === 1) {
    const title = readEpicTitle(epicTitlesById, deletedEpicIds[0]);
    return title === null ? "Epic was deleted" : `Epic "${title}" was deleted`;
  }
  return `${deletedEpicIds.length} epics deleted`;
}

function readEpicTitle(
  titlesById: Readonly<Record<string, string | undefined>>,
  epicId: string | undefined,
): string | null {
  if (epicId === undefined) return null;
  const title = titlesById[epicId];
  return title === undefined ? null : normalizeEpicTitle(title);
}

function normalizeEpicTitle(title: string): string | null {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : null;
}

type EpicDeleteToastLevel = "success" | "warning" | "error";

export interface EpicDeleteToastParts {
  readonly level: EpicDeleteToastLevel;
  readonly message: string;
  /**
   * The host's own reason for the failed rows, or `null` when it sent none.
   *
   * Counting the failures and dropping `errorMessage` was the gap: a batch the
   * host REFUSED - because its local store would not open, or because it could
   * not rule out local state it cannot currently read - is the case where the
   * reason is the whole message, and it rendered as a bare "Couldn't delete
   * epic." with nothing to act on. The refusal detail is `${message} ${remedy}`
   * built by `planLocalDeletes`, so the remedy is already in here.
   */
  readonly detail: string | null;
}

// The Task-deletion half of the summary toast, factored so the same message can
// be emitted immediately (no cleanup) or combined with the worktree tally once
// the streamed cleanup settles.
//
// Exported for the same reason its four neighbours are: it is a pure function
// of the response, and the only other way to reach it is to drive the whole
// mutation - host client, router, stream transport - which would put a mock
// scaffold between the assertion and the copy it is asserting.
export function epicDeleteToastParts(args: {
  readonly failures: ReadonlyArray<BatchDeleteItemResult>;
  readonly successes: number;
  readonly total: number;
  readonly deletedIds: ReadonlyArray<string>;
  readonly epicTitlesById: Readonly<Record<string, string>>;
}): EpicDeleteToastParts {
  const { failures, successes, total, deletedIds, epicTitlesById } = args;
  const failureCount = failures.length;
  if (failureCount === 0) {
    return {
      level: "success",
      message: deletedEpicSuccessToastMessage(deletedIds, epicTitlesById),
      detail: null,
    };
  }
  const detail = epicDeleteFailureDetail(failures);
  if (successes === 0) {
    return {
      level: "error",
      message:
        failureCount === 1
          ? "Couldn't delete task."
          : `Couldn't delete ${failureCount} tasks.`,
      detail,
    };
  }
  return {
    level: "warning",
    message: `Deleted ${successes} of ${total}; ${failureCount} failed.`,
    detail,
  };
}

/**
 * The distinct reasons behind the failed rows, joined for the toast's
 * description.
 *
 * DEDUPED, and that is not cosmetic: a whole-batch refusal
 * (`refuseWholeBatch`) writes the SAME sentence onto every id, so a five-epic
 * delete would otherwise print one reason five times. Distinct reasons are
 * joined instead of only the first being shown, because a mixed batch's rows
 * can fail for genuinely different reasons and picking one would report the
 * others as unexplained.
 *
 * Kept out of the report-issue contexts by its callers, exactly as
 * `worktreeCleanupFailureDetail` is: these sentences are host-authored operator
 * copy and can name an absolute path on the user's disk. Capped for the same
 * reason and against the DISTINCT count, which is the number a reader actually
 * sees - the local-store refusals collapse to one however many rows they
 * refused, so the cap only bites on a genuinely heterogeneous batch.
 */
function epicDeleteFailureDetail(
  failures: ReadonlyArray<BatchDeleteItemResult>,
): string | null {
  const reasons = new Set<string>();
  for (const failure of failures) {
    const reason = failure.errorMessage?.trim() ?? "";
    if (reason.length > 0) reasons.add(reason);
  }
  if (reasons.size === 0 || reasons.size > MAX_LISTED_DELETE_REASONS) {
    return null;
  }
  return [...reasons].join(" · ");
}

/**
 * Beyond this many DISTINCT reasons the toast shows its count line only - the
 * same judgment `worktreeCleanupFailureDetail` makes, and deliberately a
 * smaller number: these are whole host sentences with a remedy in them, not
 * `<path>: <reason>` fragments, so two already fills a toast.
 */
const MAX_LISTED_DELETE_REASONS = 2;

/**
 * `detail` is the toast's on-screen description - the per-path worktree
 * failure reasons, or `null` when the count line is all there is. It stays out
 * of the report-issue contexts below: those are public and must carry fixed
 * product copy, and a reason names an absolute worktree path.
 */
export function emitEpicDeleteToast(
  level: EpicDeleteToastLevel,
  message: string,
  detail: string | null,
): void {
  if (level === "success") {
    if (detail === null) {
      toast.success(message);
    } else {
      toast.success(message, { description: detail });
    }
    return;
  }
  const options = detail === null ? undefined : { description: detail };
  if (level === "warning") {
    reportableWarningToast(message, options, {
      title: "Epic deletion incomplete",
      message: null,
      code: null,
      source: "Epic deletion",
    });
    return;
  }
  reportableErrorToast(message, options, {
    title: "Could not delete Epics",
    message: null,
    code: null,
    source: "Epic deletion",
  });
}

/**
 * Each success's tombstone scope.
 *
 * `home` is `@1.1`; an older host omits it, and absence keeps the
 * released host-scoped behaviour rather than being read as
 * `"cloud"`. That asymmetry is deliberate: account-wide is the
 * destructive direction, and an old host is exactly the peer that
 * produced no evidence for it.
 *
 * A fallback route is the exception: it sent only the ids whose row
 * was cloud-homed, and a stand-in deletes those from the account
 * whatever its minor, so a success there is account-wide even when
 * an older stand-in omits `home`. A stand-in that does state
 * `home: "local"` is still believed.
 */
function splitEpicDeleteScopes(
  results: ReadonlyArray<BatchDeleteItemResult>,
  deletedIds: ReadonlyArray<string>,
  destination: EpicBatchDeleteDestination,
): {
  readonly accountWideIds: ReadonlyArray<string>;
  readonly hostScopedIds: ReadonlyArray<string>;
} {
  const accountWideIds = results.flatMap((result) =>
    result.success &&
    (result.home === "cloud" ||
      (destination.kind === "fallback" && result.home === undefined))
      ? [result.taskId]
      : [],
  );
  return {
    accountWideIds,
    hostScopedIds: deletedIds.filter((id) => !accountWideIds.includes(id)),
  };
}

/**
 * The approved worktrees are on the active host. When another host stood in
 * for it, that machine is down and nothing there can be removed now.
 */
function routedWorktreeCleanupPaths(
  destination: EpicBatchDeleteDestination,
  cleanup: BatchDeleteEpicVariables["worktreeCleanup"],
  deletedIds: ReadonlyArray<string>,
  successes: number,
): ReadonlyArray<string> {
  if (destination.kind !== "direct") return [];
  return eligibleWorktreeCleanupPaths(cleanup, deletedIds, successes);
}

/**
 * How many approved worktree removals a stand-in route left undone: the
 * worktrees are on the active host, which is down. Zero on a direct route.
 */
function skippedWorktreeCleanupCount(
  destination: EpicBatchDeleteDestination,
  cleanup: BatchDeleteEpicVariables["worktreeCleanup"],
  deletedIds: ReadonlyArray<string>,
  successes: number,
): number {
  if (destination.kind === "direct") return 0;
  return eligibleWorktreeCleanupPaths(cleanup, deletedIds, successes).length;
}

/** Why approved worktree removals were not run, for the toast's detail. */
export const WORKTREE_CLEANUP_SKIPPED_DETAIL =
  "Traycer can't reach the task's host, so its worktrees and their files stay on that computer. Remove them in Settings ▸ Worktrees once that host is reachable.";

/**
 * The Task half of the toast, with the approved worktree removals that were
 * not run: the Task is deleted, but the worktrees the person asked to remove
 * are still on disk, so the toast is a warning that says so. Exported with
 * `epicDeleteToastParts` for the same reason.
 */
export function withSkippedWorktreeCleanup(
  parts: EpicDeleteToastParts,
  skipped: number,
): EpicDeleteToastParts {
  if (skipped === 0) return parts;
  return {
    level: parts.level === "error" ? "error" : "warning",
    message: `${parts.message} · ${skipped} worktree${skipped === 1 ? "" : "s"} not removed`,
    detail: joinToastDetails(parts.detail, WORKTREE_CLEANUP_SKIPPED_DETAIL),
  };
}

/** The active host's scope, and the stand-in's when one took the call. */
function invalidateBatchDeleteHostScopes(
  queryClient: QueryClient,
  hostIds: ReadonlyArray<string | null>,
): void {
  for (const hostId of new Set(hostIds)) {
    if (hostId === null) continue;
    void queryClient.invalidateQueries({
      queryKey: hostQueryKeys.scope(hostId),
    });
  }
}

// A worktree is safe to remove only when EVERY owning Task actually succeeded -
// so a partial batch failure never removes a worktree still referenced by a
// Task that failed to delete. Empty when no cleanup was approved or no Task
// succeeded.
function eligibleWorktreeCleanupPaths(
  cleanup: BatchDeleteEpicVariables["worktreeCleanup"],
  deletedIds: ReadonlyArray<string>,
  successes: number,
): ReadonlyArray<string> {
  if (cleanup === null || successes === 0) return [];
  const deletedSet = new Set(deletedIds);
  return cleanup.candidates
    .filter((candidate) =>
      candidate.ownerEpicIds.every((epicId) => deletedSet.has(epicId)),
    )
    .map((candidate) => candidate.worktreePath);
}

export function worktreeCleanupSummary(
  outcome: WorktreeCleanupOutcome,
): string | null {
  const removed = outcome.removed.length;
  const failed = outcome.failed.length;
  const uncertain = outcome.uncertain.length;
  if (removed === 0 && failed === 0 && uncertain === 0) return null;
  const parts: string[] = [];
  if (removed > 0) {
    parts.push(`${removed} worktree${removed === 1 ? "" : "s"} removed`);
  }
  if (failed > 0) {
    parts.push(
      `${failed} worktree${failed === 1 ? "" : "s"} couldn't be removed`,
    );
  }
  // Distinct from "couldn't be removed": the host owns the cleanup command and
  // is still running it, so claiming a failure here would be a guess. The
  // durable completion notification carries the real counts.
  if (uncertain > 0) {
    parts.push(
      `${uncertain} worktree${uncertain === 1 ? "" : "s"} unconfirmed`,
    );
  }
  return parts.join(", ");
}

/**
 * The combined toast, once the streamed worktree cleanup settles.
 *
 * Exported alongside `epicDeleteToastParts` so the JOIN can be pinned where it
 * happens. Testing `joinToastDetails` directly would prove the function and not
 * its use - which half goes first, and whether both are passed at all, are
 * facts about this caller.
 */
export function emitTaskDeleteSummaryToast(
  epicToast: EpicDeleteToastParts,
  outcome: WorktreeCleanupOutcome,
): void {
  const summary = worktreeCleanupSummary(outcome);
  if (summary === null) {
    emitEpicDeleteToast(epicToast.level, epicToast.message, epicToast.detail);
    return;
  }
  // A worktree that couldn't be removed - or whose removal we never saw
  // confirmed - downgrades the combined toast to a warning even when every
  // Task deleted cleanly.
  const level =
    outcome.failed.length > 0 || outcome.uncertain.length > 0
      ? "warning"
      : epicToast.level;
  // BOTH halves, in the order the toast's own message names them. The two can
  // co-occur - a batch where some rows were refused and an approved worktree
  // removal then failed - and dropping either leaves the toast counting a
  // failure it does not explain.
  const detail = joinToastDetails(
    epicToast.detail,
    worktreeCleanupFailureDetail(outcome.failed),
  );
  emitEpicDeleteToast(level, `${epicToast.message} · ${summary}`, detail);
}

function joinToastDetails(
  first: string | null,
  second: string | null,
): string | null {
  const parts = [first, second].filter(
    (part): part is string => part !== null && part.length > 0,
  );
  return parts.length === 0 ? null : parts.join(" · ");
}

// Refresh the host-wide worktree list plus the shared binding-backed caches
// after the cleanup lands, so Settings ▸ Worktrees and the folder/worktree
// pickers stop showing the removed worktrees. Shares the Settings delete
// flow's invalidation slice; see the helper for the refetchType rationale.
function invalidateWorktreeCachesForHost(
  queryClient: QueryClient,
  hostId: string,
): void {
  invalidateWorktreeListingAndBindingCaches(queryClient, hostId);
}
