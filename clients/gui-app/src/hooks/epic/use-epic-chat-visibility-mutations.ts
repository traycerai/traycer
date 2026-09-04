import type { UseMutationResult } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import type {
  SetChatSharingDefaultRequest,
  SetChatSharingDefaultResponse,
  SetCloudChatVisibilityRequest,
  SetCloudChatVisibilityResponse,
} from "@traycer/protocol/host/epic/cloud-chat";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useHostMutation } from "@/hooks/host/use-host-query";
import {
  beginChatSharingInFlight,
  CHAT_SHARING_IN_FLIGHT_MESSAGE,
  endChatSharingInFlight,
} from "@/lib/chats/chat-sharing-inflight";
import {
  applyOwnCloudChatVisibility,
  invalidateCloudChatViewerScope,
  reconcileCloudChatSummary,
} from "@/lib/chats/cloud-chat-visibility-cache";
import { toastFromHostError } from "@/lib/host-error-toast";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import { toast } from "sonner";

/**
 * Thrown from `onMutate` when the session holds no cloud verdict. Both
 * sharing writes are CLOUD mutations sent through the Epic session's
 * local-host context, whose wire connection does not carry the renderer's
 * verdict - so an already-open row menu or confirm dialog could otherwise
 * spend the retained credential after a demotion. The gate is re-read HERE,
 * at dispatch, not only where the control was rendered.
 */
export const CHAT_SHARING_UNAUTHORIZED_MESSAGE =
  "chat sharing refused: the session holds no cloud verdict";

const UNVERIFIED_SHARING_TOAST =
  "Your sign-in couldn't be confirmed, so sharing changes are paused.";

function assertCloudAuthorizedForSharing(): void {
  if (!authorizesCloudCapability(useAuthStore.getState().status)) {
    throw new Error(CHAT_SHARING_UNAUTHORIZED_MESSAGE);
  }
}
import { epicMutationKeys } from "@/lib/query-keys";

/**
 * What a visibility mutation has to remember to refresh the right viewer's
 * cache afterwards: the host it was actually sent to, and the viewer whose
 * ACL-filtered list it wrote, both captured at mutate time so a host or
 * account swap in flight cannot redirect the write at another cache slot.
 */
interface CloudChatVisibilityMutationContext {
  readonly hostId: string | null;
  readonly viewerUserId: string;
}

/**
 * Mutation hook for `epic.setCloudChatVisibility` (optional host capability).
 *
 * Flips one cloud chat's visibility. Scoped to the surrounding Epic session's
 * owning host: the sidebar is outside every tile-level `TabHostProvider`, so
 * the write must follow the Epic stream that projected these rows.
 *
 * On success the returned row is folded into the viewer's list cache and every
 * cloud-chat read keyed for that viewer is invalidated. `{ chat }` is the
 * authority — there is no second list hop.
 */
export function useEpicSetCloudChatVisibility(): UseMutationResult<
  SetCloudChatVisibilityResponse,
  HostRpcError,
  SetCloudChatVisibilityRequest,
  CloudChatVisibilityMutationContext
> {
  const client = useEpicSessionHostClient();
  const queryClient = useQueryClient();
  const viewerUserId = useCloudChatViewerId();
  return useHostMutation<
    HostRpcRegistry,
    "epic.setCloudChatVisibility",
    CloudChatVisibilityMutationContext,
    SetCloudChatVisibilityRequest
  >({
    client,
    method: "epic.setCloudChatVisibility",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: epicMutationKeys.chatSharing(viewerUserId),
      onMutate: (variables) => {
        // Before the in-flight gate, so a refusal here never takes the gate
        // it would then have to release.
        assertCloudAuthorizedForSharing();
        if (!beginChatSharingInFlight(variables.taskId, viewerUserId)) {
          throw new Error(CHAT_SHARING_IN_FLIGHT_MESSAGE);
        }
        return {
          hostId: client?.getActiveHostId() ?? null,
          viewerUserId,
        };
      },
      onSuccess: (data, _variables, ctx) => {
        reconcileCloudChatSummary(queryClient, {
          hostId: ctx.hostId,
          viewerUserId: ctx.viewerUserId,
          chat: data.chat,
        });
        invalidateCloudChatViewerScope(
          queryClient,
          ctx.hostId,
          ctx.viewerUserId,
        );
      },
      onError: (error) => {
        if (error.message === CHAT_SHARING_IN_FLIGHT_MESSAGE) return;
        if (error.message === CHAT_SHARING_UNAUTHORIZED_MESSAGE) {
          toast.error(UNVERIFIED_SHARING_TOAST);
          return;
        }
        toastFromHostError(error, "Couldn't update sharing.");
      },
      onSettled: (_data, _error, variables, ctx) => {
        // onMutate threw (second write refused) → ctx is undefined and we
        // must not release the in-flight write that still owns the gate.
        if (ctx === undefined) return;
        endChatSharingInFlight(variables.taskId, ctx.viewerUserId);
      },
    },
  });
}

/**
 * Mutation hook for `epic.setChatSharingDefault` (optional host capability).
 *
 * Writes this caller's per-task default visibility and, when
 * `applyToExisting` is true, bulk-updates every chat they already own on the
 * task. Same Epic-session host scope as the per-chat flip.
 *
 * The response is a count, not the rows, so the list cache is patched by
 * applying the written visibility to every own row and the viewer's
 * cloud-chat reads are invalidated.
 */
export function useEpicSetChatSharingDefault(): UseMutationResult<
  SetChatSharingDefaultResponse,
  HostRpcError,
  SetChatSharingDefaultRequest,
  CloudChatVisibilityMutationContext
> {
  const client = useEpicSessionHostClient();
  const queryClient = useQueryClient();
  const viewerUserId = useCloudChatViewerId();
  return useHostMutation<
    HostRpcRegistry,
    "epic.setChatSharingDefault",
    CloudChatVisibilityMutationContext,
    SetChatSharingDefaultRequest
  >({
    client,
    method: "epic.setChatSharingDefault",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: epicMutationKeys.chatSharing(viewerUserId),
      onMutate: (variables) => {
        // Before the in-flight gate, so a refusal here never takes the gate
        // it would then have to release.
        assertCloudAuthorizedForSharing();
        if (!beginChatSharingInFlight(variables.taskId, viewerUserId)) {
          throw new Error(CHAT_SHARING_IN_FLIGHT_MESSAGE);
        }
        return {
          hostId: client?.getActiveHostId() ?? null,
          viewerUserId,
        };
      },
      onSuccess: (_data, variables, ctx) => {
        if (variables.applyToExisting) {
          applyOwnCloudChatVisibility(queryClient, {
            hostId: ctx.hostId,
            viewerUserId: ctx.viewerUserId,
            taskId: variables.taskId,
            visibility: variables.defaultVisibility,
          });
        }
        invalidateCloudChatViewerScope(
          queryClient,
          ctx.hostId,
          ctx.viewerUserId,
        );
      },
      onError: (error) => {
        if (error.message === CHAT_SHARING_IN_FLIGHT_MESSAGE) return;
        if (error.message === CHAT_SHARING_UNAUTHORIZED_MESSAGE) {
          toast.error(UNVERIFIED_SHARING_TOAST);
          return;
        }
        toastFromHostError(error, "Couldn't update sharing.");
      },
      onSettled: (_data, _error, variables, ctx) => {
        if (ctx === undefined) return;
        endChatSharingInFlight(variables.taskId, ctx.viewerUserId);
      },
    },
  });
}
