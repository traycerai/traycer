import { useEffect, useMemo } from "react";
import type {
  Mutation,
  UseMutationResult,
  UseQueryResult,
} from "@tanstack/react-query";
import {
  chatFeedbackDraftDecideResponseSchema,
  type ChatFeedbackDraftDecideRequest,
  type ChatFeedbackDraftDecideResponse,
  type ChatFeedbackDraftPreviewResponse,
} from "@traycer/protocol/host/chat/feedback-draft";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  HostClient,
  HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation, useHostQuery } from "@/hooks/host/use-host-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useMutationStateOf } from "@/hooks/use-mutation-state-of";
import { toast } from "sonner";
import { toastFromHostError } from "@/lib/host-error-toast";
import { feedbackDraftMutationKeys } from "@/lib/query-keys";
import type { ToolCallFeedbackDraftStamp } from "@traycer/protocol/persistence/epic/content-blocks";
import { useRequestContextUserId } from "@/hooks/host/use-request-context-user-id";
import {
  feedbackDraftDecisionKey,
  useFeedbackDraftDecisionStore,
} from "@/stores/chats/feedback-draft-decision-store";

const DECIDE_METHOD = "chat.feedbackDraft.decide" as const;
const PREVIEW_METHOD = "chat.feedbackDraft.preview" as const;

/** The draft block a request names. */
export interface FeedbackDraftBlockRef {
  readonly epicId: string;
  readonly chatId: string;
  readonly blockId: string;
}

/** A draft block and the host whose chat holds it. */
export interface FeedbackDraftDecisionRef extends FeedbackDraftBlockRef {
  readonly hostId: string;
}

function decideMutationKey(
  draft: FeedbackDraftDecisionRef,
  userId: string | null,
): readonly (string | null)[] {
  return feedbackDraftMutationKeys.decide({ ...draft, userId });
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
 * What to tell the user when the host refused a decision in its response
 * rather than by throwing. `null` when there is nothing to say: a settled
 * decision, or `already-decided`, whose stamp the card shows instead.
 */
export function feedbackDraftRefusalMessage(
  response: ChatFeedbackDraftDecideResponse,
): string | null {
  if (response.kind !== "error" || response.feedbackDraft !== null) {
    return null;
  }
  switch (response.code) {
    case "not-allowed":
      return "Nothing was sent: you can't act on this chat.";
    case "session-unavailable":
      return "Nothing was sent: this chat's host isn't available.";
    case "not-draft-block":
    case "already-decided":
      return "Nothing was sent: this feedback draft can't be decided.";
  }
}

/**
 * The account a decision was sent as. Its answer is recorded under that
 * account and no other; an identity change on the host aborts every request
 * still in flight (`HostClient.setRequestContext`), so no answer lands after
 * one.
 */
interface DecisionContext {
  readonly userId: string | null;
}

function decidingStamp(
  response: ChatFeedbackDraftDecideResponse | null,
): ToolCallFeedbackDraftStamp | null {
  const stamp = response === null ? null : response.feedbackDraft;
  return stamp !== null && (stamp.state === "sent" || stamp.state === "skipped")
    ? stamp
    : null;
}

/**
 * Send or Skip on a draft. The settled stamp also reaches the transcript as a
 * row update; the response is what the card shows until it does. An answer
 * that sends or skips the draft is held in the decision store for the
 * draft's notification row, under the account that decided.
 */
export function useChatFeedbackDraftDecideMutation(
  client: HostRequester<HostRpcRegistry> | null,
  draft: FeedbackDraftDecisionRef,
): UseMutationResult<
  ChatFeedbackDraftDecideResponse,
  HostRpcError,
  ChatFeedbackDraftDecideRequest,
  DecisionContext
> {
  const userId = useRequestContextUserId(client);
  const record = useFeedbackDraftDecisionStore((state) => state.record);
  return useHostMutation<
    HostRpcRegistry,
    typeof DECIDE_METHOD,
    DecisionContext
  >({
    client,
    method: DECIDE_METHOD,
    mapVariables: (variables) => variables,
    options: {
      mutationKey: decideMutationKey(draft, userId),
      onMutate: () => ({
        userId: client === null ? null : client.getRequestContextUserId(),
      }),
      onSuccess: (response, _variables, context) => {
        const stamp = decidingStamp(response);
        if (stamp !== null && context.userId !== null) {
          record({ ...draft, userId: context.userId }, stamp);
        }
        const refusal = feedbackDraftRefusalMessage(response);
        if (refusal !== null) toast.error(refusal);
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't send the feedback");
      },
    },
  });
}

/** Where the decisions on one draft stand, across every surface offering them. */
export interface ChatFeedbackDraftDecisionState {
  readonly isPending: boolean;
  /**
   * The stamp that decided the draft when an answer has, else the newest
   * answer's stamp, `null` while no answer carries one.
   */
  readonly settled: ToolCallFeedbackDraftStamp | null;
}

interface DecideAttempt {
  readonly isPending: boolean;
  readonly response: ChatFeedbackDraftDecideResponse | null;
}

function selectDecideAttempt(mutation: Mutation): DecideAttempt {
  const parsed = chatFeedbackDraftDecideResponseSchema.safeParse(
    mutation.state.data,
  );
  return {
    isPending: mutation.state.status === "pending",
    response: parsed.success ? parsed.data : null,
  };
}

/**
 * The decisions made on a draft in this window by the account signed in on
 * its host, whichever surface made them: the draft's card and its
 * notification row each run their own mutation, and a Send on one must
 * settle the other without waiting for the row's resolve to come back from
 * the host. The held decision outlives the attempts that made it; the
 * attempts still answer for a decision in flight and for a failed one.
 *
 * An identity change on the host retires every decision held for it.
 */
export function useChatFeedbackDraftDecisionState(
  client: HostRequester<HostRpcRegistry> | null,
  draft: FeedbackDraftDecisionRef,
): ChatFeedbackDraftDecisionState {
  const { hostId, epicId, chatId, blockId } = draft;
  const userId = useRequestContextUserId(client);
  const mutationKey = useMemo(
    () => decideMutationKey({ hostId, epicId, chatId, blockId }, userId),
    [hostId, epicId, chatId, blockId, userId],
  );
  const attempts = useMutationStateOf(
    { mutationKey, status: undefined, exact: true },
    selectDecideAttempt,
  );
  const held = useFeedbackDraftDecisionStore((state) =>
    userId === null
      ? null
      : (state.decisions.get(
          feedbackDraftDecisionKey({ hostId, userId, epicId, chatId, blockId }),
        )?.stamp ?? null),
  );
  const retireHost = useFeedbackDraftDecisionStore((state) => state.retireHost);
  useEffect(() => {
    if (client === null) return undefined;
    return client.onChange((event) => {
      if (event.reason === "auth-changed") retireHost(hostId);
    });
  }, [client, hostId, retireHost]);
  return useMemo(() => {
    // Answers can land out of submission order, and only one attempt can
    // decide the draft: a sent or skipped answer outranks any failure.
    const deciding =
      held ??
      attempts
        .map((attempt) => decidingStamp(attempt.response))
        .find((stamp) => stamp !== null) ??
      null;
    const newest =
      attempts.findLast((attempt) => attempt.response !== null)?.response ??
      null;
    return {
      isPending: attempts.some((attempt) => attempt.isPending),
      settled: deciding ?? (newest === null ? null : newest.feedbackDraft),
    };
  }, [attempts, held]);
}

/**
 * Drops the held decision on a draft once its notification row has resolved:
 * the row's own state answers from then on.
 */
export function useRetireFeedbackDraftDecision(
  draft: FeedbackDraftDecisionRef,
  resolved: boolean,
): void {
  const { hostId, epicId, chatId, blockId } = draft;
  const retireDraft = useFeedbackDraftDecisionStore(
    (state) => state.retireDraft,
  );
  useEffect(() => {
    if (resolved) retireDraft(hostId, epicId, chatId, blockId);
  }, [resolved, hostId, epicId, chatId, blockId, retireDraft]);
}
