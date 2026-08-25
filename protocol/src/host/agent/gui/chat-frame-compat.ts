/**
 * Version-aware projections for the `chat.subscribe` stream that both ends
 * need and neither owns alone.
 *
 * Two things live here:
 *
 * 1. `projectChatClientFrameForVersion` - the OUTBOUND half of `1.7`
 *    compatibility. A new client sends live frames; a peer that negotiated
 *    `1.4`-`1.6` must receive the shape ITS contract declares. Sending the
 *    live frame verbatim and letting the receiver's zod strip the extra keys
 *    is not a downgrade mechanism - it is exactly the "rely on permissive
 *    unknown-field parsing as version negotiation" anti-pattern, and it hides
 *    the moment a new field stops being strippable.
 *
 * 2. `normalizeInterviewBlocksInShallowSnapshot` - the narrowly-scoped
 *    interview pass that keeps the `1.6` full-chat snapshot on its shallow
 *    path after `1.7` opened above it.
 *
 * Both are pure and dependency-free so the host and the OSS clients run the
 * same code rather than two drifting copies.
 */
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { ChatSubscribeClientFrame } from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * A client frame already reduced to its wire form for a specific negotiated
 * line. Deliberately NOT `ChatSubscribeClientFrame`: a projected frame is
 * missing keys the live type declares as present, which is the whole point.
 */
export interface ProjectedChatSubscribeClientFrame {
  readonly kind: string;
  readonly hasBinaryPayload: false;
  readonly [key: string]: unknown;
}

/**
 * The minor that introduced interview settlement on the wire: selection
 * evidence on answers, Skip intent plus saved drafts on `interviewError`.
 * Everything below it gets the fields stripped.
 */
const CHAT_SUBSCRIBE_INTERVIEW_SETTLEMENT_MINOR = 7;

/**
 * Whether the negotiated line can decode the `1.7` interview action fields.
 *
 * A null version - the handshake has not resolved yet - reads as NOT capable.
 * That is the safe direction and not merely the cautious one: a projected
 * frame is valid on every line INCLUDING `1.7` (each new field is defaulted),
 * whereas an unprojected frame sent to a `1.6` host carries intent that host
 * will silently discard, turning a deliberate Skip into a plain error with no
 * evidence anywhere that it happened.
 */
export function supportsInterviewSettlementActions(
  negotiated: SchemaVersion | null,
): boolean {
  return (
    negotiated !== null &&
    negotiated.major === 1 &&
    negotiated.minor >= CHAT_SUBSCRIBE_INTERVIEW_SETTLEMENT_MINOR
  );
}

/**
 * Encode a live client frame for the line this session actually negotiated.
 *
 * On `1.7` this is the identity. Below it:
 *
 * - `interviewAnswer` answers lose `selection`. `values` is untouched, so the
 *   answer the provider receives is byte-for-byte what it always was.
 * - `interviewError` loses its Skip intent and saved drafts, and degrades to
 *   the plain reason a pre-`1.7` host understands. The GUI must then not claim
 *   drafts were saved - they were not sent, and nothing durable recorded them.
 *
 * - `interviewDeliveryRetry` has no pre-`1.7` equivalent, so this boundary
 *   refuses it instead of relying on an older host to discard an unknown
 *   action literal.
 *
 * ONE CLIFF, DELIBERATELY - and the thing to know before adding a `1.8`. This
 * is a single "does the peer know interview settlement" test, not a chain of
 * per-line strips, because `1.7` is the only client-frame growth above the
 * frozen `1.6`. The moment a `1.8` adds another client-frame field, identity
 * for every minor `>= 7` becomes WRONG: a `1.7` peer would receive the `1.8`
 * field. At that point this must become a per-line projection (strip `1.8`
 * fields below 8, then `1.7` fields below 7), and
 * `supportsInterviewSettlementActions` stays what it is - the `1.7` predicate -
 * rather than being widened to mean "current".
 */
export function projectChatClientFrameForVersion(
  frame: ChatSubscribeClientFrame,
  negotiated: SchemaVersion | null,
): ProjectedChatSubscribeClientFrame {
  if (supportsInterviewSettlementActions(negotiated)) return frame;

  switch (frame.kind) {
    case "interviewAnswer": {
      return {
        ...frame,
        answers: frame.answers.map((answer) => ({
          questionId: answer.questionId,
          question: answer.question,
          values: answer.values,
          notes: answer.notes,
        })),
      };
    }
    case "interviewError": {
      const { settlement: _settlement, ...rest } = frame;
      return rest;
    }
    case "interviewDeliveryRetry": {
      throw new Error(
        "interviewDeliveryRetry requires chat.subscribe@1.7 or newer",
      );
    }
    default: {
      return frame;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function neutralizeAnswerSelection(answers: unknown): void {
  if (!Array.isArray(answers)) return;
  for (const answer of answers) {
    if (!isRecord(answer)) continue;
    answer.selection = null;
  }
}

/**
 * NEUTRALIZE the interview settlement fields on a snapshot that took the `1.6`
 * SHALLOW path.
 *
 * The shallow schema validates the whole bounded envelope deeply and leaves
 * `chat.messages` / `chat.events` structural, because a deep zod parse over a
 * full-chat history is seconds of render-thread CPU per snapshot. That skips
 * the compatibility defaults living inside those arrays - which for a `1.6`
 * peer is exactly the interview settlement fields. Consumers are typed as if
 * they are present, so without this pass they read `undefined` where the type
 * promises a value (`block.draftAnswers.map` throws).
 *
 * This OVERWRITES rather than fills. A legal `1.6` frame cannot carry any of
 * these fields - the frozen `1.6` schemas have no such keys - so a value found
 * here did not come from a conforming `1.6` host, and the shallow path has by
 * construction not validated it. Filling only the absent keys would let a
 * mislabeled, buggy or hostile peer smuggle an unvalidated `outcome`,
 * `settlement` authority or `delivery` projection past the parser and into
 * history, where it would read as canonical truth. Reading them as absent is
 * both the safe interpretation and the honest one: on this line they ARE
 * absent, whatever bytes arrived.
 *
 * `delivery` neutralizes to null rather than to a pending projection: a `1.6`
 * host has no outbox to project from, and inventing one would make history
 * claim a delivery state nobody recorded.
 *
 * The pass stays narrow - interview blocks only, no validation of anything
 * else - and mutates in place rather than rebuilding, because copying the
 * history is the cost the shallow path exists to avoid.
 */
export function normalizeInterviewBlocksInShallowSnapshot(
  messages: ReadonlyArray<unknown>,
): void {
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (message.role !== "assistant") continue;
    const blocks = message.blocks;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (!isRecord(block)) continue;
      if (block.type !== "interview") continue;
      block.outcome = null;
      block.settlement = null;
      block.delivery = null;
      block.draftAnswers = [];
      block.diagnostics = [];
      block.settlementExtensions = {};
      neutralizeAnswerSelection(block.answers);
    }
  }
}

// ─── Outbound SERVER-frame projection (`1.4`–`1.6`) ────────────────────────

/**
 * A server frame reduced to the wire shape of a specific negotiated line.
 *
 * Same reasoning as `ProjectedChatSubscribeClientFrame`: a projected frame is
 * missing keys the live type declares as present, which is the whole point, so
 * it deliberately is not `ChatSubscribeServerFrame`.
 */
export interface ProjectedChatSubscribeServerFrame {
  readonly kind: string;
  readonly hasBinaryPayload: false;
  readonly [key: string]: unknown;
}

function stripAnswerSelection(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((answer) => {
    if (!isRecord(answer)) return answer;
    const { selection: _selection, ...rest } = answer;
    return rest;
  });
}

/**
 * Strip settlement from ONE interview block, leaving every other block and
 * every non-settlement key untouched.
 */
function projectInterviewBlock(
  block: Record<string, unknown>,
): Record<string, unknown> {
  const {
    outcome: _outcome,
    draftAnswers: _draftAnswers,
    settlement: _settlement,
    diagnostics: _diagnostics,
    delivery: _delivery,
    settlementExtensions: _settlementExtensions,
    ...rest
  } = block;
  return { ...rest, answers: stripAnswerSelection(block.answers) };
}

function projectBlocks(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  let changed = false;
  const projected = value.map((block) => {
    if (!isRecord(block) || block.type !== "interview") return block;
    changed = true;
    return projectInterviewBlock(block);
  });
  return changed ? projected : value;
}

function projectMessage(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (value.role !== "assistant") return value;
  const blocks = projectBlocks(value.blocks);
  return blocks === value.blocks ? value : { ...value, blocks };
}

function projectMessages(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(projectMessage);
}

function projectSnapshot(
  frame: ProjectedChatSubscribeServerFrame,
): ProjectedChatSubscribeServerFrame {
  const snapshot = frame.snapshot;
  if (!isRecord(snapshot)) return frame;
  const chat = snapshot.chat;
  if (!isRecord(chat)) return frame;
  return {
    ...frame,
    snapshot: {
      ...snapshot,
      chat: {
        ...chat,
        messages: projectMessages(chat.messages),
        // The durable event log is the SECOND place interview settlement
        // reaches a subscriber, and the easier one to miss: it is metadata on
        // a chat event rather than a field on a block.
        events: projectChatEvents(chat.events),
      },
    },
  };
}

/**
 * Encode a live SERVER frame for the line the subscriber negotiated.
 *
 * This is the host→client counterpart of
 * `projectChatClientFrameForVersion`, and it lives here - in the protocol,
 * beside the frozen schemas - rather than in the host, so the shapes it
 * produces and the shapes `1.4`–`1.6` declare cannot drift apart in separate
 * repositories.
 *
 * It matters that this is a real projection and not "the old schema will drop
 * the extra keys anyway". A frozen zod schema stripping unknown keys is the
 * RECEIVER's parse, which proves nothing about what a host puts on the wire: a
 * host that never projects sends `1.7` bytes to a `1.6` peer and relies on
 * that peer's leniency, which is unknown-field parsing standing in for
 * negotiation - the exact anti-pattern the plan rules out. Projecting on the
 * send side means the bytes are honest for the negotiated line.
 *
 * Every interview-bearing surface is covered, including the nested ones that
 * are easy to miss because they are several levels below the frame kind:
 *
 * - `snapshot` → `chat.messages[].blocks[]` interview blocks;
 * - `messageAccepted` → defensive only. On every line this frame's `message`
 *   is `userMessageSchema`, and a user message has no content blocks, so there
 *   is nothing to strip today. The arm is kept because the cost is one
 *   reference comparison and the failure mode if the frame ever widens to the
 *   message union is a silent leak rather than a type error;
 * - `blockDelta` → `interview.resolved` answers;
 * - `eventAppended` and the snapshot's `chat.events` → interview settlement
 *   metadata on durable chat events (see `INTERVIEW_SETTLEMENT_METADATA_KEY`);
 * - `interviewAnswered` → answers plus the delivery projection;
 * - `interviewErrored` → outcome, saved drafts and delivery.
 *
 * The queue, background items and managed commands carry no interview content
 * and pass through untouched.
 */
export function projectChatServerFrameForVersion(
  frame: ProjectedChatSubscribeServerFrame,
  negotiated: SchemaVersion | null,
): ProjectedChatSubscribeServerFrame {
  if (supportsInterviewSettlementActions(negotiated)) return frame;

  switch (frame.kind) {
    case "actionAck": {
      if (frame.action === "interviewDeliveryRetry") {
        throw new Error(
          "interviewDeliveryRetry action acknowledgement requires chat.subscribe@1.7 or newer",
        );
      }
      return frame;
    }
    case "snapshot": {
      return projectSnapshot(frame);
    }
    case "messageAccepted": {
      const message = projectMessage(frame.message);
      return message === frame.message ? frame : { ...frame, message };
    }
    case "eventAppended": {
      const event = projectChatEvent(frame.event);
      return event === frame.event ? frame : { ...frame, event };
    }
    case "blockDelta": {
      const event = frame.event;
      if (!isRecord(event) || event.type !== "interview.resolved") return frame;
      return {
        ...frame,
        event: { ...event, answers: stripAnswerSelection(event.answers) },
      };
    }
    case "interviewAnswered": {
      const { delivery: _delivery, ...rest } = frame;
      return { ...rest, answers: stripAnswerSelection(frame.answers) };
    }
    case "interviewErrored": {
      const {
        outcome: _outcome,
        draftAnswers: _draftAnswers,
        delivery: _delivery,
        ...rest
      } = frame;
      return rest;
    }
    default: {
      return frame;
    }
  }
}

// ─── Chat-event metadata projection ────────────────────────────────────────

/**
 * The ONE metadata key a `1.7`+ host may use to attach interview settlement
 * facts to a durable chat event.
 *
 * A namespaced envelope, not flat keys, and the reason is concrete rather than
 * stylistic: the `interview.*` chat events ALREADY carry metadata on `1.4`-`1.6`,
 * and two of those keys collide with the settlement vocabulary. Today's host
 * writes `{ source: "traycer_a2a" }` on `interview.requested` and
 * `{ reason }` / `{ reason, code }` on `interview.errored` - while the durable
 * settlement payload has its own `source` and `reason`. A projector that
 * stripped settlement facts by flat name would delete `source` from an A2A
 * request event and `reason` from every errored event, silently changing what
 * `1.4`-`1.6` peers have always received.
 *
 * So settlement facts live under this key and nowhere else, the projector
 * removes exactly this key, and pre-existing metadata is untouched. Nested
 * future facts go inside it and are removed wholesale - the same argument that
 * puts future block facts in `settlementExtensions`.
 *
 * PHASE 2 OBLIGATION: the host must write `DurableInterviewSettlement` under
 * this key. Writing `outcome`/`draftAnswers`/`settlementId` flat onto the
 * metadata bag would leak them to every pre-`1.7` peer, because a typed
 * projector cannot strip a key it was never told about.
 */
export const INTERVIEW_SETTLEMENT_METADATA_KEY = "interviewSettlement";

/**
 * The opaque delivery envelope paired with a detached settlement. It is only
 * durable-repair input for the host (identity, owner, and exact provider
 * payload); pre-`1.7` peers must not observe this new metadata surface.
 */
export const INTERVIEW_DELIVERY_METADATA_KEY = "interviewDelivery";

/**
 * Metadata keys whose value is an array of interview ANSWERS, each of which
 * may carry `selection` under `1.7`.
 *
 * `answers` is the live one: `interview.resolved` events are written with
 * `metadata: { answers }`, so a `1.7` host's selection evidence reaches a
 * `1.4`-`1.6` peer through `snapshot.chat.events` and `eventAppended` unless
 * it is stripped here. Enumerated rather than discovered, so this never walks
 * into unrelated provider metadata looking for something answer-shaped.
 */
const INTERVIEW_ANSWER_METADATA_KEYS: ReadonlyArray<string> = ["answers"];

const INTERVIEW_CHAT_EVENT_TYPES: ReadonlyArray<string> = [
  "interview.requested",
  "interview.resolved",
  "interview.errored",
];

/**
 * Project ONE durable chat event for a pre-`1.7` line.
 *
 * Returns the same reference when nothing needed changing, so a snapshot whose
 * events carry no interview settlement is not needlessly rebuilt.
 */
function projectChatEvent(event: unknown): unknown {
  if (!isRecord(event)) return event;
  if (typeof event.type !== "string") return event;
  if (!INTERVIEW_CHAT_EVENT_TYPES.includes(event.type)) return event;
  const metadata = event.metadata;
  if (!isRecord(metadata)) return event;

  const hasSettlement = Object.hasOwn(
    metadata,
    INTERVIEW_SETTLEMENT_METADATA_KEY,
  );
  const hasDelivery = Object.hasOwn(metadata, INTERVIEW_DELIVERY_METADATA_KEY);
  const answerKeys = INTERVIEW_ANSWER_METADATA_KEYS.filter((key) =>
    Array.isArray(metadata[key]),
  );
  if (!hasSettlement && !hasDelivery && answerKeys.length === 0) return event;

  const projectedMetadata: Record<string, unknown> = { ...metadata };
  delete projectedMetadata[INTERVIEW_SETTLEMENT_METADATA_KEY];
  delete projectedMetadata[INTERVIEW_DELIVERY_METADATA_KEY];
  for (const key of answerKeys) {
    projectedMetadata[key] = stripAnswerSelection(metadata[key]);
  }
  return { ...event, metadata: projectedMetadata };
}

function projectChatEvents(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  let changed = false;
  const projected = value.map((event) => {
    const next = projectChatEvent(event);
    if (next !== event) changed = true;
    return next;
  });
  return changed ? projected : value;
}
