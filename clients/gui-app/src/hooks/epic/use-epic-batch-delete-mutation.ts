import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { hostQueryKeys, epicMutationKeys } from "@/lib/query-keys";
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

interface BatchDeleteEpicMutationContext {
  readonly hostId: string | null;
  readonly userId: string | null;
  readonly epicTitlesById: Readonly<Record<string, string>>;
}

type DeleteNavigationTarget = HeaderTab | null | undefined;

export function useEpicBatchDelete(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "epic.batchDelete">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "epic.batchDelete">,
  BatchDeleteEpicMutationContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const activePathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  return useHostMutation<
    HostRpcRegistry,
    "epic.batchDelete",
    BatchDeleteEpicMutationContext
  >({
    client,
    method: "epic.batchDelete",
    mapVariables: (variables) => variables,
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
      onSuccess: (data, _variables, ctx) => {
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
        if (failures.length === 0) {
          toast.success(
            deletedEpicSuccessToastMessage(deletedIds, ctx.epicTitlesById),
          );
        } else if (successes === 0) {
          toast.error(
            failures.length === 1
              ? "Couldn't delete epic."
              : `Couldn't delete ${failures.length} epics.`,
          );
        } else {
          toast.warning(
            `Deleted ${successes} of ${data.results.length}; ${failures.length} failed.`,
          );
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
