import { useQueryClient } from "@tanstack/react-query";
import type {
  CreateCommentThreadRequest,
  ListCommentThreadsResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import { extractUserMentionIds } from "@traycer/protocol/notifications/comment-notification-utils";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostClient } from "@/lib/host/runtime";
import { toastFromHostError } from "@/lib/host-error-toast";
import { commentThreadsQueryKey } from "./use-epic-comment-threads";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

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
 * Each mutation captures the active host id in `onMutate` and reuses that
 * captured id for cache writes/invalidation. Reading `getActiveHostId()`
 * at success time would target whichever host is bound at that moment -
 * if the user switches hosts mid-flight, the in-flight ack would land on
 * the new host's cache while the original host's thread list stays
 * stale.
 */
interface MutationContext {
  readonly hostId: string | null;
}

function useThreadInvalidator(): (
  hostId: string | null,
  epicId: string,
  artifactType: "spec" | "ticket" | "story" | "review",
  artifactId: string,
) => void {
  const queryClient = useQueryClient();
  return (hostId, epicId, artifactType, artifactId) => {
    if (hostId === null) return;
    void queryClient.invalidateQueries({
      queryKey: commentThreadsQueryKey(hostId, {
        epicId,
        artifactType,
        artifactId,
      }),
    });
  };
}

export function useCreateCommentThread() {
  const client = useHostClient();
  const invalidate = useThreadInvalidator();
  return useHostMutation({
    client,
    method: "epic.createCommentThread",
    mapVariables: (variables) => variables,
    options: {
      onMutate: () => ({ hostId: client.getActiveHostId() }),
      onSuccess: (_data, variables: CreateCommentThreadRequest, ctx) => {
        Analytics.getInstance().track(AnalyticsEvent.CommentCreated, {
          has_mention: extractUserMentionIds(variables.content).length > 0,
        });
        invalidate(
          (ctx as MutationContext).hostId,
          variables.epicId,
          variables.artifactType,
          variables.artifactId,
        );
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't post comment.");
      },
    },
  });
}

export function useReplyToCommentThread() {
  const client = useHostClient();
  const invalidate = useThreadInvalidator();
  return useHostMutation({
    client,
    method: "epic.replyToCommentThread",
    mapVariables: (variables) => variables,
    options: {
      onMutate: () => ({ hostId: client.getActiveHostId() }),
      onSuccess: (_data, variables, ctx) => {
        Analytics.getInstance().track(AnalyticsEvent.CommentReplied, {
          has_mention: extractUserMentionIds(variables.content).length > 0,
        });
        invalidate(
          (ctx as MutationContext).hostId,
          variables.epicId,
          variables.artifactType,
          variables.artifactId,
        );
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't post reply.");
      },
    },
  });
}

export function useEditComment() {
  const client = useHostClient();
  const invalidate = useThreadInvalidator();
  return useHostMutation({
    client,
    method: "epic.editComment",
    mapVariables: (variables) => variables,
    options: {
      onMutate: () => ({ hostId: client.getActiveHostId() }),
      onSuccess: (_data, variables, ctx) => {
        Analytics.getInstance().track(AnalyticsEvent.CommentEdited, null);
        invalidate(
          (ctx as MutationContext).hostId,
          variables.epicId,
          variables.artifactType,
          variables.artifactId,
        );
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't update comment.");
      },
    },
  });
}

export function useDeleteComment() {
  const client = useHostClient();
  const invalidate = useThreadInvalidator();
  return useHostMutation({
    client,
    method: "epic.deleteComment",
    mapVariables: (variables) => variables,
    options: {
      onMutate: () => ({ hostId: client.getActiveHostId() }),
      onSuccess: (_data, variables, ctx) => {
        Analytics.getInstance().track(AnalyticsEvent.CommentDeleted, null);
        invalidate(
          (ctx as MutationContext).hostId,
          variables.epicId,
          variables.artifactType,
          variables.artifactId,
        );
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't delete comment.");
      },
    },
  });
}

export function useSetCommentThreadResolved() {
  const client = useHostClient();
  const invalidate = useThreadInvalidator();
  return useHostMutation({
    client,
    method: "epic.setCommentThreadResolved",
    mapVariables: (variables) => variables,
    options: {
      onMutate: () => ({ hostId: client.getActiveHostId() }),
      onSuccess: (_data, variables, ctx) => {
        Analytics.getInstance().track(
          variables.resolved
            ? AnalyticsEvent.CommentResolved
            : AnalyticsEvent.CommentReopened,
          null,
        );
        invalidate(
          (ctx as MutationContext).hostId,
          variables.epicId,
          variables.artifactType,
          variables.artifactId,
        );
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't update thread.");
      },
    },
  });
}

export function useDeleteCommentThread() {
  const client = useHostClient();
  const queryClient = useQueryClient();
  const invalidate = useThreadInvalidator();
  return useHostMutation({
    client,
    method: "epic.deleteCommentThread",
    mapVariables: (variables) => variables,
    options: {
      onMutate: () => ({ hostId: client.getActiveHostId() }),
      onSuccess: (_data, variables, ctx) => {
        Analytics.getInstance().track(AnalyticsEvent.CommentDeleted, null);
        const { hostId } = ctx as MutationContext;
        if (hostId !== null) {
          // Clear the deleted thread from the cached list eagerly so the
          // sidebar drops it before the network round-trip.
          queryClient.setQueryData<ListCommentThreadsResponse>(
            commentThreadsQueryKey(hostId, {
              epicId: variables.epicId,
              artifactType: variables.artifactType,
              artifactId: variables.artifactId,
            }),
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
          hostId,
          variables.epicId,
          variables.artifactType,
          variables.artifactId,
        );
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't delete thread.");
      },
    },
  });
}
