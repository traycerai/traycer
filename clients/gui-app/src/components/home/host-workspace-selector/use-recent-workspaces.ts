import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { WorkspaceRecentEntry } from "@traycer/protocol/host/workspace/unary-schemas";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { useWorkspaceListRecentWorkspaces } from "@/hooks/workspace/use-workspace-list-recent-workspaces-query";
import { useWorkspaceRecordRecentWorkspace } from "@/hooks/workspace/use-workspace-record-recent-workspace-mutation";
import {
  preparedWorkspaceFolderToWorkspaceFolderInfo,
  useWorkspaceFolderActionsForClient,
} from "@/hooks/workspace/use-workspace-folder-actions";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import type { WorktreeStagingKey } from "@/stores/worktree/worktree-intent-staging-store";
import type { HomeWorkspaceSource } from "./use-home-workspace-source";

interface MutationContext {
  readonly hostId: string | null;
}

interface MovingWorkspace {
  readonly hostId: string;
  readonly path: string;
}

interface RecentWorkspaceState {
  readonly hostId: string | null;
  readonly failedPaths: ReadonlySet<string>;
  readonly hiddenPaths: ReadonlySet<string>;
  readonly movingWorkspace: MovingWorkspace | null;
  readonly announcement: string;
}

export interface RecentWorkspacesController {
  readonly supported: boolean;
  readonly entries: readonly WorkspaceRecentEntry[];
  readonly pendingPath: string | null;
  readonly movingPath: string | null;
  readonly failedPaths: ReadonlySet<string>;
  readonly announcement: string;
  readonly moveToRecent: (path: string) => Promise<boolean>;
  readonly add: (path: string) => Promise<boolean>;
  readonly locate: (path: string) => Promise<boolean>;
  readonly forget: (path: string) => Promise<boolean>;
}

const EMPTY_PATHS: ReadonlySet<string> = new Set<string>();

function emptyRecentWorkspaceState(
  hostId: string | null,
): RecentWorkspaceState {
  return {
    hostId,
    failedPaths: EMPTY_PATHS,
    hiddenPaths: EMPTY_PATHS,
    movingWorkspace: null,
    announcement: "",
  };
}

export function useRecentWorkspaces(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly workspaceSource: HomeWorkspaceSource;
  readonly disabled: boolean;
  readonly surface: WorktreeStagingKey["surface"];
}): RecentWorkspacesController {
  const version = useHostNegotiatedMethodVersion(
    args.client,
    "workspace.prepareFolders",
  );
  const supported =
    !args.disabled &&
    version !== null &&
    version !== false &&
    version.major === 1 &&
    version.minor >= 2;
  const queryClient = useQueryClient();
  const recentsQuery = useWorkspaceListRecentWorkspaces({
    client: args.client,
    enabled: supported,
  });
  const recordRecentMutation = useWorkspaceRecordRecentWorkspace({
    client: args.client,
  });
  const recordRecent = recordRecentMutation.mutate;
  const recordRecentAsync = recordRecentMutation.mutateAsync;
  const pickAndPrepareFolders = useWorkspaceFolderActionsForClient(
    args.client,
  ).pickAndPrepareFolders;
  const activeHostId = args.hostId;
  const activeHostIdRef = useRef(activeHostId);
  useLayoutEffect(() => {
    activeHostIdRef.current = activeHostId;
  }, [activeHostId]);
  const [state, setState] = useState<RecentWorkspaceState>(() =>
    emptyRecentWorkspaceState(activeHostId),
  );
  const currentState =
    state.hostId === activeHostId
      ? state
      : emptyRecentWorkspaceState(activeHostId);
  const {
    failedPaths: currentFailedPaths,
    hiddenPaths: currentHiddenPaths,
    movingWorkspace: currentMovingWorkspace,
    announcement: currentAnnouncement,
  } = currentState;
  const updateState = useCallback(
    (update: (current: RecentWorkspaceState) => RecentWorkspaceState): void => {
      setState((current) =>
        update(
          current.hostId === activeHostId
            ? current
            : emptyRecentWorkspaceState(activeHostId),
        ),
      );
    },
    [activeHostId],
  );

  const prepareMutation = useHostMutation<
    HostRpcRegistry,
    "workspace.prepareFolders",
    MutationContext,
    string
  >({
    client: args.client,
    method: "workspace.prepareFolders",
    mapVariables: (path) => ({
      operation: "prepare",
      folderPaths: [path],
      path: null,
      bumpRecency: null,
    }),
    options: {
      retry: false,
      onMutate: () => ({
        hostId: args.client?.getActiveHostId() ?? null,
      }),
      onSuccess: async (_result, _variables, context) => {
        await queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(
            context.hostId,
            "workspace.resolvePathsByRepoIdentifiers",
          ),
        });
      },
      // Reactivation errors are rendered on the row with recovery actions.
    },
  });

  const forgetMutation = useHostMutation<
    HostRpcRegistry,
    "workspace.prepareFolders",
    MutationContext,
    string
  >({
    client: args.client,
    method: "workspace.prepareFolders",
    mapVariables: (path) => ({
      operation: "forgetRecentWorkspace",
      folderPaths: null,
      path,
      bumpRecency: null,
    }),
    options: {
      retry: false,
      onMutate: () => ({
        hostId: args.client?.getActiveHostId() ?? null,
      }),
      onSuccess: async (_result, _variables, context) => {
        await queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(
            context.hostId,
            "workspace.prepareFolders",
          ),
        });
      },
    },
  });
  const prepareRecent = prepareMutation.mutateAsync;
  const forgetRecent = forgetMutation.mutateAsync;

  const forget = useCallback(
    async (workspacePath: string): Promise<boolean> => {
      updateState((current) => ({
        ...current,
        hiddenPaths: new Set(current.hiddenPaths).add(workspacePath),
      }));
      try {
        await forgetRecent(workspacePath);
        Analytics.getInstance().track(AnalyticsEvent.WorkspaceRecentForgotten, {
          surface: args.surface,
        });
        updateState((current) => ({
          ...current,
          failedPaths: withoutPath(current.failedPaths, workspacePath),
          announcement: "Workspace forgotten.",
        }));
        return true;
      } catch {
        updateState((current) => ({
          ...current,
          hiddenPaths: withoutPath(current.hiddenPaths, workspacePath),
        }));
        reportableErrorToast(
          "Couldn't forget workspace. Try again.",
          undefined,
          {
            title: "Could not forget recent workspace",
            message: null,
            code: null,
            source: "Workspace folders",
          },
        );
        return false;
      }
    },
    [args.surface, forgetRecent, updateState],
  );

  const add = useCallback(
    async (workspacePath: string): Promise<boolean> => {
      const dispatchHostId = activeHostIdRef.current;
      updateState((current) => ({
        ...current,
        failedPaths: withoutPath(current.failedPaths, workspacePath),
      }));
      try {
        const response = await prepareRecent(workspacePath);
        if (
          dispatchHostId === null ||
          activeHostIdRef.current !== dispatchHostId ||
          response.folders.length === 0
        ) {
          updateState((current) => ({
            ...current,
            failedPaths: new Set(current.failedPaths).add(workspacePath),
          }));
          Analytics.getInstance().track(AnalyticsEvent.WorkspaceContextAdded, {
            source: "recent",
            outcome: "failed",
            surface: args.surface,
          });
          return false;
        }
        const alreadyActive = response.folders.every((folder) =>
          args.workspaceSource.folders.includes(folder.workspacePath),
        );
        args.workspaceSource.addResolvedFolders(
          response.folders.map((folder) =>
            preparedWorkspaceFolderToWorkspaceFolderInfo(
              folder,
              dispatchHostId,
            ),
          ),
        );
        for (const folder of response.folders) {
          recordRecent({
            path: folder.workspacePath,
            bumpRecency: true,
            failureFeedback: "silent",
          });
        }
        const canonicalPaths = new Set(
          response.folders.map((folder) => folder.workspacePath),
        );
        if (!canonicalPaths.has(workspacePath)) {
          updateState((current) => ({
            ...current,
            hiddenPaths: new Set(current.hiddenPaths).add(workspacePath),
          }));
          void forgetRecent(workspacePath).catch(() => {
            updateState((current) => ({
              ...current,
              hiddenPaths: withoutPath(current.hiddenPaths, workspacePath),
            }));
          });
        }
        updateState((current) => ({
          ...current,
          announcement: alreadyActive
            ? "Workspace is already in context."
            : "Workspace added to context.",
        }));
        Analytics.getInstance().track(AnalyticsEvent.WorkspaceContextAdded, {
          source: "recent",
          outcome: "succeeded",
          surface: args.surface,
        });
        return true;
      } catch {
        updateState((current) => ({
          ...current,
          failedPaths: new Set(current.failedPaths).add(workspacePath),
        }));
        Analytics.getInstance().track(AnalyticsEvent.WorkspaceContextAdded, {
          source: "recent",
          outcome: "failed",
          surface: args.surface,
        });
        return false;
      }
    },
    [
      args.surface,
      args.workspaceSource,
      forgetRecent,
      prepareRecent,
      recordRecent,
      updateState,
    ],
  );

  const locate = useCallback(
    async (workspacePath: string): Promise<boolean> => {
      const result = await pickAndPrepareFolders(true);
      if (result === null || activeHostIdRef.current !== result.hostId) {
        return false;
      }
      const folders = result.folders.map((folder) =>
        preparedWorkspaceFolderToWorkspaceFolderInfo(folder, result.hostId),
      );
      if (folders.length === 0) return false;
      args.workspaceSource.addResolvedFolders(folders);
      let replacementForgotten = true;
      if (!folders.some((folder) => folder.path === workspacePath)) {
        replacementForgotten = await forget(workspacePath);
      }
      updateState((current) => ({
        ...current,
        failedPaths: replacementForgotten
          ? withoutPath(current.failedPaths, workspacePath)
          : new Set(current.failedPaths).add(workspacePath),
        announcement: replacementForgotten
          ? "Workspace location updated and added to context."
          : "Workspace added to context. The old entry is still in Recent.",
      }));
      Analytics.getInstance().track(AnalyticsEvent.WorkspaceContextAdded, {
        source: "browse",
        outcome: replacementForgotten ? "succeeded" : "failed",
        surface: args.surface,
      });
      return true;
    },
    [
      args.surface,
      args.workspaceSource,
      forget,
      pickAndPrepareFolders,
      updateState,
    ],
  );
  const moveToRecent = useCallback(
    async (workspacePath: string): Promise<boolean> => {
      if (!supported || currentMovingWorkspace !== null) return false;
      const dispatchHostId = activeHostIdRef.current;
      if (dispatchHostId === null) return false;
      const moving = { hostId: dispatchHostId, path: workspacePath };
      updateState((current) => ({ ...current, movingWorkspace: moving }));
      try {
        await recordRecentAsync({
          path: workspacePath,
          bumpRecency: false,
          failureFeedback: "move_warning",
        });
        if (activeHostIdRef.current !== moving.hostId) {
          return false;
        }
        updateState((current) => ({
          ...current,
          announcement: "Workspace moved to Recent.",
        }));
        Analytics.getInstance().track(AnalyticsEvent.WorkspaceMovedToRecent, {
          surface: args.surface,
        });
        return true;
      } catch {
        return false;
      } finally {
        updateState((current) => ({
          ...current,
          movingWorkspace:
            current.movingWorkspace === moving ? null : current.movingWorkspace,
        }));
      }
    },
    [
      args.surface,
      currentMovingWorkspace,
      recordRecentAsync,
      supported,
      updateState,
    ],
  );

  const activePaths = args.workspaceSource.folders;
  const entries = useMemo(
    () =>
      supported
        ? (recentsQuery.data?.recentWorkspaces ?? []).filter(
            (entry) =>
              !activePaths.includes(entry.path) &&
              !currentHiddenPaths.has(entry.path),
          )
        : [],
    [
      activePaths,
      currentHiddenPaths,
      recentsQuery.data?.recentWorkspaces,
      supported,
    ],
  );

  return {
    supported,
    entries,
    pendingPath: prepareMutation.isPending ? prepareMutation.variables : null,
    movingPath: currentMovingWorkspace?.path ?? null,
    failedPaths: currentFailedPaths,
    announcement: currentAnnouncement,
    moveToRecent,
    add,
    locate,
    forget,
  };
}

function withoutPath(
  paths: ReadonlySet<string>,
  path: string,
): ReadonlySet<string> {
  if (!paths.has(path)) return paths;
  const next = new Set(paths);
  next.delete(path);
  return next;
}
