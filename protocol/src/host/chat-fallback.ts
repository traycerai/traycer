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
   * The manual rung did nothing, and the host is NOT claiming to know why in
   * any way the user could act on: a turn is running, the chat has no eligible
   * failed attempt, a dispatch-holding traversal is live, or the replacement
   * turn could not be prepared. Only `chat.fallback.runManualRung`.
   *
   * **The NEUTRAL residue, and it must be rendered as one.** It used to carry
   * the advancement cases as well, so a card had exactly one string for "this
   * chat has moved on" and printed it for a destination that had merely stopped
   * validating - a cause the host had established nothing about. The two facts
   * the host CAN prove now have their own values below; anything that reaches
   * this one gets "that action isn't available right now" and nothing more.
   */
  "rung_unavailable",
  /**
   * The named attempt is not the chat's latest any more - a newer turn ran, or
   * a replay of the same user message succeeded. Only
   * `chat.fallback.runManualRung`.
   *
   * **The only outcome that proves the chat advanced**, and the only one whose
   * copy may say so. The host returns it from exactly one comparison: the
   * client's `{ userMessageId, turnId }` pair against the chat's latest durable
   * attempt.
   *
   * Deliberately the SAME word `chat.fallback.listTargets` already uses for the
   * same fact. The two enums are separate types and could have spelled it
   * differently; one file renders both, and two words for one fact in one
   * switch is how a renderer ends up implying they are different situations.
   */
  "attempt_not_latest",
  /**
   * The rung had a destination and it does not validate right now - the profile
   * was deleted, the model left the catalog, or the settings commit was
   * refused. Only `chat.fallback.runManualRung`.
   *
   * **The chat did NOT move and the attempt is still the latest**, which is the
   * whole reason this is not `attempt_not_latest`: the useful next step is to
   * reopen the destination menu and pick again, not to accept that the moment
   * has passed.
   */
  "rung_target_unavailable",
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
 * Outcomes: `applied`, `rung_unavailable`, `attempt_not_latest`,
 * `rung_target_unavailable`. The last three are three DIFFERENT facts and are
 * separate values precisely so a renderer stops having to pick one sentence for
 * all of them; see their entries in {@link FALLBACK_ACTION_OUTCOMES} for which
 * one may claim the chat advanced.
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

/**
 * Why a target is not offered, or a note attached to one that is.
 *
 * An OPEN string beside a rendered label, not an enum, and the reason is the
 * one written at the top of this file: a strict enum is strict on the CLIENT,
 * so a reason a released build has never heard of would fail the whole
 * response - blanking an entire menu over one unrecognised row. `label` is
 * always safe to render verbatim; parse `reason` with
 * `tierRungSkipReasonSchema` from `./fallback-policy` to branch on it, and fall
 * back to the label when it does not match. Consumers keep compile-time
 * exhaustiveness by mapping copy over that type with no `default` arm.
 *
 * On a NON-selectable row this says why. On a selectable row it is advisory -
 * `already-tried` and `rate-limited` are both rows the verb would accept, and
 * whether to offer the click is the surface's decision, not this field's.
 */
export const fallbackTargetSkipSchema = z.object({
  reason: z.string(),
  label: z.string(),
});
export type FallbackTargetSkip = z.infer<typeof fallbackTargetSkipSchema>;

/**
 * A sibling ACCOUNT on the failed tuple's own provider - the profile rung.
 *
 * **Deliberately carries no `target`, unlike {@link fallbackModelTargetSchema},
 * and this asymmetry is the design rather than an omission.** A caller assembles
 * the tuple itself as `{ ...failedTuple, profileId: row.profileId }`.
 *
 * That is safe here because it is a field SUBSTITUTION, not a reconstruction.
 * Only the account moves: same provider, same model, same reasoning effort, fast
 * mode, permission mode and agent mode. There is nothing for the engine to
 * re-derive, so there is no engine answer for a client to drift from.
 *
 * The model row is the opposite case, which is why it carries a `target` and
 * says "never reconstruct this client-side": it crosses to ANOTHER provider,
 * whose catalog may not offer the failed tuple's effort or fast mode at all, so
 * the engine re-derives both against the target's catalog and drops what does
 * not survive (reported in `warnings`). A client copying those fields across
 * would send a tuple the target cannot honour, and would go stale on the next
 * catalog change - the drift this method exists to remove.
 *
 * So: the rule is not "clients never build tuples", it is "clients never build
 * a tuple whose fields the engine DERIVED". If a future profile row ever gains a
 * derived field, it needs a `target` too, and this doc stops being true.
 */
export const fallbackProfileTargetSchema = z.object({
  /** `null` is the ambient login, never a sentinel string. */
  profileId: z.string().nullable(),
  label: z.string(),
  /** `"ok" | "near_limit" | "hard_limit" | "unknown"`, open for the same reason. */
  severity: z.string(),
  /**
   * Worst applicable window, or `null` for NOT COMPARABLE.
   *
   * `null` is never "zero" - the engine's ranking orders the two differently,
   * and a bar drawn at 0% for an unread gauge tells the user the opposite of
   * what is true.
   */
  usedPercent: z.number().nullable(),
  /**
   * The account the ladder would take next - true on at most one row, false on
   * every row when nothing is rankable.
   *
   * A flag rather than "the array is in rank order" deliberately: rank order is
   * an invariant a future reorder breaks with no compile error, and the
   * error-card entry point has no live record to cross-check it against.
   */
  recommended: z.boolean(),
  selectable: z.boolean(),
  skip: fallbackTargetSkipSchema.nullable(),
});
export type FallbackProfileTarget = z.infer<typeof fallbackProfileTargetSchema>;

/** An equivalent model on ANOTHER provider - the tier rung. */
export const fallbackModelTargetSchema = z.object({
  /**
   * The group this candidate came from. Its `id` is all a group has - the
   * persisted `tierGroupSchema` is `{ id, candidates }` with no display name -
   * so a surface titles the section from the id or from its own copy.
   */
  groupId: z.string(),
  /** Always present: with `modelFamily`, the row's title even when unresolved. */
  harnessId: z.string(),
  modelFamily: z.string(),
  /** The resolved slug; `null` when resolution stopped before one existed. */
  model: z.string().nullable(),
  reasoningEffort: z.string().nullable(),
  profileId: z.string().nullable(),
  severity: z.string(),
  usedPercent: z.number().nullable(),
  /**
   * The tuple to hand straight back to `chat.fallback.runManualRung`, or `null`
   * when there is nothing to send.
   *
   * Never reconstruct this client-side. The engine re-derives effort and fast
   * mode against the TARGET's catalog and carries permission mode and agent
   * mode from the failed tuple untouched; a client-assembled tuple drifts from
   * the engine on the next catalog change, which is the drift this whole method
   * exists to remove.
   */
  target: chatRunSettingsSchema.nullable(),
  /** Dropped effort / fast mode, in `agent.configure`'s wording. Unjoined. */
  warnings: z.array(z.string()),
  /**
   * Whether the VERB would accept this pick - exactly `target !== null`.
   *
   * It does NOT answer "should the menu offer the click". The manual switch
   * validates usability alone, so an `already-tried` or `rate-limited` row is
   * one the host would accept; encoding the stricter answer here would make
   * every menu a second policy nothing enforces.
   */
  selectable: z.boolean(),
  skip: fallbackTargetSkipSchema.nullable(),
});
export type FallbackModelTarget = z.infer<typeof fallbackModelTargetSchema>;

/**
 * `chat.fallback.listTargets` - what the destination menu may offer, computed
 * by the ENGINE's own resolution rather than re-derived by the client.
 *
 * Read-only with ONE bounded exception: no probe, no gauge write, no
 * traversal-record write - but a user whose fallback policy row has never been
 * seeded gets its one-time tier-group seed on their first call, because the
 * host reads groups through the same seeding helper the ladder's tier rung
 * uses. Skipping it would answer `no-group` for a user the engine would have
 * found targets for. Idempotent thereafter, and it never touches the traversal
 * record - so opening the menu still cannot move a traversal, and a surface may
 * call it on every open and refresh freely.
 *
 * Two selectors because the two entry points genuinely differ. The cards hold a
 * live record and can be stale, so they carry `{ traversalId, revision }`; the
 * error card has no live record and names the work by the failed attempt, the
 * same `{ userMessageId, turnId }` pair `runManualRung` already takes.
 *
 * Never throws: an unreadable or moved-on world is a normal response carrying
 * an `outcome` and empty lists, exactly as the action verbs answer
 * `traversal_advanced` rather than failing the call.
 */
export const chatFallbackListTargetsRequestSchema = z.object({
  epicId: z.string().trim().min(1),
  chatId: z.string().trim().min(1),
  selector: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("traversal"),
      traversalId: z.string().trim().min(1),
      revision: z.number().int().nonnegative(),
    }),
    z.object({
      kind: z.literal("attempt"),
      userMessageId: z.string().trim().min(1),
      turnId: z.string().trim().min(1),
    }),
  ]),
});
export type ChatFallbackListTargetsRequest = z.infer<
  typeof chatFallbackListTargetsRequestSchema
>;

export const chatFallbackListTargetsResponseSchema = z.object({
  outcome: z.enum([
    "listed",
    "no_active_traversal",
    "traversal_advanced",
    "attempt_not_latest",
    "state_unreadable",
  ]),
  /** The tuple that failed, so a surface can assert it is never offered. */
  failedTuple: chatRunSettingsSchema.nullable(),
  profileTargets: z.array(fallbackProfileTargetSchema),
  modelTargets: z.array(fallbackModelTargetSchema),
  /**
   * Why `modelTargets` is EMPTY, when that is a rung-level fact rather than
   * every candidate having been skipped - in practice `no-group`.
   *
   * Beside the array rather than inside it because it describes the absence of
   * candidates, not a candidate. Load-bearing for the UI: `no-group` is the
   * COMMONEST ineligibility, being what a user sees after deleting or narrowing
   * their groups, so an empty list with no explanation would be the menu's
   * worst cell.
   */
  modelTargetsSkip: fallbackTargetSkipSchema.nullable(),
});
export type ChatFallbackListTargetsResponse = z.infer<
  typeof chatFallbackListTargetsResponseSchema
>;

export const chatFallbackListTargetsV10 = defineRpcContract({
  method: "chat.fallback.listTargets",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: chatFallbackListTargetsRequestSchema,
  responseSchema: chatFallbackListTargetsResponseSchema,
});
