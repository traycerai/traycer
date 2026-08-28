import { useCallback, useRef } from "react";
import {
  useIsMutating,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { getNegotiatedHostMethodVersion } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  type PreparedWorkspaceFolder,
  type RemoveEpicRepoRequest,
  type RemoveEpicRepoResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import type {
  WorkspacePrepareFoldersRequestV14,
  WorkspacePrepareFoldersResponseV14,
} from "@traycer/protocol/host/workspace/unary-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostClient } from "@/lib/host/runtime";
import { useHostMutation } from "@/hooks/host/use-host-query";
import {
  hostQueryKeys,
  isCloudEpicTasksQueryKey,
  workspaceMutationKeys,
} from "@/lib/query-keys";
import { useRemoteFolderPickerStore } from "@/stores/workspace/remote-folder-picker-store";
import type { WorkspaceFolderInfo } from "@/stores/workspace/workspace-folders-store";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { workspaceMappingQueryPredicate } from "./use-resolved-workspace-folders-query";
import {
  useWorkspaceRecordRecentWorkspace,
  writeRecentWorkspacesCache,
} from "./use-workspace-record-recent-workspace-mutation";

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
  readonly repoIdentifiers: WorkspacePrepareFoldersResponseV14["repoIdentifiers"];
  readonly hostId: string;
};

export interface WorkspaceFolderActions {
  readonly isPreparing: boolean;
  readonly isRemoving: boolean;
  readonly prepareFoldersMutation: UseMutationResult<
    WorkspacePrepareFoldersResponseV14,
    HostRpcError,
    WorkspacePrepareFoldersRequestV14,
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
  const queryClient = useQueryClient();
  const recordRecentWorkspace = useWorkspaceRecordRecentWorkspace({
    client,
  }).mutate;
  const prepareRecentsByResponse = useRef(
    new WeakMap<WorkspacePrepareFoldersResponseV14, boolean>(),
  );

  const prepareFoldersMutation = useHostMutation<
    HostRpcRegistry,
    "workspace.prepareFolders",
    MutationContext
  >({
    client,
    method: "workspace.prepareFolders",
    mapVariables: (variables) => variables,
    onResponse: (response) => {
      const hostId = client?.getActiveHostId() ?? null;
      const version =
        hostId === null
          ? null
          : getNegotiatedHostMethodVersion(hostId, "workspace.prepareFolders");
      prepareRecentsByResponse.current.set(
        response,
        version?.major === 1 && version.minor >= 4,
      );
    },
    options: {
      mutationKey: workspaceMutationKeys.prepareFolders(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: async (result, variables, context) => {
        writeRecentWorkspacesCache(queryClient, context.hostId, result);
        if (variables.operation === "createAndPrepare") {
          await queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(
              context.hostId,
              "workspace.browseFolders",
            ),
            refetchType: "none",
          });
        }
        if (result.repoIdentifiers.length === 0) return;
        const queryKey = hostQueryKeys.methodScope(
          context.hostId,
          "workspace.resolvePathsByRepoIdentifiers",
        );
        const predicate = workspaceMappingQueryPredicate(
          queryKey.length,
          result.repoIdentifiers,
        );
        await queryClient.cancelQueries({ queryKey, predicate });
        await queryClient.invalidateQueries({ queryKey, predicate });
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

      // Hand the shared picker a requester PINNED to dispatchHost. A tab's
      // client is host-bound for life, but an app-wide one is not: if the
      // active host changed while the dialog was open, an unpinned client
      // would browse whichever host became active even though the path is
      // submitted to dispatchHost below.
      const selection = await useRemoteFolderPickerStore
        .getState()
        .requestPick(client.createRequester(dispatchHost));
      if (selection === null) {
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

      let request: WorkspacePrepareFoldersRequestV14;
      switch (selection.kind) {
        case "prepare":
          request = {
            operation: "prepare",
            folderPaths: [...selection.folderPaths],
            path: null,
            bumpRecency: recordAsRecent ? true : null,
          };
          break;
        case "createAndPrepare":
          request = {
            operation: "createAndPrepare",
            folderPaths: null,
            path: selection.path,
            bumpRecency: recordAsRecent ? true : null,
          };
          break;
      }
      const response = await prepareFoldersAsync(request).catch(() => null);
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

      const recordedRecentsInPrepare =
        prepareRecentsByResponse.current.get(response) === true;
      if (recordAsRecent && !recordedRecentsInPrepare) {
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
    [client, prepareFoldersAsync, recordRecentWorkspace],
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
