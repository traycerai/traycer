import { hostWriteFailureOutcome } from "@/lib/host/host-write-outcome";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { useQueryClient } from "@tanstack/react-query";
import type { CommentArtifactKind } from "@/lib/comments/artifact-comment-kind";
import type {
  CreateCommentThreadRequest,
  ReplyToCommentThreadRequest,
  EditCommentRequest,
  DeleteCommentRequest,
  SetCommentThreadResolvedRequest,
  DeleteCommentThreadRequest,
  ListCommentThreadsResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import { extractUserMentionIds } from "@traycer/protocol/notifications/comment-notification-utils";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostMutation } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";
import {
  HOST_UNKNOWN_OUTCOME_NOTICE,
  toastFromHostError,
} from "@/lib/host-error-toast";
import { toastIndeterminateHostWrite } from "@/lib/owner-host-write-error-toast";
import { commentThreadsQueryKey } from "./use-epic-comment-threads";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { isLocalHomedEpicHandle } from "@/lib/epic-selectors";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import type {
  OpenEpicStoreHandle,
  PoolCommentWrite,
} from "@/stores/epics/open-epic/store";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import { toast } from "sonner";

/**
 * Thrown from every `onMutate` below when the session holds no cloud verdict
 * and the epic is not local-homed. Comment writes go to the cloud-backed
 * artifact room through the Epic session's local-host context, whose wire
 * connection does not carry the renderer's verdict - so a draft or thread
 * control still rendered after a demotion could otherwise spend the retained
 * credential. The gate is re-read HERE, at dispatch, not only where
 * `useEpicCommentRoomAvailability` rendered (or hid) the control. Same shape
 * as the chat-sharing writes' `CHAT_SHARING_UNAUTHORIZED_MESSAGE`.
 */
export const COMMENT_WRITE_UNAUTHORIZED_MESSAGE =
  "comment write refused: the session holds no cloud verdict";

const UNVERIFIED_COMMENT_TOAST =
  "Your sign-in couldn't be confirmed, so comment changes are paused.";

function assertCommentWriteAuthorized(
  handle: OpenEpicStoreHandle | null,
): void {
  if (authorizesCloudCapability(useAuthStore.getState().status)) return;
  // The local-home exemption, read LIVE at dispatch from the epic session's
  // current-then-retained durability statement - the selection
  // `useEpicCommentRoomAvailability` rendered the control from, so a
  // reconnect beat that clears the cycle's status cannot refuse a write the
  // surface is still offering. The surrounding session tree's handle first
  // (every comment surface mounts inside one), the registered session
  // otherwise - the same seam `useRegisteredEpicLocalHome` reads. An epic
  // with neither is not provably local and reads as cloud.
  if (isLocalHomedEpicHandle(handle)) return;
  throw new Error(COMMENT_WRITE_UNAUTHORIZED_MESSAGE);
}

/**
 * Mutation hooks for the host comment-thread RPC surface.
 *
 * After every successful mutation the cached
 * `epic.listCommentThreads` query for the targeted artifact is invalidated,
 * so the sidebar + decoration plugin re-render against the host's
 * authoritative thread snapshot. We don't apply optimistic updates: the
 * host ack is fast and the underlying Y.Doc state propagates through the
 * `/stream` transport anyway, so optimistic mutation would just race the
 * incoming CRDT update.
 *
 * Each mutation captures the serving peer and viewer in `onMutate` so its
 * response updates the cache entry for that request.
 *
 * Every hook here takes its `client` from the caller and there is no app-wide
 * wrapper: both mount contexts are Epic-scoped (the collab tile's floating
 * draft, the Epic sidebar's thread cards). An app-wide read wrote the comment
 * to whichever host the app was pointed at, and then invalidated THAT host's
 * cache key - so the surface the user was looking at never refreshed (D15).
 */
interface MutationContext {
  readonly hostId: string | null;
  readonly viewerUserId: string;
  readonly poolWrite: PoolCommentWrite | null;
}

function useThreadInvalidator(): (
  context: MutationContext,
  epicId: string,
  artifactType: CommentArtifactKind,
  artifactId: string,
) => void {
  const queryClient = useQueryClient();
  return ({ hostId, viewerUserId }, epicId, artifactType, artifactId) => {
    if (hostId === null) return;
    const scope = {
      queryKey: commentThreadsQueryKey(
        hostId,
        { epicId, artifactType, artifactId },
        viewerUserId,
      ),
    };
    if (hostId === POOL_HOST_ID)
      void queryClient.cancelQueries(scope, { revert: true });
    void queryClient.invalidateQueries(scope);
  };
}

interface CommentWriteVariables {
  readonly epicId: string;
  readonly artifactType: CommentArtifactKind;
  readonly artifactId: string;
}

function useCommentWriteLifecycle(
  client: HostClient<HostRpcRegistry> | null,
  fallback: string,
) {
  const invalidate = useThreadInvalidator();
  const sessionHandle = useMaybeOpenEpicHandle();
  return {
    invalidate,
    onMutate: (variables: CommentWriteVariables): MutationContext => {
      const handle =
        sessionHandle ?? getOpenEpicRegistry().peek(variables.epicId);
      assertCommentWriteAuthorized(handle);
      const hostId = client?.getActiveHostId() ?? null;
      const poolWrite =
        hostId === POOL_HOST_ID &&
        handle?.hostId === POOL_HOST_ID &&
        handle.epicId === variables.epicId
          ? handle.store.getState().beginPoolCommentWrite()
          : null;
      return {
        hostId,
        viewerUserId: useAuthStore.getState().contextMetadata?.userId ?? "",
        poolWrite,
      };
    },
    onError: (
      error: HostRpcError,
      variables: CommentWriteVariables,
      ctx: MutationContext | undefined,
    ): void => {
      if (
        ctx?.hostId === POOL_HOST_ID &&
        hostWriteFailureOutcome(error, ctx.hostId) === "unknown"
      ) {
        showUnknownCommentWrite(ctx.poolWrite);
        invalidate(
          ctx,
          variables.epicId,
          variables.artifactType,
          variables.artifactId,
        );
        return;
      }
      ctx?.poolWrite?.settle();
      if (error.message === COMMENT_WRITE_UNAUTHORIZED_MESSAGE) {
        toast.error(UNVERIFIED_COMMENT_TOAST);
        return;
      }
      toastFromHostError(error, fallback);
    },
  };
}

function showUnknownCommentWrite(write: PoolCommentWrite | null): void {
  if (write === null) {
    toastIndeterminateHostWrite();
    return;
  }
  const noticeId = crypto.randomUUID();
  if (!write.markUnknown(() => toast.dismiss(noticeId))) return;
  toast(HOST_UNKNOWN_OUTCOME_NOTICE, {
    id: noticeId,
    duration: Infinity,
    onDismiss: write.settle,
  });
}

export function useCreateCommentThreadForClient(
  client: HostClient<HostRpcRegistry> | null,
) {
  const { invalidate, ...lifecycle } = useCommentWriteLifecycle(
    client,
    "Couldn't post comment.",
  );
  return useHostMutation({
    client,
    method: "epic.createCommentThread",
    requiredHostMethodVersion: (variables) =>
      variables.anchor === undefined
        ? null
        : {
            method: "epic.createCommentThread",
            version: { major: 1, minor: 2 },
          },
    mapVariables: (
      variables: CreateCommentThreadRequest & {
        artifactType: CommentArtifactKind;
      },
    ) => variables,
    options: {
      ...lifecycle,
      onSuccess: (_data, variables, ctx) => {
        ctx.poolWrite?.settle();
        Analytics.getInstance().track(AnalyticsEvent.CommentCreated, {
          has_mention: extractUserMentionIds(variables.content).length > 0,
        });
        invalidate(
          ctx,
          variables.epicId,
          variables.artifactType,
          variables.artifactId,
        );
      },
    },
  });
}

export function useReplyToCommentThreadForClient(
  client: HostClient<HostRpcRegistry> | null,
) {
  const { invalidate, ...lifecycle } = useCommentWriteLifecycle(
    client,
    "Couldn't post reply.",
  );
  return useHostMutation({
    client,
    method: "epic.replyToCommentThread",
    mapVariables: (
      variables: ReplyToCommentThreadRequest & {
        artifactType: CommentArtifactKind;
      },
    ) => variables,
    options: {
      ...lifecycle,
      onSuccess: (_data, variables, ctx) => {
        ctx.poolWrite?.settle();
        Analytics.getInstance().track(AnalyticsEvent.CommentReplied, {
          has_mention: extractUserMentionIds(variables.content).length > 0,
        });
        invalidate(
          ctx,
          variables.epicId,
          variables.artifactType,
          variables.artifactId,
        );
      },
    },
  });
}

export function useEditCommentForClient(
  client: HostClient<HostRpcRegistry> | null,
) {
  const { invalidate, ...lifecycle } = useCommentWriteLifecycle(
    client,
    "Couldn't update comment.",
  );
  return useHostMutation({
    client,
    method: "epic.editComment",
    mapVariables: (
      variables: EditCommentRequest & { artifactType: CommentArtifactKind },
    ) => variables,
    options: {
      ...lifecycle,
      onSuccess: (_data, variables, ctx) => {
        ctx.poolWrite?.settle();
        Analytics.getInstance().track(AnalyticsEvent.CommentEdited, null);
        invalidate(
          ctx,
          variables.epicId,
          variables.artifactType,
          variables.artifactId,
        );
      },
    },
  });
}

export function useDeleteCommentForClient(
  client: HostClient<HostRpcRegistry> | null,
) {
  const { invalidate, ...lifecycle } = useCommentWriteLifecycle(
    client,
    "Couldn't delete comment.",
  );
  return useHostMutation({
    client,
    method: "epic.deleteComment",
    mapVariables: (
      variables: DeleteCommentRequest & { artifactType: CommentArtifactKind },
    ) => variables,
    options: {
      ...lifecycle,
      onSuccess: (_data, variables, ctx) => {
        ctx.poolWrite?.settle();
        Analytics.getInstance().track(AnalyticsEvent.CommentDeleted, null);
        invalidate(
          ctx,
          variables.epicId,
          variables.artifactType,
          variables.artifactId,
        );
      },
    },
  });
}

export function useSetCommentThreadResolvedForClient(
  client: HostClient<HostRpcRegistry> | null,
) {
  const { invalidate, ...lifecycle } = useCommentWriteLifecycle(
    client,
    "Couldn't update thread.",
  );
  return useHostMutation({
    client,
    method: "epic.setCommentThreadResolved",
    mapVariables: (
      variables: SetCommentThreadResolvedRequest & {
        artifactType: CommentArtifactKind;
      },
    ) => variables,
    options: {
      ...lifecycle,
      onSuccess: (_data, variables, ctx) => {
        ctx.poolWrite?.settle();
        Analytics.getInstance().track(
          variables.resolved
            ? AnalyticsEvent.CommentResolved
            : AnalyticsEvent.CommentReopened,
          null,
        );
        invalidate(
          ctx,
          variables.epicId,
          variables.artifactType,
          variables.artifactId,
        );
      },
    },
  });
}

export function useDeleteCommentThreadForClient(
  client: HostClient<HostRpcRegistry> | null,
) {
  const queryClient = useQueryClient();
  const { invalidate, ...lifecycle } = useCommentWriteLifecycle(
    client,
    "Couldn't delete thread.",
  );
  return useHostMutation({
    client,
    method: "epic.deleteCommentThread",
    mapVariables: (
      variables: DeleteCommentThreadRequest & {
        artifactType: CommentArtifactKind;
      },
    ) => variables,
    options: {
      ...lifecycle,
      onSuccess: (_data, variables, ctx) => {
        ctx.poolWrite?.settle();
        Analytics.getInstance().track(AnalyticsEvent.CommentDeleted, null);
        const { hostId, viewerUserId } = ctx;
        if (hostId !== null) {
          // Clear the deleted thread from the cached list eagerly so the
          // sidebar drops it before the network round-trip.
          queryClient.setQueryData<ListCommentThreadsResponse>(
            commentThreadsQueryKey(
              hostId,
              {
                epicId: variables.epicId,
                artifactType: variables.artifactType,
                artifactId: variables.artifactId,
              },
              viewerUserId,
            ),
            (prior) =>
              prior === undefined
                ? prior
                : {
                    threads: prior.threads.filter(
                      (t) => t.threadId !== variables.threadId,
                    ),
                  },
          );
        }
        invalidate(
          ctx,
          variables.epicId,
          variables.artifactType,
          variables.artifactId,
        );
      },
    },
  });
}
