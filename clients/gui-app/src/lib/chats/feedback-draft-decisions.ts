import type { QueryClient } from "@tanstack/react-query";
import type { RequestContext } from "@traycer/protocol/auth/request-context";
import type { ToolCallFeedbackDraftStamp } from "@traycer/protocol/persistence/epic/content-blocks";
import { feedbackDraftQueryKeys } from "@/lib/query-keys";

/** A draft block and the host whose chat holds it. */
export interface FeedbackDraftAddress {
  readonly hostId: string;
  readonly epicId: string;
  readonly chatId: string;
  readonly blockId: string;
}

/** A surface that reads a held decision until its own state settles. */
export type FeedbackDraftConsumer = "card" | "row";

/**
 * A decision held for one draft in one account session. `stamp` is the
 * answer that sent or skipped it, `null` before one landed or once both
 * consumers have settled. Each consumer's flag says its own authoritative
 * state has arrived: the card's transcript stamp, the row's resolve.
 */
export interface FeedbackDraftHeldDecision {
  readonly stamp: ToolCallFeedbackDraftStamp | null;
  readonly settled: Readonly<Record<FeedbackDraftConsumer, boolean>>;
}

const UNSETTLED: FeedbackDraftHeldDecision["settled"] = {
  card: false,
  row: false,
};

const sessionIds = new WeakMap<RequestContext, number>();
let nextSessionId = 1;

/**
 * The account session a request context belongs to. `RequestContextProvider`
 * mints a context object at each sign-in and clears it at sign-out, and a
 * bearer rotation mutates it in place, so one object is one session: a switch
 * away and back to the same account is a new session.
 */
export function feedbackDraftSessionId(context: RequestContext): number {
  const known = sessionIds.get(context);
  if (known !== undefined) return known;
  const id = nextSessionId;
  nextSessionId += 1;
  sessionIds.set(context, id);
  return id;
}

function decisionKey(
  sessionId: number,
  draft: FeedbackDraftAddress,
): readonly (string | number)[] {
  return feedbackDraftQueryKeys.decision({ ...draft, sessionId });
}

/**
 * Held decisions have no fetch and no observer of their own, so the default
 * collection would drop one the moment both surfaces close. They live until
 * both consumers settle or the next session writes.
 */
function prepare(queryClient: QueryClient, sessionId: number): void {
  queryClient.setQueryDefaults(feedbackDraftQueryKeys.decisions(), {
    gcTime: Infinity,
    staleTime: Infinity,
  });
  queryClient.removeQueries({
    queryKey: feedbackDraftQueryKeys.decisions(),
    predicate: (query) => query.queryKey[1] !== sessionId,
  });
}

export function readFeedbackDraftDecision(
  queryClient: QueryClient,
  sessionId: number,
  draft: FeedbackDraftAddress,
): FeedbackDraftHeldDecision | undefined {
  return queryClient.getQueryData<FeedbackDraftHeldDecision>(
    decisionKey(sessionId, draft),
  );
}

/**
 * Holds the answer that sent or skipped a draft, for its account session,
 * until both the draft's card and its notification row have their own
 * state. Refused once both have: an answer that lands later holds nothing.
 */
export function recordFeedbackDraftDecision(
  queryClient: QueryClient,
  sessionId: number,
  draft: FeedbackDraftAddress,
  stamp: ToolCallFeedbackDraftStamp,
): void {
  prepare(queryClient, sessionId);
  const held = readFeedbackDraftDecision(queryClient, sessionId, draft);
  const settled = held === undefined ? UNSETTLED : held.settled;
  if (settled.card && settled.row) return;
  queryClient.setQueryData<FeedbackDraftHeldDecision>(
    decisionKey(sessionId, draft),
    { stamp, settled },
  );
}

/**
 * `consumer`'s own state for the draft has arrived. Once both have, the stamp
 * is dropped and the entry stays as the session's tombstone for the draft:
 * one per draft decided and settled, for the session's life.
 */
export function settleFeedbackDraftDecision(
  queryClient: QueryClient,
  sessionId: number,
  draft: FeedbackDraftAddress,
  consumer: FeedbackDraftConsumer,
): void {
  const held = readFeedbackDraftDecision(queryClient, sessionId, draft);
  if (held !== undefined && held.settled[consumer]) return;
  prepare(queryClient, sessionId);
  const settled = {
    ...(held === undefined ? UNSETTLED : held.settled),
    [consumer]: true,
  };
  const stamp = held === undefined ? null : held.stamp;
  queryClient.setQueryData<FeedbackDraftHeldDecision>(
    decisionKey(sessionId, draft),
    { stamp: settled.card && settled.row ? null : stamp, settled },
  );
}
