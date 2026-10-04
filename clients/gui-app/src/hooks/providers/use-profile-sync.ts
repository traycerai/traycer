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
import {
  profileSyncListKey,
  reconcileSyncListBatch,
  refreshProfileSyncAfterWrite,
  writeProfileSyncSavedRule,
  writeProfileSyncStoppedRule,
} from "@/hooks/providers/profile-sync-cache";
import { profileSyncMutationKeys } from "@/lib/query-keys/profile-sync-keys";
import { profileCopyDraftMutationAttempt } from "@/hooks/providers/profile-copy/use-profile-copy-draft-pending";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";
import type {
  ProfileSyncSelection,
  ProfileSyncPreview,
  ProfileSyncList,
  ProfileSyncScope,
  ProfileSyncResolve,
  ProfileSyncItem,
  ProfileSyncRule,
  ProfileSyncBatch,
} from "@traycer/protocol/host/profile-sync-schemas";

function sameSyncScope(
  left: ProfileSyncScope,
  right: ProfileSyncScope,
): boolean {
  if (left.kind === "all" || right.kind === "all")
    return left.kind === right.kind;
  const providers = new Set(right.providers);
  return (
    left.providers.length === right.providers.length &&
    left.providers.every((provider) => providers.has(provider))
  );
}

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
  const queryClient = useQueryClient();
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
      const { forgetSyncRuleId } = useProfileCopyFlowStore.getState();
      for (const rule of response.rules)
        forgetSyncRuleId(hostId, rule.destinationHostId, rule.ruleId);
      const previous = queryClient.getQueryData<ProfileSyncList>(
        profileSyncListKey(hostId),
      );
      // Destination writes can advance a receipt before the source driver.
      // Reconcile before caching so closing the dialog cannot lose that receipt.
      return {
        ...response,
        batches: response.batches.map((batch) => {
          const retained = previous?.batches.find(
            (prior) => prior.batchId === batch.batchId,
          );
          return retained === undefined
            ? batch
            : reconcileSyncListBatch(batch, retained);
        }),
      };
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
  RequestOfMethod<HostRpcRegistry, "providers.profileCopy.sync.start">,
  ProfileSyncBatch | undefined
> {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.profileCopy.sync.start",
    ProfileSyncBatch | undefined
  >({
    client: useHostClientForHostId(hostId),
    method: "providers.profileCopy.sync.start",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: profileSyncMutationKeys.start(hostId),
      onMutate: (request) =>
        queryClient
          .getQueryData<ProfileSyncList>(profileSyncListKey(hostId))
          ?.batches.find((batch) => batch.batchId === request.batchId),
      onSuccess: () => refreshProfileSyncAfterWrite(queryClient, hostId, null),
    },
  });
}

export function useProfileSyncSaveRule(
  hostId: string,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.profileCopy.sync.saveRule">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.profileCopy.sync.saveRule">,
  ProfileSyncRule | undefined
> {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.profileCopy.sync.saveRule",
    ProfileSyncRule | undefined
  >({
    client: useHostClientForHostId(hostId),
    method: "providers.profileCopy.sync.saveRule",
    mapVariables: (variables) => variables,
    onResponse: (response, request) => {
      if (
        request.sourceHostId !== hostId ||
        response.sourceHostId !== request.sourceHostId ||
        response.ruleId !== request.ruleId ||
        response.destinationHostId !== request.destinationHostId ||
        response.paused !== request.paused ||
        response.revision <= request.expectedRevision ||
        !sameSyncScope(response.scope, request.scope)
      ) {
        throw new Error("The device returned another sync rule.");
      }
    },
    options: {
      mutationKey: profileSyncMutationKeys.saveRule(hostId),
      onMutate: (request) =>
        queryClient
          .getQueryData<ProfileSyncList>(profileSyncListKey(hostId))
          ?.rules.find(
            (rule) => rule.destinationHostId === request.destinationHostId,
          ),
      onSuccess: (rule, _request, submitted) =>
        refreshProfileSyncAfterWrite(queryClient, hostId, () => {
          writeProfileSyncSavedRule(queryClient, rule, submitted);
          useProfileCopyFlowStore
            .getState()
            .forgetSyncRuleId(hostId, rule.destinationHostId, rule.ruleId);
        }),
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
    onResponse: (response, request) => {
      if (
        request.sourceHostId !== hostId ||
        response.batches.some((batch) => batch.sourceHostId !== hostId) ||
        response.rules.some((rule) => rule.sourceHostId !== hostId) ||
        response.rules.some((rule) => rule.ruleId === request.ruleId)
      ) {
        throw new Error("The device did not confirm stopping this sync rule.");
      }
    },
    options: {
      mutationKey: profileSyncMutationKeys.stopRule(hostId),
      onSuccess: (response, request) =>
        refreshProfileSyncAfterWrite(queryClient, hostId, () => {
          writeProfileSyncStoppedRule(
            queryClient,
            hostId,
            request.ruleId,
            response,
          );
          useProfileCopyFlowStore
            .getState()
            .forgetStoppedSyncRuleId(hostId, request.ruleId);
        }),
    },
  });
}

export interface ProfileSyncResolveVariables extends ProfileSyncResolve {
  readonly providerId: ProfileSyncItem["providerId"];
  readonly sourceProfileId: ProfileSyncItem["sourceProfileId"];
  readonly destinationHostId: string;
}

export function useProfileSyncResolve(
  hostId: string,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.profileCopy.sync.resolve">,
  HostRpcError,
  ProfileSyncResolveVariables
> {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.profileCopy.sync.resolve",
    unknown,
    ProfileSyncResolveVariables
  >({
    client: useHostClientForHostId(hostId),
    method: "providers.profileCopy.sync.resolve",
    mapVariables: (variables) => ({
      sourceHostId: variables.sourceHostId,
      batchId: variables.batchId,
      operationId: variables.operationId,
      action: variables.action,
      expectedDestination: variables.expectedDestination,
    }),
    onResponse: (response, request) => {
      if (
        request.sourceHostId !== hostId ||
        response.sourceHostId !== request.sourceHostId ||
        response.batchId !== request.batchId ||
        !response.items.some(
          (item) =>
            item.operationId === request.operationId &&
            item.providerId === request.providerId &&
            item.sourceProfileId === request.sourceProfileId &&
            item.destinationHostId === request.destinationHostId,
        )
      ) {
        throw new Error("The device returned another sync resolution.");
      }
    },
    options: {
      mutationKey: profileSyncMutationKeys.resolve(hostId),
      onSuccess: () => refreshProfileSyncAfterWrite(queryClient, hostId, null),
    },
  });
}
