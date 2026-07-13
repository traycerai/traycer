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
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { hostQueryKeys, epicMutationKeys } from "@/lib/query-keys";
import { invalidateWorktreeListingAndBindingCaches } from "@/hooks/worktree/invalidations";
import { useWorktreeDeleteStreamTransportFactory } from "@/lib/host/use-worktree-delete-stream-transport";
import {
  runWorktreeCleanup,
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
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { pickNeighborAfterRemovingTabs } from "@/stores/tabs/neighbor";
import { tabResolveIntent } from "@/stores/tabs/registry";
import type { HeaderTab } from "@/stores/tabs/types";
import { getHeaderTabs } from "@/stores/tabs/use-header-tabs";
import {
  reportableErrorToast,
  reportableWarningToast,
} from "@/lib/reportable-error-toast";

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
        const navigationTarget = pickNeighborAfterDeletingEpics(
          getHeaderTabs(),
          activePathname,
          new Set(deletedIds),
        );
        useComposerRunSettingsStore.getState().clearEpicRunSettings(deletedIds);
        useEpicCanvasStore.getState().closeTabsForEpics(deletedIds);
        if (ctx.userId !== null) {
          removeDeletedEpicsFromCloudTaskCaches(
            queryClient,
            { hostId: ctx.hostId, userId: ctx.userId },
            deletedIds,
          );
        }
        if (navigationTarget !== undefined) {
          if (navigationTarget === null) {
            void navigate(LANDING_ROUTE);
          } else {
            navigateToTabIntent(navigate, tabResolveIntent(navigationTarget));
          }
        }
        const epicToast = epicDeleteToastParts({
          failureCount: failures.length,
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
          emitEpicDeleteToast(epicToast.level, epicToast.message);
        } else {
          // The Task(s) are already deleted; stream the approved worktree
          // removals and report a single combined summary once they settle.
          // Deletion is never blocked or delayed on this cleanup - a slow or
          // failing worktree delete only affects its own toast line. `hostId`
          // is frozen from `onMutate` so a host swap mid-flight can't redirect
          // the cleanup or its cache invalidation to the wrong scope.
          const hostId = ctx.hostId;
          void runWorktreeCleanup(
            openStreamTransport,
            hostId,
            eligibleWorktreePaths,
          ).then((outcome) => {
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

interface EpicDeleteToastParts {
  readonly level: EpicDeleteToastLevel;
  readonly message: string;
}

// The Task-deletion half of the summary toast, factored so the same message can
// be emitted immediately (no cleanup) or combined with the worktree tally once
// the streamed cleanup settles.
function epicDeleteToastParts(args: {
  readonly failureCount: number;
  readonly successes: number;
  readonly total: number;
  readonly deletedIds: ReadonlyArray<string>;
  readonly epicTitlesById: Readonly<Record<string, string>>;
}): EpicDeleteToastParts {
  const { failureCount, successes, total, deletedIds, epicTitlesById } = args;
  if (failureCount === 0) {
    return {
      level: "success",
      message: deletedEpicSuccessToastMessage(deletedIds, epicTitlesById),
    };
  }
  if (successes === 0) {
    return {
      level: "error",
      message:
        failureCount === 1
          ? "Couldn't delete epic."
          : `Couldn't delete ${failureCount} epics.`,
    };
  }
  return {
    level: "warning",
    message: `Deleted ${successes} of ${total}; ${failureCount} failed.`,
  };
}

export function emitEpicDeleteToast(
  level: EpicDeleteToastLevel,
  message: string,
): void {
  if (level === "success") {
    toast.success(message);
    return;
  }
  if (level === "warning") {
    reportableWarningToast(message, undefined, {
      title: "Epic deletion incomplete",
      message: null,
      code: null,
      source: "Epic deletion",
    });
    return;
  }
  reportableErrorToast(message, undefined, {
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

function worktreeCleanupSummary(
  removed: number,
  failed: number,
): string | null {
  if (removed === 0 && failed === 0) return null;
  const parts: string[] = [];
  if (removed > 0) {
    parts.push(`${removed} worktree${removed === 1 ? "" : "s"} removed`);
  }
  if (failed > 0) {
    parts.push(
      `${failed} worktree${failed === 1 ? "" : "s"} couldn't be removed`,
    );
  }
  return parts.join(", ");
}

function emitTaskDeleteSummaryToast(
  epicToast: EpicDeleteToastParts,
  outcome: WorktreeCleanupOutcome,
): void {
  const summary = worktreeCleanupSummary(
    outcome.removed.length,
    outcome.failed.length,
  );
  if (summary === null) {
    emitEpicDeleteToast(epicToast.level, epicToast.message);
    return;
  }
  // A worktree that couldn't be removed downgrades the combined toast to a
  // warning even when every Task deleted cleanly.
  const level = outcome.failed.length > 0 ? "warning" : epicToast.level;
  emitEpicDeleteToast(level, `${epicToast.message} · ${summary}`);
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
