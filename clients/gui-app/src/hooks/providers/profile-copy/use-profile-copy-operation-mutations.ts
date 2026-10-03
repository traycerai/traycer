import { cancelProfileSyncList } from "@/hooks/providers/profile-sync-cache";
import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import {
  profileCopyStatusKey,
  writeProfileCopyOperation,
  writeProfileCopyRetryOutcome,
} from "@/hooks/providers/profile-copy/profile-copy-cache";
import { profileCopyTransferKey } from "@/lib/profile-copy/profile-copy-model";
import { reportProfileCopyStarted } from "@/hooks/providers/profile-copy/profile-copy-observations";
import { hostQueryKeys, profileCopyMutationKeys } from "@/lib/query-keys";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";
import { useProfileCopyOperationsStore } from "@/stores/settings/profile-copy-operations-store";

/**
 * Operation verbs. All three are served by the SOURCE host only - `retry`
 * included: a destination answers it with an authority denial - so each hook
 * is bound to the source id captured when the copy was started.
 */

type StartRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.profileCopy.start"
>;
type StartResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.profileCopy.start"
>;
type CancelRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.profileCopy.cancel"
>;
type CancelResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.profileCopy.cancel"
>;
type RetryRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.profileCopy.retry"
>;
type RetryResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.profileCopy.retry"
>;

/**
 * An empty answer means the source created nothing: no destination survived
 * its start-time re-check. There is no operation to reopen, so the handle is
 * forgotten, and a dialog showing that operation goes back to the device
 * list, where each device says why. Hook-level for the same reason as the
 * acknowledgement below - the view that sent the start may already be gone.
 */
function forgetUnstartedOperation(request: StartRequest): void {
  const flow = useProfileCopyFlowStore.getState();
  const view = flow.view;
  if (view?.kind === "operation" && view.operationId === request.operationId) {
    flow.open({
      kind: "new",
      sourceHostId: request.sourceHostId,
      providerId: request.providerId,
      sourceProfileId: request.sourceProfileId,
    });
  }
  useProfileCopyOperationsStore.getState().remove(request.operationId);
}

/**
 * What a start refused outright (`E_INVALID_ARGUMENT`: nothing was created)
 * does to its handle:
 *
 * - `forget-handle`: the new-copy dialog's first start. The handle was
 *   recorded only so a LOST answer could be reopened; a refusal is an answer,
 *   so keeping it would list a copy that never existed as one that may have.
 * - `keep-handle`: the operation view's "Start again". The view is showing
 *   that handle and explains the refusal on it, with "Remove from list".
 */
export type ProfileCopyStartRefusal = "forget-handle" | "keep-handle";

/**
 * Starts an operation. The caller mints `operationId` BEFORE dispatch and
 * records the handle first, so a lost answer can be reopened and the same
 * request sent again: the source rejoins a start it already holds.
 */
export function useProfileCopyStartMutation(
  sourceHostId: string,
  refusal: ProfileCopyStartRefusal,
): UseMutationResult<StartResponse, HostRpcError, StartRequest> {
  const client = useHostClientForHostId(sourceHostId);
  const queryClient = useQueryClient();
  return useHostMutation<HostRpcRegistry, "providers.profileCopy.start">({
    client,
    method: "providers.profileCopy.start",
    options: {
      mutationKey: profileCopyMutationKeys.start(sourceHostId),
      onSuccess: (response, request) => {
        if (response.outcomes.length === 0) {
          forgetUnstartedOperation(request);
          return;
        }
        // Hook-level, not per-call: it must land even when the dialog that
        // sent the start has closed before the answer arrived - TanStack
        // drops a `mutate(..., { onSuccess })` whose observer has unmounted.
        useProfileCopyOperationsStore
          .getState()
          .acknowledgeStart(response.operationId);
        writeProfileCopyOperation(queryClient, response);
        reportProfileCopyStarted({
          operationId: request.operationId,
          providerId: request.providerId,
          sourceProfileId: request.sourceProfileId,
          startedCount: response.outcomes.length,
        });
      },
      // Hook-level for the same reason: a refusal that arrives after the
      // dialog closed must still forget the handle it was recorded under.
      onError: (error, request) => {
        if (
          refusal === "forget-handle" &&
          error.code === "E_INVALID_ARGUMENT"
        ) {
          useProfileCopyOperationsStore.getState().remove(request.operationId);
        }
      },
    },
    mapVariables: (variables) => variables,
  });
}

/**
 * Cancels every unfinished destination and keeps the finished ones. The
 * answer is the fenced state; destinations that did not answer the cancel
 * are carried by later `status` reads - the host never re-dials a failed
 * cancel on its own.
 */
export function useProfileCopyCancelMutation(
  sourceHostId: string,
  operationId: string,
): UseMutationResult<CancelResponse, HostRpcError, CancelRequest> {
  const client = useHostClientForHostId(sourceHostId);
  const queryClient = useQueryClient();
  return useHostMutation<HostRpcRegistry, "providers.profileCopy.cancel">({
    client,
    method: "providers.profileCopy.cancel",
    options: {
      mutationKey: profileCopyMutationKeys.cancel(sourceHostId, operationId),
      onSuccess: (response) => {
        writeProfileCopyOperation(queryClient, response);
      },
    },
    mapVariables: (variables) => variables,
  });
}

/**
 * Retries one destination: a fresh replacement attempt for a quarantined or
 * cancelled destination record, the same attempt re-driven for a source-local
 * block. `retryRequestId` is minted once per click and reused if the same
 * request is sent again; `expectedRevision` is the outcome the user was shown.
 */
export function useProfileCopyRetryMutation(
  sourceHostId: string,
  operationId: string,
): UseMutationResult<RetryResponse, HostRpcError, RetryRequest> {
  const client = useHostClientForHostId(sourceHostId);
  const queryClient = useQueryClient();
  return useHostMutation<HostRpcRegistry, "providers.profileCopy.retry">({
    client,
    method: "providers.profileCopy.retry",
    onResponse: (response, request) => {
      if (
        request.attempt.sourceHostId !== sourceHostId ||
        request.attempt.operationId !== operationId ||
        profileCopyTransferKey(response.outcome.attempt) !==
          profileCopyTransferKey(request.attempt)
      ) {
        throw new Error("The device returned another profile copy retry.");
      }
    },
    options: {
      mutationKey: profileCopyMutationKeys.retry(sourceHostId, operationId),
      onSuccess: async (response, request) => {
        await Promise.all([
          cancelProfileSyncList(queryClient, sourceHostId),
          queryClient.cancelQueries({
            queryKey: profileCopyStatusKey(sourceHostId, operationId),
          }),
        ]);
        if (response.result !== "unavailable")
          writeProfileCopyRetryOutcome(
            queryClient,
            request.attempt,
            response.outcome,
          );
        void queryClient.invalidateQueries({
          queryKey: profileCopyStatusKey(sourceHostId, operationId),
        });
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(
            sourceHostId,
            "providers.profileCopy.sync.list",
          ),
        });
      },
    },
    mapVariables: (variables) => variables,
  });
}
