import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { PreparedWorkspaceFolder } from "@traycer/protocol/host/epic/unary-schemas";
import type { WorkspaceRecentEntry } from "@traycer/protocol/host/workspace/unary-schemas";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { useWorkspaceListRecentWorkspaces } from "@/hooks/workspace/use-workspace-list-recent-workspaces-query";
import { useWorkspaceRecordRecentWorkspace } from "@/hooks/workspace/use-workspace-record-recent-workspace-mutation";
import { useWorkspaceFolderActionsForClient } from "@/hooks/workspace/use-workspace-folder-actions";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import type { WorktreeStagingKey } from "@/stores/worktree/worktree-intent-staging-store";

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
  readonly pendingPath: string | null;
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
    pendingPath: null,
    movingWorkspace: null,
    announcement: "",
  };
}

export function useRecentWorkspaces(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly activePaths: ReadonlyArray<string>;
  readonly activatePreparedFolders: (
    folders: ReadonlyArray<PreparedWorkspaceFolder>,
    hostId: string,
  ) => Promise<ReadonlyArray<string>>;
  readonly disabled: boolean;
  readonly surface: WorktreeStagingKey["surface"];
}): RecentWorkspacesController {
  const activatePreparedFolders = args.activatePreparedFolders;
  const analyticsSurface = args.surface;
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
  const pendingPathRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    activeHostIdRef.current = activeHostId;
    pendingPathRef.current = null;
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
    pendingPath: currentPendingPath,
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
  const activePathSet = useMemo(
    () => new Set(args.activePaths),
    [args.activePaths],
  );

  const forget = useCallback(
    async (workspacePath: string): Promise<boolean> => {
      updateState((current) => ({
        ...current,
        hiddenPaths: new Set(current.hiddenPaths).add(workspacePath),
      }));
      try {
        await forgetRecent(workspacePath);
        Analytics.getInstance().track(AnalyticsEvent.WorkspaceRecentForgotten, {
          surface: analyticsSurface,
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
    [analyticsSurface, forgetRecent, updateState],
  );

  const add = useCallback(
    async (workspacePath: string): Promise<boolean> => {
      if (pendingPathRef.current !== null) return false;
      const dispatchHostId = activeHostIdRef.current;
      if (dispatchHostId === null) return false;
      pendingPathRef.current = workspacePath;
      updateState((current) => ({
        ...current,
        failedPaths: withoutPath(current.failedPaths, workspacePath),
        pendingPath: workspacePath,
      }));
      const response = await prepareRecent(workspacePath).catch(() => null);
      const activatedPaths =
        response !== null &&
        activeHostIdRef.current === dispatchHostId &&
        response.folders.length > 0
          ? await activatePreparedFolders(
              response.folders,
              dispatchHostId,
            ).catch(() => [])
          : [];
      const succeeded =
        response !== null &&
        activeHostIdRef.current === dispatchHostId &&
        activatedPaths.length > 0;
      if (response !== null && succeeded) {
        const alreadyActive = response.folders.every((folder) =>
          activePathSet.has(folder.workspacePath),
        );
        for (const path of activatedPaths) {
          recordRecent({
            path,
            bumpRecency: true,
            failureFeedback: "silent",
          });
        }
        if (!activatedPaths.includes(workspacePath)) {
          void forgetRecent(workspacePath).catch(() => {
            updateState((current) => ({
              ...current,
              hiddenPaths: withoutPath(current.hiddenPaths, workspacePath),
            }));
          });
        }
        updateState((current) => ({
          ...current,
          hiddenPaths: new Set([
            ...current.hiddenPaths,
            workspacePath,
            ...activatedPaths,
          ]),
          announcement: alreadyActive
            ? "Workspace is already in context."
            : "Workspace added to context.",
        }));
      } else {
        updateState((current) => ({
          ...current,
          failedPaths: new Set(current.failedPaths).add(workspacePath),
        }));
      }
      Analytics.getInstance().track(AnalyticsEvent.WorkspaceContextAdded, {
        source: "recent",
        outcome: succeeded ? "succeeded" : "failed",
        surface: analyticsSurface,
      });
      if (pendingPathRef.current === workspacePath) {
        pendingPathRef.current = null;
      }
      updateState((current) => ({
        ...current,
        pendingPath:
          current.pendingPath === workspacePath ? null : current.pendingPath,
      }));
      return succeeded;
    },
    [
      activatePreparedFolders,
      analyticsSurface,
      activePathSet,
      forgetRecent,
      prepareRecent,
      recordRecent,
      updateState,
    ],
  );

  const locate = useCallback(
    async (workspacePath: string): Promise<boolean> => {
      const result = await pickAndPrepareFolders(false).catch(() => null);
      if (result === null || activeHostIdRef.current !== result.hostId) {
        return false;
      }
      const activatedPaths = await activatePreparedFolders(
        result.folders,
        result.hostId,
      ).catch((): ReadonlyArray<string> => []);
      if (activatedPaths.length === 0) return false;
      for (const path of activatedPaths) {
        recordRecent({
          path,
          bumpRecency: true,
          failureFeedback: "silent",
        });
      }
      let replacementForgotten = true;
      if (!activatedPaths.includes(workspacePath)) {
        replacementForgotten = await forget(workspacePath);
      }
      updateState((current) => ({
        ...current,
        hiddenPaths: new Set([
          ...current.hiddenPaths,
          workspacePath,
          ...activatedPaths,
        ]),
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
        surface: analyticsSurface,
      });
      return true;
    },
    [
      activatePreparedFolders,
      analyticsSurface,
      forget,
      pickAndPrepareFolders,
      recordRecent,
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
      let moved = false;
      try {
        await recordRecentAsync({
          path: workspacePath,
          bumpRecency: false,
          failureFeedback: "move_warning",
        });
        if (activeHostIdRef.current === moving.hostId) {
          updateState((current) => ({
            ...current,
            hiddenPaths: withoutPath(current.hiddenPaths, workspacePath),
            announcement: "Workspace moved to Recent.",
          }));
          Analytics.getInstance().track(AnalyticsEvent.WorkspaceMovedToRecent, {
            surface: analyticsSurface,
          });
          moved = true;
        }
      } catch {
        moved = false;
      }
      updateState((current) => ({
        ...current,
        movingWorkspace:
          current.movingWorkspace === moving ? null : current.movingWorkspace,
      }));
      return moved;
    },
    [
      analyticsSurface,
      currentMovingWorkspace,
      recordRecentAsync,
      supported,
      updateState,
    ],
  );

  const entries = useMemo(
    () =>
      supported
        ? (recentsQuery.data?.recentWorkspaces ?? []).filter(
            (entry) =>
              !activePathSet.has(entry.path) &&
              !currentHiddenPaths.has(entry.path),
          )
        : [],
    [
      activePathSet,
      currentHiddenPaths,
      recentsQuery.data?.recentWorkspaces,
      supported,
    ],
  );

  return {
    supported,
    entries,
    pendingPath: currentPendingPath,
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
