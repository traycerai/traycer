import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
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
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { hostQueryKeys, epicMutationKeys } from "@/lib/query-keys";
import { invalidateWorktreeListingAndBindingCaches } from "@/hooks/worktree/invalidations";
import { useWorktreeDeleteStreamTransportFactory } from "@/lib/host/use-worktree-delete-stream-transport";
import {
  runWorktreeCleanup,
  worktreeCleanupFailureDetail,
  type WorktreeCleanupOutcome,
} from "@/lib/epics/run-worktree-cleanup";
import { toastFromHostError } from "@/lib/host-error-toast";
import { LANDING_ROUTE } from "@/lib/routes";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import {
  readEpicTitlesFromCloudTaskCaches,
  removeDeletedEpicsFromCloudTaskCaches,
  type CloudEpicTasksCacheScope,
} from "@/lib/cloud-epic-tasks-query/cache";
import { publishDeletedEpicNotification } from "@/lib/epics/deleted-epic-events";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
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

interface BatchDeleteEpicMutationContext {
  readonly hostId: string | null;
  readonly userId: string | null;
  readonly epicTitlesById: Readonly<Record<string, string>>;
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
  readonly worktreeCleanup: {
    readonly candidates: ReadonlyArray<BatchDeleteWorktreeCandidate>;
  } | null;
}

type DeleteNavigationTarget = HeaderTab | null | undefined;

export function useEpicBatchDelete(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "epic.batchDelete">,
  HostRpcError,
  BatchDeleteEpicVariables,
  BatchDeleteEpicMutationContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const openStreamTransport = useWorktreeDeleteStreamTransportFactory();
  const activePathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  return useHostMutation<
    HostRpcRegistry,
    "epic.batchDelete",
    BatchDeleteEpicMutationContext,
    BatchDeleteEpicVariables
  >({
    client,
    method: "epic.batchDelete",
    mapVariables: (variables) => ({ ids: [...variables.ids] }),
    options: {
      mutationKey: epicMutationKeys.batchDelete(),
      onMutate: (variables) => {
        const hostId = client.getActiveHostId();
        const userId = client.getRequestContextUserId();
        return {
          hostId,
          userId,
          epicTitlesById: collectDeletedEpicTitles(
            variables.ids,
            getHeaderTabs(),
            queryClient,
            userId === null ? null : { hostId, userId },
          ),
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
        const navigationTarget = pickNeighborAfterDeletingEpics(
          getHeaderTabs(),
          activePathname,
          new Set(deletedIds),
        );
        useComposerRunSettingsStore.getState().clearEpicRunSettings(deletedIds);
        tabCommandCoordinator.handleEpicAccessLoss(deletedIds);
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
          // `home` is `@1.1`; an older host omits it, and absence keeps the
          // released host-scoped behaviour rather than being read as
          // `"cloud"`. That asymmetry is deliberate: account-wide is the
          // destructive direction, and an old host is exactly the peer that
          // produced no evidence for it.
          const userId = ctx.userId;
          const accountWideIds = data.results.flatMap((result) =>
            result.success && result.home === "cloud" ? [result.taskId] : [],
          );
          const hostScopedIds = deletedIds.filter(
            (id) => !accountWideIds.includes(id),
          );
          if (hostScopedIds.length > 0) {
            removeDeletedEpicsFromCloudTaskCaches(
              queryClient,
              { hostId: ctx.hostId, userId },
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
        const epicToast = epicDeleteToastParts({
          failures,
          successes,
          total: data.results.length,
          deletedIds,
          epicTitlesById: ctx.epicTitlesById,
        });
        const eligibleWorktreePaths = eligibleWorktreeCleanupPaths(
          variables.worktreeCleanup,
          deletedIds,
          successes,
        );
        if (ctx.hostId === null || eligibleWorktreePaths.length === 0) {
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
          void runWorktreeCleanup(openStreamTransport, {
            hostId,
            paths: eligibleWorktreePaths,
            source: "task_cleanup",
            epicId: undefined,
            stopOwnersPaths: new Set(),
          }).then((outcome) => {
            emitTaskDeleteSummaryToast(epicToast, outcome);
            invalidateWorktreeCachesForHost(queryClient, hostId);
          });
        }
        if (ctx.hostId !== null && ctx.userId !== null) {
          publishDeletedEpicNotification({
            hostId: ctx.hostId,
            userId: ctx.userId,
            epicIds: deletedIds,
            epicTitlesById: ctx.epicTitlesById,
          });
        }
        if (ctx.hostId === null) return;
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.scope(ctx.hostId),
        });
      },
      onError: (error) => toastFromHostError(error, "Couldn't delete epics."),
    },
  });
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
          ? "Couldn't delete epic."
          : `Couldn't delete ${failureCount} epics.`,
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
