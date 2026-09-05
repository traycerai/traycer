import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { chatRunSettingsSchema } from "@traycer/protocol/persistence/epic/foundation";

/**
 * What a fallback action did, or the reason it did nothing.
 *
 * One vocabulary across all three verbs rather than one enum each, because the
 * refusals are not verb-specific facts about the request - they are facts about
 * the traversal, and the same client menu can be looking at a traversal that
 * advanced under it whichever action it was about to send. Each verb documents
 * the subset it can return; a value outside that subset is a host bug, not a
 * case the client has to render.
 *
 * Every one of these is a NORMAL outcome delivered in a successful response,
 * never a transport error. A pick that lost a race is not a failed call - the
 * client has to re-read and re-render either way, and a thrown error would put
 * that ordinary flow through the retry machinery.
 */
export const FALLBACK_ACTION_OUTCOMES = [
  /** The transition applied. */
  "applied",
  /**
   * The traversal moved between the client reading it and this call arriving -
   * the wait timer fired, the grace window expired, another window picked. The
   * request named a revision that is no longer current, and the engine's
   * expected-state check refused it.
   *
   * Rendered as "this chat already resumed"; the menu closes rather than
   * retrying, because the world it was describing is gone.
   */
  "traversal_advanced",
  /**
   * No traversal on this chat, or not the one named. Distinct from
   * `traversal_advanced`: that one means "yours is stale", this one means
   * "there is nothing here at all" - a card left open across a settle.
   */
  "no_active_traversal",
  /**
   * The lease token is absent, foreign, or no longer live. Only
   * `chat.fallback.chooseTarget`, and only from the grace-card menu, which
   * holds a lease; the waiting-card menu carries no token because there is
   * nothing to freeze.
   */
  "choice_lease_stale",
  /**
   * The manual rung is not offered any more: a newer turn exists on this chat,
   * a turn is running, or the named attempt is not the chat's latest. Only
   * `chat.fallback.runManualRung`.
   */
  "rung_unavailable",
  /**
   * The return offer is closed, and the chat did NOT move.
   *
   * `switch_back` accepted, but the preferred tuple could not be committed -
   * its profile was deleted, its model left the catalog, or the settings commit
   * itself threw. The record goes terminal (re-arming would poll a dead
   * account) and a durable notice says so in the transcript.
   *
   * Distinct from `applied` because the two are opposite outcomes for the user:
   * `applied` means the chat is back on the preferred provider, this means it
   * is still on the fallback. Answering `applied` here closed the banner over a
   * chat that had not moved, with nothing anywhere saying why - which is what
   * this arm exists to stop. Only `chat.fallback.returnToPreferred`.
   */
  "return_unavailable",
] as const;

export const fallbackActionOutcomeSchema = z.enum(FALLBACK_ACTION_OUTCOMES);
export type FallbackActionOutcome = z.infer<typeof fallbackActionOutcomeSchema>;

/**
 * The identity every action against a LIVE traversal carries.
 *
 * `revision` is not optimistic-concurrency decoration - it is the whole
 * mechanism. The engine has no lock; "atomically cancel the wait before
 * committing the switch" means one serialized job whose expected-state check
 * finds the revision it was told to expect. A client that omitted it would be
 * asking the host to guess which traversal state it had been looking at.
 */
export const fallbackTraversalRefSchema = z.object({
  epicId: z.string().trim().min(1),
  chatId: z.string().trim().min(1),
  traversalId: z.string().trim().min(1),
  revision: z.number().int().nonnegative(),
});
export type FallbackTraversalRef = z.infer<typeof fallbackTraversalRefSchema>;

const fallbackActionResponseSchema = z.object({
  outcome: fallbackActionOutcomeSchema,
});

/**
 * "Don't switch" on the grace card, "Stop waiting" on the waiting card, and the
 * stop of a `fallback-wait` background item.
 *
 * Outcomes: `applied`, `traversal_advanced`, `no_active_traversal`.
 *
 * "Sign in instead" is this verb followed by the existing sign-in action, not a
 * verb of its own: signing in is a multi-second trip to Settings, and the
 * switch must not fire behind the user while they are in it.
 */
export const chatFallbackCancelRequestSchema = fallbackTraversalRefSchema;
export type ChatFallbackCancelRequest = z.infer<
  typeof chatFallbackCancelRequestSchema
>;
export const chatFallbackCancelResponseSchema = fallbackActionResponseSchema;
export type ChatFallbackCancelResponse = z.infer<
  typeof chatFallbackCancelResponseSchema
>;

/**
 * "Choose differently…" from the grace card, and "Switch instead…" from the
 * waiting card. Persists the explicit target and enters `switching` at once.
 *
 * Outcomes: `applied`, `traversal_advanced`, `no_active_traversal`,
 * `choice_lease_stale`.
 *
 * `leaseToken` is nullable because the two menus differ in kind, not merely in
 * wording. The grace card's menu froze a countdown and therefore holds a lease
 * it must prove; the waiting card's menu paused nothing, because a reset time
 * is a fact rather than a budget, so there is no token to present. A token sent
 * with a waiting-card pick is still validated - presenting a lease that is not
 * live is `choice_lease_stale` whichever menu sent it.
 *
 * A reset probe that lands after this call is ignored: the explicit pick wins.
 */
export const chatFallbackChooseTargetRequestSchema =
  fallbackTraversalRefSchema.extend({
    target: chatRunSettingsSchema,
    leaseToken: z.string().nullable(),
  });
export type ChatFallbackChooseTargetRequest = z.infer<
  typeof chatFallbackChooseTargetRequestSchema
>;
export const chatFallbackChooseTargetResponseSchema =
  fallbackActionResponseSchema;
export type ChatFallbackChooseTargetResponse = z.infer<
  typeof chatFallbackChooseTargetResponseSchema
>;

/**
 * The `retry`, `switch` and `wait_once` rungs of the error card's manual
 * affordances.
 *
 * Outcomes: `applied`, `rung_unavailable`.
 *
 * Deliberately NOT a {@link fallbackTraversalRefSchema}: this verb runs where
 * there is no dispatch-holding traversal to name - a terminal failure, an
 * exhausted ladder, or a `completed_awaiting_return` left over from an earlier
 * success. It is bound instead to the FAILED ATTEMPT, and both halves of that
 * binding are load-bearing. `userMessageId` alone cannot identify an attempt,
 * because the reuse path deliberately re-sends the same persisted user message
 * across retries; `turnId` is what distinguishes them, so a successful replay
 * of the same message correctly reads as newer and the stale affordance is
 * refused.
 *
 * `target` is null for `retry` (the same tuple, again) and required for
 * `switch`. An accepted rung SUPERSEDES a pending return in the same serialized
 * transition - the chat has one record slot, and a user asking for something
 * new has answered the return prompt by implication.
 *
 * `wait_once` ("Wait until 3:00 PM" on the error card) is the one rung that
 * starts nothing immediately: it ARMS a fresh one-rung traversal parked on the
 * failed tuple's verified reset boundary, which then behaves exactly like a
 * ladder wait - a waiting card, a background item, a durable timer, and a
 * re-dispatch at the boundary. It carries no `target` (the tuple is the one
 * that failed, which is what the wait is for) and is refused when the host
 * cannot re-read a verified reset: a card offering a wait whose boundary has
 * since passed is stale, and honouring it would park the chat on nothing.
 */
export const chatFallbackRunManualRungRequestSchema = z.object({
  epicId: z.string().trim().min(1),
  chatId: z.string().trim().min(1),
  rung: z.enum(["retry", "switch", "wait_once"]),
  target: chatRunSettingsSchema.nullable(),
  /** The failed attempt's identity. Both fields, for the reason above. */
  userMessageId: z.string().trim().min(1),
  turnId: z.string().trim().min(1),
});
export type ChatFallbackRunManualRungRequest = z.infer<
  typeof chatFallbackRunManualRungRequestSchema
>;
export const chatFallbackRunManualRungResponseSchema =
  fallbackActionResponseSchema;
export type ChatFallbackRunManualRungResponse = z.infer<
  typeof chatFallbackRunManualRungResponseSchema
>;

/**
 * The switch-back banner's three answers - `chat.fallback.returnToPreferred`.
 *
 * Outcomes: `applied`, `traversal_advanced`, `no_active_traversal`,
 * `return_unavailable`.
 *
 * `return_unavailable` answers `switch_back` alone, and only when the offer
 * closed with the chat NOT moved - the preferred tuple stopped validating, or
 * its settings commit threw. It is the opposite outcome to `applied` for the
 * user, which is why it is not folded into it: `applied` means the chat is back
 * on the preferred provider, this means it is still on the fallback and a
 * durable notice says why.
 *
 * A {@link fallbackTraversalRefSchema} like `cancel` and `chooseTarget`,
 * because the record it acts on is still live: a successful traversal whose
 * policy is `prompt` or `auto` sits in `completed_awaiting_return` until the
 * return is resolved. It is NOT dispatch-holding - the queue resumed when the
 * replacement succeeded - so this verb never competes with a running turn.
 *
 *   - `switch_back` - move the chat back to the preferred tuple now, AND move
 *     the queued messages currently stamped with the fallback tuple with it.
 *     That second half is the one-sentence rule the banner's copy has to state:
 *     switching back moves queued messages too. Leaving the queue behind would
 *     interleave two providers in one chat with nobody told.
 *   - `stay` - keep the fallback tuple. The offer is answered and does not
 *     return.
 *   - `dismiss_for_chat` - close the banner without answering. Recorded
 *     durably, so it does not come back after a restart.
 *
 * All three END the traversal. A dismissal that left the record live would
 * leave an index row with no deadline, which nothing ever prunes.
 */
export const chatFallbackReturnToPreferredRequestSchema =
  fallbackTraversalRefSchema.extend({
    action: z.enum(["switch_back", "stay", "dismiss_for_chat"]),
  });
export type ChatFallbackReturnToPreferredRequest = z.infer<
  typeof chatFallbackReturnToPreferredRequestSchema
>;
export const chatFallbackReturnToPreferredResponseSchema =
  fallbackActionResponseSchema;
export type ChatFallbackReturnToPreferredResponse = z.infer<
  typeof chatFallbackReturnToPreferredResponseSchema
>;

// New optional methods, off the released floor. A client meeting an older host
// degrades to not offering the affordance rather than failing - which is why
// every one of them is registered `degrade: { kind: "unsupported" }`. Any later
// growth of `FALLBACK_ACTION_OUTCOMES` must freeze this released line's
// vocabulary before adding the next method version: the enum is strict on the
// client, so a value it has never heard of fails the whole response.
export const chatFallbackCancelV10 = defineRpcContract({
  method: "chat.fallback.cancel",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: chatFallbackCancelRequestSchema,
  responseSchema: chatFallbackCancelResponseSchema,
});

export const chatFallbackChooseTargetV10 = defineRpcContract({
  method: "chat.fallback.chooseTarget",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: chatFallbackChooseTargetRequestSchema,
  responseSchema: chatFallbackChooseTargetResponseSchema,
});

export const chatFallbackRunManualRungV10 = defineRpcContract({
  method: "chat.fallback.runManualRung",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: chatFallbackRunManualRungRequestSchema,
  responseSchema: chatFallbackRunManualRungResponseSchema,
});

export const chatFallbackReturnToPreferredV10 = defineRpcContract({
  method: "chat.fallback.returnToPreferred",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: chatFallbackReturnToPreferredRequestSchema,
  responseSchema: chatFallbackReturnToPreferredResponseSchema,
});
