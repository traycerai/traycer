import { useMemo } from "react";
import type {
  UseMutationResult,
  UseQueryResult,
} from "@tanstack/react-query";
import type {
  ChatFeedbackDraftDecideRequest,
  ChatFeedbackDraftDecideResponse,
  ChatFeedbackDraftPreviewResponse,
} from "@traycer/protocol/host/chat/feedback-draft";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation, useHostQuery } from "@/hooks/host/use-host-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { toastFromHostError } from "@/lib/host-error-toast";
import { feedbackDraftMutationKeys } from "@/lib/query-keys";

const DECIDE_METHOD = "chat.feedbackDraft.decide" as const;
const PREVIEW_METHOD = "chat.feedbackDraft.preview" as const;

/** The draft block a request names. */
export interface FeedbackDraftBlockRef {
  readonly epicId: string;
  readonly chatId: string;
  readonly blockId: string;
}

/**
 * Whether the chat's host can send a draft: `false` only once a handshake
 * says it lacks the method, `null` while that is not yet known.
 */
export function useChatFeedbackDraftSupported(hostId: string): boolean | null {
  return useHostMethodSupport(hostId, DECIDE_METHOD);
}

/**
 * The diagnostics a send would attach, scrubbed as they would ship. Read only
 * while `enabled` (the View dialog is open).
 */
export function useChatFeedbackDraftPreviewQuery(
  client: HostClient<HostRpcRegistry> | null,
  ref: FeedbackDraftBlockRef,
  enabled: boolean,
): UseQueryResult<ChatFeedbackDraftPreviewResponse, HostRpcError> {
  const { epicId, chatId, blockId } = ref;
  const params = useMemo(
    () => ({ epicId, chatId, blockId }),
    [epicId, chatId, blockId],
  );
  return useHostQuery<HostRpcRegistry, typeof PREVIEW_METHOD>({
    cacheKeyIdentity: undefined,
    client,
    method: PREVIEW_METHOD,
    params,
    options: { enabled, staleTime: 0, gcTime: 0 },
  });
}

/**
 * Send or Skip on a draft. The settled stamp also reaches the transcript as a
 * row update; the response is what the card shows until it does.
 */
export function useChatFeedbackDraftDecideMutation(
  client: HostClient<HostRpcRegistry> | null,
  blockId: string,
): UseMutationResult<
  ChatFeedbackDraftDecideResponse,
  HostRpcError,
  ChatFeedbackDraftDecideRequest
> {
  return useHostMutation<HostRpcRegistry, typeof DECIDE_METHOD>({
    client,
    method: DECIDE_METHOD,
    mapVariables: (variables) => variables,
    options: {
      mutationKey: feedbackDraftMutationKeys.decide(blockId),
      onError: (error) => {
        toastFromHostError(error, "Couldn't send the feedback");
      },
    },
  });
}
