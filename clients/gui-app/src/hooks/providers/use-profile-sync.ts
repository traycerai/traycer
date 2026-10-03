import {
  useQueryClient,
  useIsMutating,
  type UseQueryResult,
  type UseMutationResult,
} from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import {
  useHostQuery,
  useHostQueryWithResponseMap,
  useHostMutation,
} from "@/hooks/host/use-host-query";
import { hostQueryKeys } from "@/lib/query-keys";
import { profileSyncMutationKeys } from "@/lib/query-keys/profile-sync-keys";
import { profileCopyDraftMutationAttempt } from "@/hooks/providers/profile-copy/use-profile-copy-draft-pending";
import type {
  ProfileSyncSelection,
  ProfileSyncPreview,
  ProfileSyncList,
} from "@traycer/protocol/host/profile-sync-schemas";

/** Keep source and nested destination observers mounted until their RPCs settle. */
export function useProfileSyncPending(hostId: string | null): boolean {
  return (
    useIsMutating({
      predicate: (mutation) => {
        if (hostId === null) return false;
        const key = mutation.options.mutationKey;
        const method = key?.[0];
        if (
          key?.[1] === hostId &&
          typeof method === "string" &&
          (method.startsWith("providers.profileCopy.sync.") ||
            method === "providers.profileCopy.retry")
        ) {
          return true;
        }
        return (
          profileCopyDraftMutationAttempt(key, mutation.state.variables)
            ?.sourceHostId === hostId
        );
      },
    }) > 0
  );
}

export function useProfileSyncList(
  hostId: string,
): UseQueryResult<ProfileSyncList, HostRpcError> {
  return useHostQueryWithResponseMap<
    HostRpcRegistry,
    "providers.profileCopy.sync.list",
    ProfileSyncList
  >({
    client: useHostClientForHostId(hostId),
    method: "providers.profileCopy.sync.list",
    params: { sourceHostId: hostId },
    cacheKeyIdentity: undefined,
    options: { poll: true, retry: false },
    mapResponse: ({ response }) => {
      // Validate against this request before caching: a rejected poll must
      // retain the last valid source-local history and its mounted editors.
      if (
        response.batches.some((batch) => batch.sourceHostId !== hostId) ||
        response.rules.some((rule) => rule.sourceHostId !== hostId)
      ) {
        throw new Error("The device returned sync history for another source.");
      }
      return response;
    },
  });
}
export function useProfileSyncPreview(
  hostId: string,
  selection: ProfileSyncSelection | null,
): UseQueryResult<ProfileSyncPreview, HostRpcError> {
  return useHostQuery<HostRpcRegistry, "providers.profileCopy.sync.preview">({
    client: useHostClientForHostId(hostId),
    method: "providers.profileCopy.sync.preview",
    params: selection ?? {
      sourceHostId: hostId,
      scope: { kind: "all" },
      destinationHostIds: [],
    },
    cacheKeyIdentity: undefined,
    options: { enabled: selection !== null, retry: false, staleTime: 15_000 },
  });
}

export function useProfileSyncStart(
  hostId: string,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.profileCopy.sync.start">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.profileCopy.sync.start">
> {
  const queryClient = useQueryClient();
  return useHostMutation<HostRpcRegistry, "providers.profileCopy.sync.start">({
    client: useHostClientForHostId(hostId),
    method: "providers.profileCopy.sync.start",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: profileSyncMutationKeys.start(hostId),
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(
            hostId,
            "providers.profileCopy.sync.list",
          ),
        });
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(
            hostId,
            "providers.profileCopy.sync.preview",
          ),
        });
      },
    },
  });
}

export function useProfileSyncSaveRule(
  hostId: string,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.profileCopy.sync.saveRule">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.profileCopy.sync.saveRule">
> {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.profileCopy.sync.saveRule"
  >({
    client: useHostClientForHostId(hostId),
    method: "providers.profileCopy.sync.saveRule",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: profileSyncMutationKeys.saveRule(hostId),
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(
            hostId,
            "providers.profileCopy.sync.list",
          ),
        });
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(
            hostId,
            "providers.profileCopy.sync.preview",
          ),
        });
      },
    },
  });
}

export function useProfileSyncStopRule(
  hostId: string,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.profileCopy.sync.stopRule">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.profileCopy.sync.stopRule">
> {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.profileCopy.sync.stopRule"
  >({
    client: useHostClientForHostId(hostId),
    method: "providers.profileCopy.sync.stopRule",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: profileSyncMutationKeys.stopRule(hostId),
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(
            hostId,
            "providers.profileCopy.sync.list",
          ),
        });
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(
            hostId,
            "providers.profileCopy.sync.preview",
          ),
        });
      },
    },
  });
}

export function useProfileSyncResolve(
  hostId: string,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.profileCopy.sync.resolve">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.profileCopy.sync.resolve">
> {
  const queryClient = useQueryClient();
  return useHostMutation<HostRpcRegistry, "providers.profileCopy.sync.resolve">(
    {
      client: useHostClientForHostId(hostId),
      method: "providers.profileCopy.sync.resolve",
      mapVariables: (variables) => variables,
      options: {
        mutationKey: profileSyncMutationKeys.resolve(hostId),
        onSuccess: () => {
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(
              hostId,
              "providers.profileCopy.sync.list",
            ),
          });
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(
              hostId,
              "providers.profileCopy.sync.preview",
            ),
          });
        },
      },
    },
  );
}
