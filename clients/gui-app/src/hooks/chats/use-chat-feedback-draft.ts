import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  useQueryClient,
  type Mutation,
  type UseMutationResult,
  type UseQueryResult,
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
import type { RequestContext } from "@traycer/protocol/auth/request-context";
import type { ToolCallFeedbackDraftStamp } from "@traycer/protocol/persistence/epic/content-blocks";
import {
  feedbackDraftSessionId,
  readFeedbackDraftDecision,
  recordFeedbackDraftDecision,
  settleFeedbackDraftDecision,
  type FeedbackDraftAddress,
  type FeedbackDraftConsumer,
  type FeedbackDraftHeldDecision,
} from "@/lib/chats/feedback-draft-decisions";

const DECIDE_METHOD = "chat.feedbackDraft.decide" as const;
const PREVIEW_METHOD = "chat.feedbackDraft.preview" as const;

/** The draft block a request names. */
export interface FeedbackDraftBlockRef {
  readonly epicId: string;
  readonly chatId: string;
  readonly blockId: string;
}

function decideMutationKey(
  draft: FeedbackDraftAddress,
  sessionId: number | null,
): readonly (string | number | null)[] {
  return feedbackDraftMutationKeys.decide({ ...draft, sessionId });
}

/**
 * The account session `client` is signed in as (`feedbackDraftSessionId`),
 * `null` when signed out. Re-renders on every identity change the client
 * announces.
 */
function useFeedbackDraftSessionId(
  client: HostRequester<HostRpcRegistry> | null,
): number | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      client === null ? () => undefined : client.onChange(onStoreChange),
    [client],
  );
  const getSnapshot = useCallback(
    () => client?.getRequestContext() ?? null,
    [client],
  );
  const context = useSyncExternalStore(subscribe, getSnapshot, () => null);
  return context === null ? null : feedbackDraftSessionId(context);
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
 * The account session a decision was asked for in, captured when the
 * mutation starts. The request is dispatched only while the client is still
 * in that session, and its answer is held only if it still is when the answer
 * lands: an identity change anywhere between the click and the answer, back
 * to the same account included, replaces the context object
 * (`RequestContextProvider` mints one per sign-in).
 */
interface DecisionContext {
  readonly context: RequestContext | null;
}

/** The session each decision in flight was asked for in, by its request. */
const intendedSessions = new WeakMap<
  ChatFeedbackDraftDecideRequest,
  RequestContext
>();

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
  draft: FeedbackDraftAddress,
): UseMutationResult<
  ChatFeedbackDraftDecideResponse,
  HostRpcError,
  ChatFeedbackDraftDecideRequest,
  DecisionContext
> {
  const sessionId = useFeedbackDraftSessionId(client);
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    typeof DECIDE_METHOD,
    DecisionContext
  >({
    // Read at dispatch, synchronously before the request is sent: a session
    // change after the mutation started sends nothing, rather than deciding
    // the draft as whoever is signed in by then.
    client: (variables) =>
      client !== null &&
      intendedSessions.get(variables) === client.getRequestContext()
        ? client
        : null,
    method: DECIDE_METHOD,
    mapVariables: (variables) => variables,
    options: {
      mutationKey: decideMutationKey(draft, sessionId),
      onMutate: (variables) => {
        const context = client === null ? null : client.getRequestContext();
        if (context !== null) intendedSessions.set(variables, context);
        return { context };
      },
      onSuccess: (response, _variables, sent) => {
        const stamp = decidingStamp(response);
        if (
          stamp !== null &&
          sent.context !== null &&
          client !== null &&
          client.getRequestContext() === sent.context
        ) {
          recordFeedbackDraftDecision(
            queryClient,
            feedbackDraftSessionId(sent.context),
            draft,
            stamp,
          );
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
 * Both sources are read for the client's current account session only, so
 * an account change hides every earlier decision immediately; they are
 * discarded on the next session's first write.
 */
export function useChatFeedbackDraftDecisionState(
  client: HostRequester<HostRpcRegistry> | null,
  draft: FeedbackDraftAddress,
): ChatFeedbackDraftDecisionState {
  const { hostId, epicId, chatId, blockId } = draft;
  const sessionId = useFeedbackDraftSessionId(client);
  const mutationKey = useMemo(
    () => decideMutationKey({ hostId, epicId, chatId, blockId }, sessionId),
    [hostId, epicId, chatId, blockId, sessionId],
  );
  const attempts = useMutationStateOf(
    { mutationKey, status: undefined, exact: true },
    selectDecideAttempt,
  );
  const held = useHeldFeedbackDraftDecision(sessionId, {
    hostId,
    epicId,
    chatId,
    blockId,
  });
  const heldStamp = held === undefined ? null : held.stamp;
  return useMemo(() => {
    // Answers can land out of submission order, and only one attempt can
    // decide the draft: a sent or skipped answer outranks any failure.
    const deciding =
      heldStamp ??
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
  }, [attempts, heldStamp]);
}

/** The held decision on a draft for `sessionId`, re-read on every cache change. */
function useHeldFeedbackDraftDecision(
  sessionId: number | null,
  draft: FeedbackDraftAddress,
): FeedbackDraftHeldDecision | undefined {
  const queryClient = useQueryClient();
  const { hostId, epicId, chatId, blockId } = draft;
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      queryClient.getQueryCache().subscribe(onStoreChange),
    [queryClient],
  );
  const getSnapshot = useCallback(
    () =>
      sessionId === null
        ? undefined
        : readFeedbackDraftDecision(queryClient, sessionId, {
            hostId,
            epicId,
            chatId,
            blockId,
          }),
    [queryClient, sessionId, hostId, epicId, chatId, blockId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => undefined);
}

/**
 * Marks `consumer`'s own state for a draft as arrived, for the client's
 * account session: the card's transcript stamp is sent or skipped, or the
 * notification row resolved. The held decision is dropped once both have.
 */
export function useSettleFeedbackDraftDecision(
  client: HostRequester<HostRpcRegistry> | null,
  draft: FeedbackDraftAddress,
  consumer: FeedbackDraftConsumer,
  settled: boolean,
): void {
  const { hostId, epicId, chatId, blockId } = draft;
  const sessionId = useFeedbackDraftSessionId(client);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (settled && sessionId !== null) {
      settleFeedbackDraftDecision(
        queryClient,
        sessionId,
        { hostId, epicId, chatId, blockId },
        consumer,
      );
    }
  }, [
    settled,
    sessionId,
    hostId,
    epicId,
    chatId,
    blockId,
    consumer,
    queryClient,
  ]);
}
