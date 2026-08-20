import { useCallback } from "react";
import {
  useIsMutating,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type {
  PreparedWorkspaceFolder,
  RemoveEpicRepoRequest,
  RemoveEpicRepoResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import type {
  WorkspacePrepareFoldersRequestV12,
  WorkspacePrepareFoldersResponseV12,
} from "@traycer/protocol/host/workspace/unary-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostClient } from "@/lib/host/runtime";
import { useHostMutation } from "@/hooks/host/use-host-query";
import {
  hostQueryKeys,
  isCloudEpicTasksQueryKey,
  workspaceMutationKeys,
} from "@/lib/query-keys";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useRemoteFolderPickerStore } from "@/stores/workspace/remote-folder-picker-store";
import type { WorkspaceFolderInfo } from "@/stores/workspace/workspace-folders-store";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { useWorkspaceRecordRecentWorkspace } from "./use-workspace-record-recent-workspace-mutation";

interface MutationContext {
  readonly hostId: string | null;
}

/**
 * Result of a user-initiated folder pick+prepare. `hostId` is the host that
 * was bound at dispatch (and re-validated after every await) — callers MUST
 * stamp folder rows with this value, never re-read the mutable client.
 */
export type PrepareFoldersWithHostResult = {
  readonly folders: readonly PreparedWorkspaceFolder[];
  readonly repoIdentifiers: WorkspacePrepareFoldersResponseV12["repoIdentifiers"];
  readonly hostId: string;
};

export interface WorkspaceFolderActions {
  readonly isPreparing: boolean;
  readonly isRemoving: boolean;
  readonly prepareFoldersMutation: UseMutationResult<
    WorkspacePrepareFoldersResponseV12,
    HostRpcError,
    WorkspacePrepareFoldersRequestV12,
    MutationContext
  >;
  readonly removeEpicRepoMutation: UseMutationResult<
    RemoveEpicRepoResponse,
    HostRpcError,
    RemoveEpicRepoRequest,
    MutationContext
  >;
  readonly pickAndPrepareFolders: (
    recordAsRecent: boolean,
  ) => Promise<PrepareFoldersWithHostResult | null>;
}

export function useWorkspaceFolderActions(): WorkspaceFolderActions {
  const client = useHostClient();
  return useWorkspaceFolderActionsForClient(client);
}

export function useWorkspaceFolderActionsForClient(
  client: HostClient<HostRpcRegistry> | null,
): WorkspaceFolderActions {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const recordRecentWorkspace = useWorkspaceRecordRecentWorkspace({
    client,
  }).mutate;

  const prepareFoldersMutation = useHostMutation<
    HostRpcRegistry,
    "workspace.prepareFolders",
    MutationContext
  >({
    client,
    method: "workspace.prepareFolders",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: workspaceMutationKeys.prepareFolders(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: async (_result, _variables, context) => {
        const queryKey = hostQueryKeys.methodScope(
          context.hostId,
          "workspace.resolvePathsByRepoIdentifiers",
        );
        await queryClient.cancelQueries({ queryKey });
        await queryClient.invalidateQueries({ queryKey });
      },
      // No success toast: added folders appear immediately in the picker rows.
      onError: (error) => {
        reportableErrorToast(
          "Couldn't add folders",
          {
            description: readWorkspaceActionErrorMessage(error),
          },
          {
            title: "Could not add workspace folders",
            message: null,
            code: null,
            source: "Workspace folders",
          },
        );
      },
    },
  });

  const removeEpicRepoMutation = useHostMutation<
    HostRpcRegistry,
    "epic.removeRepo",
    MutationContext
  >({
    client,
    method: "epic.removeRepo",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: workspaceMutationKeys.removeEpicRepo(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: async (_result, _variables, context) => {
        await queryClient.invalidateQueries({
          queryKey: hostQueryKeys.scope(context.hostId),
          predicate: (query) => !isCloudEpicTasksQueryKey(query.queryKey),
        });
      },
      onError: (error) => {
        reportableErrorToast(
          "Couldn't remove repository from epic",
          {
            description: readWorkspaceActionErrorMessage(error),
          },
          {
            title: "Could not remove repository from Epic",
            message: null,
            code: null,
            source: "Workspace folders",
          },
        );
      },
    },
  });

  const preparePending =
    useIsMutating({ mutationKey: workspaceMutationKeys.prepareFolders() }) > 0;
  const removeRepoPending =
    useIsMutating({ mutationKey: workspaceMutationKeys.removeEpicRepo() }) > 0;

  const { mutateAsync: prepareFoldersAsync } = prepareFoldersMutation;

  const pickAndPrepareFolders = useCallback(
    async (recordAsRecent: boolean) => {
      // Capture host identity at dispatch. Every post-await re-read must match
      // this id; otherwise refuse so we never stamp A-prepared paths as B.
      // Any bound host qualifies, not just a local one: a remote host reaches its
      // own filesystem through the RPC-backed browse dialog below.
      const dispatchHost = client?.getActiveHost() ?? null;
      if (client === null || dispatchHost === null) {
        reportableErrorToast("Select a host to add folders.", undefined, {
          title: "Could not add workspace folders",
          message: "No host was selected.",
          code: null,
          source: "Workspace folders",
        });
        return null;
      }
      const dispatchHostId = dispatchHost.hostId;

      // A local/mock host shares the client machine, so the shell's native OS
      // directory dialog picks real host paths. Everything else — a remote host,
      // or any shell without a native dialog (mobile/browser) — browses the
      // host's filesystem over `workspace.browseFolders`. Both resolve to the
      // same `readonly string[]` shape (`IRunnerHost.workspaceFolders
      // .pickFolders()`'s contract), so everything downstream
      // (`workspace.prepareFolders`, `addResolvedFolders`, …) runs unchanged
      // regardless of which picker produced the path.
      let folderPaths: readonly string[];
      if (
        canAssociateLocalWorkspaces(dispatchHost) &&
        runnerHost.workspaceFolders.canPickNatively
      ) {
        folderPaths = await runnerHost.workspaceFolders.pickFolders();
      } else {
        // Hand the picker a requester PINNED to dispatchHost. A tab's client is
        // host-bound for life, but an app-wide one is not: if the active host
        // changed while the dialog was open, an unpinned client would browse -
        // and record recents on - whichever host became active, even though the
        // path is submitted to dispatchHost below. The guard after this only
        // catches the prepare call, by which point the browsing already leaked.
        const pickedPath = await useRemoteFolderPickerStore
          .getState()
          .requestPick(client.createRequester(dispatchHost));
        folderPaths = pickedPath === null ? [] : [pickedPath];
      }
      if (folderPaths.length === 0) {
        return null;
      }
      if (!hostStillBound(client, dispatchHostId)) {
        reportableErrorToast(
          "Host changed while choosing folders. Try again.",
          undefined,
          {
            title: "Could not add workspace folders",
            message: "The active host changed while choosing folders.",
            code: null,
            source: "Workspace folders",
          },
        );
        return null;
      }

      const response = await prepareFoldersAsync({
        operation: "prepare",
        folderPaths: [...folderPaths],
        path: null,
        bumpRecency: null,
      }).catch(() => null);
      if (response === null) {
        return null;
      }
      if (!hostStillBound(client, dispatchHostId)) {
        reportableErrorToast(
          "Host changed while adding folders. Try again.",
          undefined,
          {
            title: "Could not add workspace folders",
            message: "The active host changed while adding folders.",
            code: null,
            source: "Workspace folders",
          },
        );
        return null;
      }

      if (recordAsRecent) {
        for (const folder of response.folders) {
          recordRecentWorkspace({
            path: folder.workspacePath,
            bumpRecency: true,
            failureFeedback: "silent",
          });
        }
      }

      return {
        folders: response.folders,
        repoIdentifiers: response.repoIdentifiers,
        hostId: dispatchHostId,
      };
    },
    [client, runnerHost, prepareFoldersAsync, recordRecentWorkspace],
  );

  return {
    isPreparing: preparePending,
    isRemoving: removeRepoPending,
    prepareFoldersMutation,
    removeEpicRepoMutation,
    pickAndPrepareFolders,
  };
}

export function preparedWorkspaceFolderToWorkspaceFolderInfo(
  folder: PreparedWorkspaceFolder,
  hostId: string | null,
): WorkspaceFolderInfo {
  return {
    path: folder.workspacePath,
    name: folder.workspaceName,
    repoIdentifier: folder.repoIdentifier,
    hostId,
  };
}

function hostStillBound(
  client: HostClient<HostRpcRegistry> | null,
  dispatchHostId: string,
): boolean {
  if (client === null) return false;
  return client.getActiveHostId() === dispatchHostId;
}

function canAssociateLocalWorkspaces(
  activeHost: HostDirectoryEntry | null,
): activeHost is HostDirectoryEntry & {
  readonly kind: "local" | "mock";
} {
  return (
    activeHost !== null &&
    (activeHost.kind === "local" || activeHost.kind === "mock")
  );
}

function readWorkspaceActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

/**
 * Pure helper for tests: stamp prepared folders with a dispatch-time host id.
 * Mirrors the production post-prepare mapping without re-reading a client.
 */
export function stampPreparedFoldersWithDispatchHost(
  folders: readonly PreparedWorkspaceFolder[],
  dispatchHostId: string,
): readonly WorkspaceFolderInfo[] {
  return folders.map((folder) =>
    preparedWorkspaceFolderToWorkspaceFolderInfo(folder, dispatchHostId),
  );
}
