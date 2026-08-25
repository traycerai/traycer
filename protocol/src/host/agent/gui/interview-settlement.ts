/**
 * The single settlement authority for an interview block.
 *
 * Live GUI settlement, runtime-originated settlement, detached rewrite,
 * hydration/replay from the durable event log, notification reconciliation and
 * fork transforms all wrote the same logical block through different code
 * paths, each with its own status/error switch. That is why a late
 * `interview.errored` cleanup could overwrite a user's Skip reason with adapter
 * noise, and why a restart between an accepted answer and adapter cleanup could
 * reopen an interview whose answer had already escaped to a provider.
 *
 * This module is that policy, once, as a pure function. It lives in
 * `@traycer/protocol` - beside the interview schemas and the runtime
 * accumulator - because BOTH sides need it: the OSS runtime accumulator routes
 * its `interview.*` events through it, and the internal host imports it for
 * orchestration and persistence. It has no host dependencies and performs no
 * IO.
 *
 * Two identities carry the whole idempotency story:
 *
 * - `settlementId` is the settlement key. Reapplying the same id is a no-op,
 *   which is what makes replay and reconciliation safe to run repeatedly.
 * - `diagnosticId` is deduplicated independently in `diagnostics`, so a retried
 *   cleanup cannot multiply codes.
 *
 * The key property is MONOTONICITY: no later, weaker event removes an
 * established fact. Every rule below is a specialization of that.
 */
import type {
  InterviewAnswer,
  InterviewBlock,
  InterviewDeliveryProjection,
  InterviewOutcome,
  InterviewSelectionEvidence,
  InterviewSettlementAuthority,
  InterviewSettlementDiagnostic,
} from "@traycer/protocol/persistence/epic/content-blocks";

/** Who produced a settlement. Reconciliation replays the ORIGINAL source. */
export type InterviewSettlementSource = InterviewSettlementAuthority["source"];

/**
 * One canonical settlement fact, as the durable interview event carries it.
 *
 * `answers` are submitted answers (the only form a provider ever sees).
 * `draftAnswers` are saved-but-unsent values from an explicit Skip - history
 * only. `reason` is user-visible text; content-free cleanup codes belong in
 * `diagnostic`, never here.
 *
 * `diagnostic` and `delivery` ride along because a settlement that LOSES the
 * canonical slot can still legitimately contribute both - that is the entire
 * reason they exist as separate fields instead of as writes into legacy
 * `error`.
 */
export interface InterviewSettlement {
  readonly settlementId: string;
  readonly outcome: InterviewOutcome;
  readonly answers: InterviewAnswer[];
  readonly draftAnswers: InterviewAnswer[];
  readonly reason: string | null;
  readonly source: InterviewSettlementSource;
  /** Content-free cleanup/conflict/delivery code, or null. */
  readonly diagnostic: InterviewSettlementDiagnostic | null;
  /**
   * Content-free outbox projection for a detached settlement, or null for "not
   * reported" (an active waiter, a provider-originated settlement, a legacy
   * row).
   *
   * HOW IT IS APPLIED DEPENDS ON THIS SETTLEMENT'S RELATION TO THE BLOCK, and
   * `null` does not mean one thing across all three:
   *
   * - Taking the canonical slot ⇒ adopted WHOLESALE, `null` included. Here
   *   `null` genuinely clears, because a new settlement brings its own outbox
   *   item (or none) and must not inherit the previous settlement's.
   * - A replay of the settlement already holding the slot ⇒ merged under the
   *   ordering rules, where `null` is "not reported" and clears nothing: the
   *   outbox is authoritative and silence is not a retraction.
   * - Any other settlement ⇒ ignored outright. An outbox item belongs to one
   *   accepted settlement and nobody else may speak for it.
   */
  readonly delivery: InterviewDeliveryProjection | null;
  /**
   * Wall-clock ms to stamp on the block IF this settlement contributes
   * something. A settlement that contributes nothing leaves `timestamp`
   * untouched, which is what keeps replay idempotent all the way down to the
   * rendered ordering.
   */
  readonly timestamp: number;
}

/**
 * Every field the reducer owns, as one patch: canonical facts, the legacy
 * projection regenerated from them, authority metadata, content-free
 * diagnostics, and the delivery projection.
 *
 * Returned as a patch rather than a whole block so a fork transform can
 * overlay it onto the existing RAW JSON block and preserve unknown future
 * fields - see `overlayInterviewSettlementPatch`.
 */
export interface InterviewSettlementPatch {
  readonly status: InterviewBlock["status"];
  readonly answers: InterviewAnswer[];
  readonly error: string | null;
  readonly outcome: InterviewOutcome | null;
  readonly draftAnswers: InterviewAnswer[];
  readonly settlement: InterviewSettlementAuthority | null;
  readonly diagnostics: InterviewSettlementDiagnostic[];
  readonly delivery: InterviewDeliveryProjection | null;
  /**
   * Carried through unchanged by `applyInterviewSettlement` and emptied by
   * `clearInterviewSettlement`. See the schema field for why it exists.
   */
  readonly settlementExtensions: Record<string, unknown>;
  readonly timestamp: number;
}

export interface InterviewSettlementResult {
  /**
   * False ⇒ the patch is field-for-field what the block already says. Callers
   * skip the write and, crucially, skip the broadcast: a re-applied settlement
   * must not look like a fresh one to a renderer.
   */
  readonly changed: boolean;
  readonly patch: InterviewSettlementPatch;
}

/** The block fields the reducer reads. Kept structural so a caller holding a
 * partially-parsed or raw-overlaid block can still reduce against it. */
export type ReducibleInterviewBlock = Pick<
  InterviewBlock,
  | "status"
  | "answers"
  | "error"
  | "outcome"
  | "draftAnswers"
  | "settlement"
  | "diagnostics"
  | "delivery"
  | "settlementExtensions"
  | "timestamp"
>;

/**
 * The patch that says "nothing changed" for this block - every field this
 * module owns, at the value the block already holds.
 *
 * One place where the owned key set is written down, and the single source for
 * the no-op patch. Both write paths return this shape, so a caller can persist
 * a patch without knowing which produced it, and a test can assert that a
 * `changed: false` result really is field-for-field the block rather than
 * checking a handful of fields and hoping.
 *
 * `InterviewSettlementPatch` is what makes it exhaustive: a new owned field
 * added to that interface fails to compile here until it is accounted for.
 */
export function ownedPatch(
  block: ReducibleInterviewBlock,
): InterviewSettlementPatch {
  return {
    status: block.status,
    answers: block.answers,
    error: block.error,
    outcome: block.outcome,
    draftAnswers: block.draftAnswers,
    settlement: block.settlement,
    diagnostics: block.diagnostics,
    delivery: block.delivery,
    settlementExtensions: block.settlementExtensions,
    timestamp: block.timestamp,
  };
}

function sameStrings(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameNumbers(
  left: ReadonlyArray<number>,
  right: ReadonlyArray<number>,
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/**
 * Absent and `null` selection are the SAME absence.
 *
 * The schema makes `selection` a present key, but an in-process caller can
 * hand this module an answer built without it (see `normalizeAnswer`). Reading
 * `undefined === null` as a difference would report a genuine no-op replay as
 * a change, so the comparison coerces both sides before deciding.
 */
function sameSelection(
  left: InterviewSelectionEvidence | null,
  right: InterviewSelectionEvidence | null,
): boolean {
  const leftValue = left ?? null;
  const rightValue = right ?? null;
  if (leftValue === null || rightValue === null) {
    return leftValue === rightValue;
  }
  return (
    leftValue.questionIndex === rightValue.questionIndex &&
    leftValue.customText === rightValue.customText &&
    sameNumbers(leftValue.optionIndices, rightValue.optionIndices) &&
    sameStrings(leftValue.optionLabels, rightValue.optionLabels)
  );
}

/**
 * Structural, not reference, equality - deliberately.
 *
 * `changed` is what suppresses a redundant persist and broadcast, and the
 * arrays reaching this point are freshly built on every call (a merged array, a
 * literal `[]`). A reference check would report every duplicate settlement as a
 * change and defeat the idempotency the whole module is for. Interviews are
 * small and bounded, so the walk is free.
 */
function sameAnswers(
  left: ReadonlyArray<InterviewAnswer>,
  right: ReadonlyArray<InterviewAnswer>,
): boolean {
  return (
    left.length === right.length &&
    left.every((answer, index) => {
      const other = right[index];
      return (
        answer.questionId === other.questionId &&
        answer.question === other.question &&
        answer.notes === other.notes &&
        sameStrings(answer.values, other.values) &&
        sameSelection(answer.selection, other.selection)
      );
    })
  );
}

function sameDiagnostics(
  left: InterviewSettlementDiagnostic[],
  right: InterviewSettlementDiagnostic[],
): boolean {
  return left === right;
}

function sameAuthority(
  left: InterviewSettlementAuthority | null,
  right: InterviewSettlementAuthority | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.settlementId === right.settlementId && left.source === right.source
  );
}

/**
 * EVERY field, `generation` included - and that last one is load-bearing.
 *
 * `changed` is what tells a caller whether to persist, so a field omitted here
 * is a field that can be silently dropped. Leaving `generation` out looked
 * harmless (a bump with an otherwise identical projection changes nothing a
 * renderer draws) and was not: `mergeDelivery` returns the newer generation,
 * `changed` reports false, a caller honouring it skips the write, and the
 * block keeps the OLD generation - after which a stale update at the newer
 * generation outranks what is actually stored.
 *
 * The counterexample is a NON-`delivered` one. `delivered` is absorbing across
 * generations, so it can no longer be un-delivered this way even if this
 * equality regressed; the reachable loss is a `pending`/`delivering`/`failed`
 * projection whose attempt counter never lands, letting a superseded update
 * win later. Stated precisely because the earlier version of this comment
 * named the delivered case, which the absorbing rule has since closed.
 */
function sameDelivery(
  left: InterviewDeliveryProjection | null,
  right: InterviewDeliveryProjection | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.deliveryId === right.deliveryId &&
    left.status === right.status &&
    left.retryable === right.retryable &&
    left.generation === right.generation
  );
}

/**
 * Merge diagnostics, deduplicated by `diagnosticId`.
 *
 * Returns the SAME array reference when nothing is added, so `changed`
 * detection below stays a reference comparison rather than a deep walk over a
 * list that grows with every retry.
 */
function mergeDiagnostics(
  existing: InterviewSettlementDiagnostic[],
  incoming: InterviewSettlementDiagnostic | null,
): InterviewSettlementDiagnostic[] {
  if (incoming === null) return existing;
  if (existing.some((entry) => entry.diagnosticId === incoming.diagnosticId)) {
    return existing;
  }
  return [...existing, incoming];
}

/**
 * Coerce an answer's `selection` to an explicit `null`.
 *
 * The schema defaults `selection`, so anything that came through zod already
 * has the key. In-process callers are the gap: the host builds settlements
 * from durable event metadata and from its own adapters without necessarily
 * re-parsing, so an answer can reach this module with `selection` ABSENT while
 * its type says the key is present. That is not a theoretical hole - it
 * silently breaks `changed`, because `undefined !== null` makes a genuine
 * no-op replay report as a change, which then persists and re-broadcasts.
 *
 * Normalizing on the way IN means everything this reducer writes carries an
 * explicit null. `sameSelection` is defensive about the other direction, for
 * blocks that were built the same way before this existed.
 */
function normalizeAnswer(answer: InterviewAnswer): InterviewAnswer {
  return answer.selection === undefined || answer.selection === null
    ? { ...answer, selection: null }
    : answer;
}

function normalizeAnswers(answers: InterviewAnswer[]): InterviewAnswer[] {
  return answers.some(
    (answer) => answer.selection === undefined || answer.selection === null,
  )
    ? answers.map(normalizeAnswer)
    : answers;
}

/**
 * How far a delivery has progressed toward the provider.
 *
 * `delivered` is the highest rank and is ABSORBING: nothing replaces it, so a
 * reordered or replayed `pending` cannot un-deliver an answer the provider
 * already has.
 */
const DELIVERY_RANK: Readonly<
  Record<InterviewDeliveryProjection["status"], number>
> = {
  pending: 0,
  delivering: 1,
  failed: 2,
  delivered: 3,
};

/**
 * Merge a delivery projection so it converges under out-of-order arrival.
 *
 * The outbox is authoritative but its updates are NOT ordered on the way here:
 * they ride settlement application, which replay, reconciliation and a
 * reconnect can all deliver out of order. Last-writer-wins would let a
 * requeued `pending` land after `delivered` and tell the user their answer was
 * never sent.
 *
 * The order of the checks is the specification, and it is not lexicographic on
 * `(generation, statusRank)` - `delivered` is tested FIRST, above generation:
 *
 * 1. Nothing recorded yet ⇒ take the incoming projection. Safe only because
 *    of where this is called from: `applyInterviewSettlement` reaches it ONLY
 *    on a same-settlement replay, and `reconcileInterviewDelivery` only after
 *    matching the block's canonical `settlementId`. This function orders
 *    updates WITHIN one outbox item; it never decides whose item it is, and a
 *    caller that skips that decision reintroduces the identity leak.
 * 2. A DIFFERENT `deliveryId` is a different outbox item, and two items carry
 *    no relative order, so the ordinary path preserves what is recorded and
 *    never swaps identity. Repairing a genuinely wrong cached id is
 *    `reconcileInterviewDelivery`'s job, not this function's.
 * 3. `delivered` is ABSORBING ACROSS GENERATIONS, in both directions: a stored
 *    `delivered` survives any incoming update, and an incoming `delivered`
 *    beats any stored non-delivered one. Delivery is terminal - the provider
 *    has the answer - so no later attempt bookkeeping can make it untrue.
 * 4. Then a strictly NEWER generation wins. That is what makes a legitimate
 *    requeue (`failed → pending`, backwards by rank) expressible without also
 *    admitting a stale replayed `pending`: a retry increments the generation,
 *    a replay does not.
 * 5. Then, within one generation, a strictly higher rank wins.
 * 6. Same generation and status, disagreeing only on `retryable`:
 *    `retryable: false` wins regardless of which side it arrived on.
 *
 * WHAT THIS DOES AND DOES NOT GUARANTEE. Rules 3-6 are commutative on every
 * pair whose members differ in status, generation, or retryability, so a set
 * of updates for one `deliveryId` converges to the same projection under any
 * arrival order. The single exception is two DIFFERENT `delivered`
 * projections for the same id: rule 3 keeps whichever was stored first, so the
 * retained `generation` label depends on arrival order. The observable state
 * - `delivered`, terminal - is identical either way, and a second `delivered`
 * at a different generation is not a state the outbox is expected to produce.
 * It is called out here so the guarantee is not read as broader than it is.
 */
function mergeDelivery(
  existing: InterviewDeliveryProjection | null,
  incoming: InterviewDeliveryProjection | null,
): InterviewDeliveryProjection | null {
  if (incoming === null) return existing;
  if (existing === null) return incoming;

  // Identity first: the ordinary path never swaps one delivery for another.
  if (existing.deliveryId !== incoming.deliveryId) return existing;

  // `delivered` is absorbing ACROSS GENERATIONS, and it has to be checked
  // before them. Ordering generation first was a hole: a requeued `pending` at
  // a newer generation outranked a stored `delivered` and un-delivered an
  // answer the provider already had. Delivery is terminal - once the provider
  // has the answer, no later attempt bookkeeping can make that untrue.
  if (existing.status === "delivered") return existing;
  if (incoming.status === "delivered") return incoming;

  // Then attempt order, then progress within an attempt.
  if (incoming.generation > existing.generation) return incoming;
  if (incoming.generation < existing.generation) return existing;
  if (DELIVERY_RANK[incoming.status] > DELIVERY_RANK[existing.status]) {
    return incoming;
  }
  if (DELIVERY_RANK[incoming.status] < DELIVERY_RANK[existing.status]) {
    return existing;
  }

  // Same attempt, same status, disagreeing only on retryability: the
  // CONSERVATIVE fact wins, not the recorded one. `retryable: false` is the
  // more terminal claim - it says no automatic retry is coming - so taking it
  // regardless of arrival order makes this branch commutative. Preferring
  // "whatever landed first" would let two peers converge on different states
  // from the same pair of updates, and would sometimes promise a retry that
  // the outbox had already ruled out.
  return incoming.retryable ? existing : incoming;
}

/**
 * Whether an incoming settlement takes the canonical slot.
 *
 * 1. No existing authority ⇒ it wins. This is what repairs an ambiguous legacy
 *    block, and what lets hydration project a durable event onto a block that
 *    crashed before its own projection landed.
 * 2. An accepted GUI settlement is never displaced - not by a later runtime
 *    resolution, and not by a second GUI settlement (the pending gate makes
 *    that a duplicate, and first-wins is the monotonic reading).
 * 3. Runtime authority yields to GUI authority, because the GUI settlement is
 *    the acceptance point the user actually experienced.
 * 4. `failed` never overwrites an established outcome. This is the explicit
 *    "a later runtime error cannot change `skipped` to `failed`" rule,
 *    generalized: an adapter reporting failure after ANY settled outcome is
 *    reporting cleanup, not the outcome. It still contributes its diagnostic
 *    through the losing path below.
 */
function settlementWins(
  block: ReducibleInterviewBlock,
  settlement: InterviewSettlement,
): boolean {
  if (settlement.outcome === "failed" && block.outcome !== null) return false;
  const existing = block.settlement;
  if (existing !== null) {
    if (existing.source === "gui") return false;
    return settlement.source === "gui";
  }
  // No RECORDED authority - but that is not the same as no authority.
  //
  // A canonical `outcome` is itself payload authority, and it can outlive its
  // provenance: `settlement` carries `.catch(null)`, so a block written by a
  // newer build with an unrecognized `source` degrades to `settlement: null`
  // while keeping `outcome: "skipped"`. Treating that as unowned let any
  // runtime settlement win and destroy the skip - losing the provenance would
  // have silently lost the FACT, which is precisely backwards.
  //
  // So a block with a canonical outcome is treated as holding at-least-runtime
  // authority, exactly as if its `source` had been recorded as `runtime`: only
  // a GUI settlement may replace it. A block with no outcome AND no authority
  // is genuinely ambiguous - a legacy row, or one whose projection crashed
  // before landing - and there the first settlement repairs it.
  //
  // The cost is narrow and deliberate: a RUNTIME settlement replayed against a
  // degraded block cannot restore the missing provenance either, because
  // letting it write authority would let it claim it authored a settlement it
  // may not have. Provenance stays missing; the outcome stays right.
  if (block.outcome !== null) return settlement.source === "gui";
  return true;
}

/**
 * Apply one canonical settlement to an interview block.
 *
 * Pure and total: every writer (active runtime checkpoint, GUI answer/Skip,
 * runtime-originated settlement, detached rewrite, hydration/reconciliation,
 * fork transforms) routes through this and no other status/error switch.
 */
export function applyInterviewSettlement(
  block: ReducibleInterviewBlock,
  settlement: InterviewSettlement,
): InterviewSettlementResult {
  const incomingAnswers = normalizeAnswers(settlement.answers);
  // Saved drafts exist ONLY for an explicit Skip - they are the values the user
  // had typed when they declined to answer. A settlement that resolves or fails
  // has no such thing, so drafts arriving with one are dropped at the boundary
  // rather than carried and rendered as "saved" work the user never saved.
  const incomingDrafts =
    settlement.outcome === "skipped"
      ? normalizeAnswers(settlement.draftAnswers)
      : [];

  const alreadyApplied =
    block.settlement !== null &&
    block.settlement.settlementId === settlement.settlementId;

  // A settlement that does not take the canonical slot - a duplicate, a
  // cleanup event, or a reapplication - can still contribute a diagnostic and
  // a delivery projection. What it can never do is move the outcome or write
  // legacy `error`: that field is the user-visible reason, not a scratch pad
  // for adapter noise.
  const wins = !alreadyApplied && settlementWins(block, settlement);

  // WHO OWNS THE PAYLOAD. Answers and drafts are user content, so writing them
  // is gated on winning the canonical slot - not merely on being non-empty.
  //
  // Getting this wrong is silent data loss, and the earlier version of this
  // function did: it preferred any non-empty incoming payload regardless of
  // authority, so a runtime resolution carrying DIFFERENT answers overwrote an
  // accepted GUI submission, and re-applying a settlement under its own id
  // with an altered payload rewrote the block it was supposed to no-op on. The
  // empty-vs-non-empty protection that motivated it is real but narrower than
  // it looked: it only ever needed to stop an EMPTY payload from erasing
  // recorded content, never to let a losing writer install its own.
  //
  // So the rule is simply: a settlement that does not win never writes payload.
  // There is deliberately no "fill an unowned block" path, because an unowned
  // block cannot produce a loser - `settlementWins` returns true whenever
  // `block.settlement` and `block.outcome` are both null, so every losing
  // settlement is by construction facing a block that already has canonical
  // content to protect. An earlier draft carried that branch and it was
  // unreachable; the comment describing it was worse than the code, because it
  // documented a policy this reducer does not implement.
  //
  // Non-empty beats empty INSIDE the winner's own payload. That is what
  // protects the OpenCode sequence: the adapter resolves the card with the
  // user's real answers, then the converter emits a SECOND
  // `interview.resolved` whose answers are empty (its question tool's output
  // is an unparseable English sentence). Without it the card regresses to
  // "No answer".
  const answersSource = wins
    ? incomingAnswers.length > 0
      ? incomingAnswers
      : block.answers
    : block.answers;
  const outcome = wins ? settlement.outcome : block.outcome;

  // Drafts are normalized against the EFFECTIVE outcome on every write, not
  // only on a winning one.
  //
  // Saved drafts exist solely for an explicit Skip, so `outcome !== "skipped"`
  // and non-empty drafts is a contradiction - and it is reachable two ways: a
  // historical row written before this invariant existed, and a losing
  // settlement that still reports `changed` because it contributed a delivery
  // generation or a diagnostic. Gating the normalization on `wins` left both
  // untouched, so a card could show a submitted answer and "drafts saved"
  // side by side indefinitely.
  //
  // Historical rows still PARSE untouched - the schema stays permissive on
  // purpose, because history must always load - and the first real write
  // through this reducer is what repairs them.
  const mergedDrafts =
    outcome !== "skipped"
      ? []
      : wins
        ? incomingDrafts.length > 0
          ? incomingDrafts
          : block.draftAnswers
        : block.draftAnswers;

  // The legacy projection is REGENERATED from the merged canonical result, not
  // mutated independently - that separation is what lets an old renderer keep
  // a valid reading of a block a new renderer reads canonically.
  //
  //   answered → completed / submitted answers / no error
  //   skipped  → errored   / no submitted answers / the skip reason
  //   failed   → errored   / existing answers if any / the failure reason
  //   null     → every legacy field left exactly as found
  const answers = wins && outcome === "skipped" ? [] : answersSource;
  const status =
    outcome === null
      ? block.status
      : outcome === "answered"
        ? "completed"
        : "errored";
  const error = !wins
    ? block.error
    : outcome === "answered"
      ? null
      : outcome === "skipped"
        ? settlement.reason
        : (settlement.reason ?? block.error);

  const authority = wins
    ? { settlementId: settlement.settlementId, source: settlement.source }
    : block.settlement;
  const diagnostics = mergeDiagnostics(
    block.diagnostics,
    settlement.diagnostic,
  );
  // Delivery is CORRELATED to settlement authority, and the three cases are
  // genuinely different operations - not one merge behind a guard.
  //
  //   wins          ⇒ ADOPT `settlement.delivery` wholesale, `null` included.
  //   alreadyApplied ⇒ MERGE, because this is the same outbox item reporting
  //                    progress and the ordering rules apply.
  //   otherwise     ⇒ PRESERVE `block.delivery` exactly.
  //
  // Adopt-on-win is the part that is easy to get wrong, and merging there is
  // actively harmful. A winner REPLACES the canonical settlement, so it brings
  // a different outbox item: merging its projection against the previous
  // settlement's would order two unrelated items against each other. With a
  // stored `{d1, delivered}` and a winning `{d2, pending}`, `mergeDelivery`
  // sees mismatched ids and keeps `d1` - so the block would go on claiming
  // DELIVERED for an answer the new settlement has not sent. A winning `null`
  // has to clear for the same reason: the new settlement has no outbox item
  // (an active waiter, a provider-originated settlement), and inheriting the
  // old projection would attribute a stale delivery to a fresh answer.
  //
  // Preserve-on-loss is what `mergeDelivery` cannot do for itself: its first
  // rule is "nothing recorded yet ⇒ take the incoming projection", so a
  // GUI-answered block with `delivery: null` meeting an unrelated losing
  // runtime settlement that carried a `pending` projection would ADOPT it,
  // attaching an outbox identity belonging to a different settlement.
  //
  // `mergeDelivery` orders updates WITHIN one outbox item. Deciding whose item
  // it is happens here, above it.
  const delivery = wins
    ? settlement.delivery
    : alreadyApplied
      ? mergeDelivery(block.delivery, settlement.delivery)
      : block.delivery;

  const changed =
    status !== block.status ||
    !sameAnswers(answers, block.answers) ||
    error !== block.error ||
    outcome !== block.outcome ||
    !sameAnswers(mergedDrafts, block.draftAnswers) ||
    !sameAuthority(authority, block.settlement) ||
    !sameDiagnostics(diagnostics, block.diagnostics) ||
    !sameDelivery(delivery, block.delivery);

  return {
    changed,
    patch: {
      status,
      answers,
      error,
      outcome,
      draftAnswers: mergedDrafts,
      settlement: authority,
      diagnostics,
      delivery,
      // Carried through untouched: this reducer never writes future settlement
      // facts, it only preserves them so `clearInterviewSettlement` can be the
      // one place that removes them.
      settlementExtensions: block.settlementExtensions,
      // Rule 6: timestamps advance only with a settlement that contributed
      // something, and they never go BACKWARDS. A pure replay leaves the block
      // byte-identical, ordering included; an out-of-order contributor (a
      // reconnect redelivering an older event, a reconciliation pass) may add
      // a diagnostic or a delivery generation without dragging the block's
      // rendered position backwards past updates that already landed.
      timestamp: changed
        ? Math.max(settlement.timestamp, block.timestamp)
        : block.timestamp,
    },
  };
}

/**
 * The ONE owner of "forget this interview was ever settled".
 *
 * Used by the `pending` fork disposition, which reopens a copied interview so
 * the forked agent can ask it again. It clears the canonical facts, the legacy
 * projection built from them, the authority, the diagnostics and the delivery
 * projection, and returns the block to `streaming` so
 * `isInterviewBlockSettled` reports it as open again. Question and framing
 * content (`questions`, `title`, `description`, `toolName`, `metadata`) is not
 * the reducer's and is left untouched.
 *
 * `settled` fork copies must NOT call this: they preserve the outcome, the
 * answers, the drafts and the evidence byte-for-byte. And a carried-unanswered
 * disposition must not call it either and then manufacture `skipped`/`failed`
 * - it records neutral/reference semantics instead.
 *
 * WHAT THIS CAN AND CANNOT CLEAR - the boundary is exact, and worth stating
 * because the obvious reading of it is wrong. This clears:
 *
 * - the settlement fields named in the current contract, enumerated below and
 *   held exhaustive against the schema by a guard test; and
 * - the WHOLE `settlementExtensions` envelope, including facts written by a
 *   build newer than this one.
 *
 * It does NOT clear an unknown TOP-LEVEL key, and cannot: a patch overlay adds
 * and replaces keys, it does not delete ones it has never heard of. That is
 * deliberate for framing and provider data - which must survive a reopen - and
 * it is exactly why a future terminal settlement fact belongs inside
 * `settlementExtensions` rather than beside these fields. A new top-level
 * settlement key would silently outlive a pending fork; the guard test exists
 * to make adding one fail loudly instead.
 */
export function clearInterviewSettlement(
  block: ReducibleInterviewBlock,
  timestamp: number,
): InterviewSettlementResult {
  const changed =
    block.status !== "streaming" ||
    block.answers.length > 0 ||
    block.error !== null ||
    block.outcome !== null ||
    block.draftAnswers.length > 0 ||
    block.settlement !== null ||
    block.diagnostics.length > 0 ||
    block.delivery !== null ||
    Object.keys(block.settlementExtensions).length > 0;

  return {
    changed,
    patch: {
      status: "streaming",
      answers: [],
      error: null,
      outcome: null,
      draftAnswers: [],
      settlement: null,
      diagnostics: [],
      delivery: null,
      // REPLACED wholesale, not enumerated. That is the point: this clears
      // settlement facts written by builds that postdate this one, which no
      // list of known keys could do.
      settlementExtensions: {},
      timestamp: changed ? timestamp : block.timestamp,
    },
  };
}

/**
 * Fail-closed fork fallback for a raw interview body that cannot be parsed by
 * this build. Keeping this owned patch here means future settlement facts are
 * added once to the authority rather than copied into a host-side fallback.
 */
export function clearedInterviewSettlementPatch(
  timestamp: number,
): InterviewSettlementPatch {
  return {
    status: "streaming",
    answers: [],
    error: null,
    outcome: null,
    draftAnswers: [],
    settlement: null,
    diagnostics: [],
    delivery: null,
    settlementExtensions: {},
    timestamp,
  };
}

/**
 * Repair a block's cached delivery projection from AUTHORITATIVE outbox truth.
 *
 * A separate, explicitly-named mode - not a weakening of
 * `applyInterviewSettlement`. The ordinary reducer merges projections that
 * arrive as a side effect of settlement application, where "this update is
 * older than it looks" is the common case and identity must be treated as
 * immutable. This one is the outbox stating what it actually holds, which is
 * the only source entitled to say a cached `deliveryId` is simply wrong.
 *
 * THE IMMUTABLE-IDENTITY INVARIANT, and what happens when it is violated. One
 * accepted settlement owns exactly one outbox item for its lifetime, so a
 * block's `deliveryId` never legitimately changes. `mergeDelivery` therefore
 * refuses a conflicting id outright rather than guessing which is current -
 * two ids carry no relative order, and picking the newer-looking one would let
 * a stale replay install an identity the outbox has never heard of. That
 * refusal is correct for the ordinary path and leaves exactly one gap: a block
 * whose cached id is genuinely wrong (a fork copied a projection, a crash
 * interleaved two writes) can never self-correct. This function is that gap's
 * only exit.
 *
 * Keyed on the block's canonical `settlementId`, and a mismatch is a NO-OP
 * rather than an error: reconciliation runs against whatever the block happens
 * to hold, and a block that has since been re-settled - or was never settled
 * at all - is not the one this outbox item describes. Repairing it anyway
 * would attach a delivery to the wrong answer, which is worse than leaving a
 * stale projection that the next subscribe corrects.
 *
 * Returns the same patch shape as the reducer so both write paths stay
 * interchangeable at the persistence boundary, and reports `changed: false`
 * when the block already agrees.
 *
 * Exported for Phase 2: the host's outbox reconciliation calls this, and
 * nothing else may swap a delivery identity.
 */
export function reconcileInterviewDelivery(
  block: ReducibleInterviewBlock,
  authoritative: {
    /** The settlement this outbox item belongs to. */
    readonly settlementId: string;
    /** What the outbox actually holds for it. */
    readonly delivery: InterviewDeliveryProjection;
    readonly timestamp: number;
  },
): InterviewSettlementResult {
  const owned = ownedPatch(block);
  // No canonical authority, or a different settlement: this outbox item does
  // not describe this block. Leave it exactly as found.
  if (
    block.settlement === null ||
    block.settlement.settlementId !== authoritative.settlementId
  ) {
    return { changed: false, patch: owned };
  }

  // Same identity ⇒ ordinary monotone merge; the outbox does not get to move a
  // delivery backwards just because it is authoritative about WHICH item is
  // current. A conflicting identity ⇒ adopt it wholesale, which is the repair.
  const delivery =
    block.delivery !== null &&
    block.delivery.deliveryId === authoritative.delivery.deliveryId
      ? mergeDelivery(block.delivery, authoritative.delivery)
      : authoritative.delivery;

  // This is a WRITE through the same persistence boundary as the reducer, so
  // it owes the same invariant: drafts exist only for an explicit Skip. A
  // historical row carrying `answered`/`failed` alongside drafts is repaired
  // here too, otherwise a block could be reconciled repeatedly and keep its
  // contradiction forever purely because the repair happened to arrive on this
  // path rather than the reducer's.
  const draftAnswers = block.outcome === "skipped" ? block.draftAnswers : [];

  const changed =
    !sameDelivery(delivery, block.delivery) ||
    !sameAnswers(draftAnswers, block.draftAnswers);
  return {
    changed,
    patch: {
      ...owned,
      draftAnswers,
      delivery,
      timestamp: changed
        ? Math.max(authoritative.timestamp, block.timestamp)
        : block.timestamp,
    },
  };
}

/**
 * Whether this block says the interview is settled - the BLOCK half of the
 * union settlement rule.
 *
 * Three independent authorities, any one of which is sufficient:
 *
 * - a canonical settlement authority is recorded;
 * - a canonical outcome is recorded (a block repaired from a durable event
 *   whose authority metadata predates this contract);
 * - the legacy `status` is terminal. This is WEAK authority: it blocks
 *   reopening but cannot manufacture a canonical outcome, which is exactly why
 *   an old completed/errored interview reads as terminal-but-ambiguous rather
 *   than as `answered`/`failed`.
 *
 * The event half - "a canonical settlement event exists" - lives with whoever
 * holds the event log; `settledInterviewBlockIds` unions the two.
 */
export function isInterviewBlockSettled(
  block: Pick<ReducibleInterviewBlock, "status" | "outcome" | "settlement">,
): boolean {
  return (
    block.settlement !== null ||
    block.outcome !== null ||
    block.status !== "streaming"
  );
}

/**
 * The single settlement-membership policy, unioning both authorities.
 *
 * Session hydration and notification reconciliation MUST use this same call.
 * They used to answer the question separately - one from persisted blocks, one
 * from the event log - and so could disagree about whether an interview was
 * still pending. Each source repairs the other's blind spot: a crash between
 * the durable append and the block projection leaves the event without the
 * block, and a block-authority-only reading of that state resurrects a
 * settled pending gate.
 *
 * Neither source is discarded when the other is missing, which is the whole
 * point of the union.
 */
export function settledInterviewBlockIds(input: {
  readonly blocks: ReadonlyArray<
    Pick<ReducibleInterviewBlock, "status" | "outcome" | "settlement"> & {
      readonly blockId: string;
    }
  >;
  /** Block ids with a canonical settlement event in the durable log. */
  readonly settlementEventBlockIds: Iterable<string>;
}): ReadonlySet<string> {
  const settled = new Set<string>(input.settlementEventBlockIds);
  for (const block of input.blocks) {
    if (isInterviewBlockSettled(block)) settled.add(block.blockId);
  }
  return settled;
}

/**
 * Overlay a reducer patch onto a RAW persisted block record.
 *
 * Fork transforms and the host's persistence boundary must not round-trip a
 * parsed `ContentBlock` back to JSON: parsing drops keys the current schema
 * does not know, so a fork taken by an older build would silently strip fields
 * a newer one wrote. Overlaying the reducer's known-field patch onto the raw
 * object is the seam that preserves them.
 */
export function overlayInterviewSettlementPatch(
  rawBlock: Readonly<Record<string, unknown>>,
  patch: InterviewSettlementPatch,
): Record<string, unknown> {
  return { ...rawBlock, ...patch };
}
