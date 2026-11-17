import { create } from "zustand";
import type { RequestContext } from "@traycer/protocol/auth/request-context";
import type { ToolCallFeedbackDraftStamp } from "@traycer/protocol/persistence/epic/content-blocks";

/** A draft block and the host whose chat holds it. */
export interface FeedbackDraftAddress {
  readonly hostId: string;
  readonly epicId: string;
  readonly chatId: string;
  readonly blockId: string;
}

const sessionIds = new WeakMap<RequestContext, number>();
let nextSessionId = 1;

/**
 * The account session a request context belongs to. A host client replaces
 * its context object on every identity change and keeps it through a bearer
 * rotation (`HostClient.setRequestContext`), so one object is one session: a
 * switch away and back to the same account is a new session.
 */
export function feedbackDraftSessionId(context: RequestContext): number {
  const known = sessionIds.get(context);
  if (known !== undefined) return known;
  const id = nextSessionId;
  nextSessionId += 1;
  sessionIds.set(context, id);
  return id;
}

export function feedbackDraftDecisionKey(
  sessionId: number,
  draft: FeedbackDraftAddress,
): string {
  return JSON.stringify([
    sessionId,
    draft.hostId,
    draft.epicId,
    draft.chatId,
    draft.blockId,
  ]);
}

interface FeedbackDraftDecisionState {
  /** The session every entry below belongs to; `null` before the first. */
  readonly sessionId: number | null;
  readonly decisions: ReadonlyMap<string, ToolCallFeedbackDraftStamp>;
  /** Drafts whose transcript stamp settled in this session. */
  readonly settled: ReadonlySet<string>;
  /** Holds `stamp`, unless the draft's transcript already settled. */
  record: (
    sessionId: number,
    draft: FeedbackDraftAddress,
    stamp: ToolCallFeedbackDraftStamp,
  ) => void;
  /**
   * The draft's transcript stamp is sent or skipped: the transcript answers
   * for the draft's card from now on, and its notification row has its own
   * resolve.
   */
  settle: (sessionId: number, draft: FeedbackDraftAddress) => void;
}

const EMPTY = {
  decisions: new Map<string, ToolCallFeedbackDraftStamp>(),
  settled: new Set<string>(),
};

/**
 * The answer that sent or skipped a draft, held for the account session that
 * decided it until the draft's transcript stamp settles.
 *
 * A decision made on either surface must keep the other settled after the
 * surface that made it closes: the notification row until its own resolve
 * arrives, the card until its transcript stamp does, and neither has a time
 * bound. A draft decided while its card is never opened keeps its stamp for
 * the session. Only the deciding
 * stamp is held, in memory and never persisted. Every entry belongs to one
 * session: the first write from a newer session drops the older session's
 * entries, and a reader asks only for its own session's, so an account change
 * retires them whether or not anything was mounted to see it. A settled
 * transcript is remembered for the session, so an answer that lands after it
 * holds nothing.
 */
export const useFeedbackDraftDecisionStore = create<FeedbackDraftDecisionState>(
  (set) => ({
    sessionId: null,
    ...EMPTY,
    record: (sessionId, draft, stamp) =>
      set((state) => {
        const base = state.sessionId === sessionId ? state : EMPTY;
        const key = feedbackDraftDecisionKey(sessionId, draft);
        if (base.settled.has(key)) {
          return base === state ? state : { sessionId, ...EMPTY };
        }
        const decisions = new Map(base.decisions);
        decisions.set(key, stamp);
        return { sessionId, decisions, settled: base.settled };
      }),
    settle: (sessionId, draft) =>
      set((state) => {
        const base = state.sessionId === sessionId ? state : EMPTY;
        const key = feedbackDraftDecisionKey(sessionId, draft);
        if (base.settled.has(key) && !base.decisions.has(key)) {
          return base === state ? state : { sessionId, ...EMPTY };
        }
        const decisions = new Map(base.decisions);
        decisions.delete(key);
        const settled = new Set(base.settled);
        settled.add(key);
        return { sessionId, decisions, settled };
      }),
  }),
);
