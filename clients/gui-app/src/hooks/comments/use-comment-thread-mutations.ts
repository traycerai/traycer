import { useQueryClient } from "@tanstack/react-query";
import type {
  CreateCommentThreadRequest,
  ListCommentThreadsResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import { extractUserMentionIds } from "@traycer/protocol/notifications/comment-notification-utils";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostMutation } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";
import { toastFromHostError } from "@/lib/host-error-toast";
import { commentThreadsQueryKey } from "./use-epic-comment-threads";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

/** Capture hostId in onMutate; invalidate that host's listCommentThreads. Caller supplies the epic-session client. No optimistic updates. */
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

export function useCreateCommentThreadForClient(
  client: HostClient<HostRpcRegistry> | null,
) {
  const invalidate = useThreadInvalidator();
  return useHostMutation({
    client,
    method: "epic.createCommentThread",
    mapVariables: (variables) => variables,
    options: {
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
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

export function useReplyToCommentThreadForClient(
  client: HostClient<HostRpcRegistry> | null,
) {
  const invalidate = useThreadInvalidator();
  return useHostMutation({
    client,
    method: "epic.replyToCommentThread",
    mapVariables: (variables) => variables,
    options: {
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
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

export function useEditCommentForClient(
  client: HostClient<HostRpcRegistry> | null,
) {
  const invalidate = useThreadInvalidator();
  return useHostMutation({
    client,
    method: "epic.editComment",
    mapVariables: (variables) => variables,
    options: {
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
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

export function useDeleteCommentForClient(
  client: HostClient<HostRpcRegistry> | null,
) {
  const invalidate = useThreadInvalidator();
  return useHostMutation({
    client,
    method: "epic.deleteComment",
    mapVariables: (variables) => variables,
    options: {
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
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

export function useSetCommentThreadResolvedForClient(
  client: HostClient<HostRpcRegistry> | null,
) {
  const invalidate = useThreadInvalidator();
  return useHostMutation({
    client,
    method: "epic.setCommentThreadResolved",
    mapVariables: (variables) => variables,
    options: {
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
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

export function useDeleteCommentThreadForClient(
  client: HostClient<HostRpcRegistry> | null,
) {
  const queryClient = useQueryClient();
  const invalidate = useThreadInvalidator();
  return useHostMutation({
    client,
    method: "epic.deleteCommentThread",
    mapVariables: (variables) => variables,
    options: {
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
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
