/**
 * The single settlement authority for an interview block.
 * Reapplying the same id is a no-op, which is what makes replay and reconciliation safe to run repeatedly. - `diagnosticId` is deduplicated independently in `diagnostics`, so a retried cleanup cannot multiply codes.
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
 * `reason` is user-visible text; content-free cleanup codes belong in `diagnostic`, never here.
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
   * Content-free outbox projection for a detached settlement, or null for "not reported" (an active waiter, a provider-originated settlement, a legacy row).
   */
  readonly delivery: InterviewDeliveryProjection | null;
  /**
   * Wall-clock ms to stamp on the block IF this settlement contributes something.
   * A settlement that contributes nothing leaves `timestamp` untouched, which is what keeps replay idempotent all the way down to the rendered ordering.
   */
  readonly timestamp: number;
}

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
   * False ⇒ the patch is field-for-field what the block already says.
   * Callers skip the write and, crucially, skip the broadcast: a re-applied settlement must not look like a fresh one to a renderer.
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
 * The patch that says "nothing changed" for this block - every field this module owns, at the value the block already holds.
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

/** Absent and `null` selection are the same absence. Coerce both sides before comparing so a no-op replay is not a change. */
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

/** Structural, not reference, equality - deliberately. */
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
 * `changed` is what tells a caller whether to persist, so a field omitted here is a field that can be silently dropped.
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

/** Deduplicate by `diagnosticId`. Return the same array reference when nothing is added so `changed` stays a reference comparison. */
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
 * That is not a theoretical hole - it silently breaks `changed`, because `undefined !== null` makes a genuine no-op replay report as a change, which then persists and re-broadcasts.
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
 * `delivered` is the highest rank and is ABSORBING: nothing replaces it, so a reordered or replayed `pending` cannot un-deliver an answer the provider already has.
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
 * Last-writer-wins would let a requeued `pending` land after `delivered` and tell the user their answer was never sent.
 */
function mergeDelivery(
  existing: InterviewDeliveryProjection | null,
  incoming: InterviewDeliveryProjection | null,
): InterviewDeliveryProjection | null {
  if (incoming === null) return existing;
  if (existing === null) return incoming;

  // Identity first: the ordinary path never swaps one delivery for another.
  if (existing.deliveryId !== incoming.deliveryId) return existing;

  // `delivered` is absorbing ACROSS GENERATIONS, and it has to be checked before them.
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

  // Same attempt, same status, disagreeing only on retryability: the CONSERVATIVE fact wins, not the recorded one.
  return incoming.retryable ? existing : incoming;
}

/**
 * Whether an incoming settlement takes the canonical slot.
 * This is the explicit "a later runtime error cannot change `skipped` to `failed`" rule, generalized: an adapter reporting failure after ANY settled outcome is reporting cleanup, not the outcome.
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
  // Treating that as unowned let any runtime settlement win and destroy the skip - losing the provenance would have silently lost the FACT, which is precisely backwards.
  if (block.outcome !== null) return settlement.source === "gui";
  return true;
}

export function applyInterviewSettlement(
  block: ReducibleInterviewBlock,
  settlement: InterviewSettlement,
): InterviewSettlementResult {
  const incomingAnswers = normalizeAnswers(settlement.answers);
  // Saved drafts exist ONLY for an explicit Skip - they are the values the user had typed when they declined to answer.
  // A settlement that resolves or fails has no such thing, so drafts arriving with one are dropped at the boundary rather than carried and rendered as "saved" work the user never saved.
  const incomingDrafts =
    settlement.outcome === "skipped"
      ? normalizeAnswers(settlement.draftAnswers)
      : [];

  const alreadyApplied =
    block.settlement !== null &&
    block.settlement.settlementId === settlement.settlementId;

  // A settlement that does not take the canonical slot - a duplicate, a cleanup event, or a reapplication - can still contribute a diagnostic and a delivery projection.
  // What it can never do is move the outcome or write legacy `error`: that field is the user-visible reason, not a scratch pad for adapter noise.
  const wins = !alreadyApplied && settlementWins(block, settlement);

  // Runtime adapters may first emit a structurally valid but empty resolution and later provide the actual answers.
  // It cannot replace non-empty content, cross GUI authority, or change the outcome.
  const fillsEmptyRuntimeAnswers =
    !wins &&
    !alreadyApplied &&
    block.settlement?.source === "runtime" &&
    block.outcome === "answered" &&
    block.answers.length === 0 &&
    settlement.source === "runtime" &&
    settlement.outcome === "answered" &&
    incomingAnswers.length > 0;

  // WHO OWNS THE PAYLOAD.
  // So the rule is simply: a settlement that does not win never writes payload.
  const answersSource = fillsEmptyRuntimeAnswers
    ? incomingAnswers
    : wins
      ? incomingAnswers.length > 0
        ? incomingAnswers
        : block.answers
      : block.answers;
  const outcome = wins ? settlement.outcome : block.outcome;

  // Drafts are normalized against the EFFECTIVE outcome on every write, not only on a winning one.
  // Historical rows still PARSE untouched - the schema stays permissive on purpose, because history must always load - and the first real write through this reducer is what repairs them.
  const mergedDrafts =
    outcome !== "skipped"
      ? []
      : wins
        ? incomingDrafts.length > 0
          ? incomingDrafts
          : block.draftAnswers
        : block.draftAnswers;

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
  // Delivery is CORRELATED to settlement authority, and the three cases are genuinely different operations - not one merge behind a guard.
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
      // Carried through untouched: this reducer never writes future settlement facts, it only preserves them so `clearInterviewSettlement` can be the one place that removes them.
      settlementExtensions: block.settlementExtensions,
      // Rule 6: timestamps advance only with a settlement that contributed something, and they never go BACKWARDS.
      timestamp: changed
        ? Math.max(settlement.timestamp, block.timestamp)
        : block.timestamp,
    },
  };
}

/**
 * The ONE owner of "forget this interview was ever settled".
 * WHAT THIS CAN AND CANNOT CLEAR - the boundary is exact, and worth stating because the obvious reading of it is wrong.
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
      // REPLACED wholesale, not enumerated.
      settlementExtensions: {},
      timestamp: changed ? timestamp : block.timestamp,
    },
  };
}

/** Fail-closed fork fallback for a raw interview body that cannot be parsed by this build. */
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
 * One accepted settlement owns exactly one outbox item for its lifetime, so a block's `deliveryId` never legitimately changes.
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

  // Same identity ⇒ ordinary monotone merge; the outbox does not get to move a delivery backwards just because it is authoritative about WHICH item is current.
  const delivery =
    block.delivery !== null &&
    block.delivery.deliveryId === authoritative.delivery.deliveryId
      ? mergeDelivery(block.delivery, authoritative.delivery)
      : authoritative.delivery;

  // This is a WRITE through the same persistence boundary as the reducer, so it owes the same invariant: drafts exist only for an explicit Skip.
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
 * Whether this block says the interview is settled - the BLOCK half of the union settlement rule.
 * This is WEAK authority: it blocks reopening but cannot manufacture a canonical outcome, which is exactly why an old completed/errored interview reads as terminal-but-ambiguous rather than as `answered`/`failed`.
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
 * Session hydration and notification reconciliation MUST use this same call.
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

/** Overlay a reducer patch onto a RAW persisted block record. */
export function overlayInterviewSettlementPatch(
  rawBlock: Readonly<Record<string, unknown>>,
  patch: InterviewSettlementPatch,
): Record<string, unknown> {
  return { ...rawBlock, ...patch };
}
