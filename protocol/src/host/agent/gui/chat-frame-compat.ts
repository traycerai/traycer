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
 * 2. `normalizeV16MessagesInShallowSnapshot` - the narrowly-scoped message
 *    pass that keeps the `1.6` full-chat snapshot on its shallow path after
 *    `1.7` opened above it.
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
const CHAT_SUBSCRIBE_V17_MINOR = 7;

function supportsV17(negotiated: SchemaVersion | null): boolean {
  return (
    negotiated !== null &&
    negotiated.major === 1 &&
    negotiated.minor >= CHAT_SUBSCRIBE_V17_MINOR
  );
}

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
  return supportsV17(negotiated);
}

/**
 * Encode a live client frame for the line this session actually negotiated.
 *
 * On `1.7` this is the identity. Below it:
 *
 * - `send` loses browser annotations, which do not exist on the released
 *   lines.
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
 * is a single "does the peer know 1.7" test, not a chain of per-line strips,
 * because `1.7` is the only client-frame growth above the frozen `1.6`. The
 * moment a `1.8` adds another client-frame field, identity
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
  if (supportsV17(negotiated)) return frame;

  switch (frame.kind) {
    case "send": {
      const { browserAnnotations: _browserAnnotations, ...rest } = frame;
      return rest;
    }
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

/**
 * Neutralize the `1.7`-only browser arrays on ONE user-authored payload.
 *
 * The single implementation behind every receive-side `1.6` surface: history
 * messages, queue prompt items, and `messageAccepted`. Agent payloads
 * (`kind: "agent"`) never carry these fields and are left alone.
 */
function normalizeUserAuthoredPayload(payload: unknown): void {
  if (!isRecord(payload) || payload.kind !== "user") return;
  payload.browserAnnotations = [];
}

function neutralizeAnswerSelection(answers: unknown): void {
  if (!Array.isArray(answers)) return;
  for (const answer of answers) {
    if (!isRecord(answer)) continue;
    answer.selection = null;
  }
}

/**
 * The questions-side counterpart of `neutralizeAnswerSelection`.
 *
 * `null`, not `false`: on the live schema `null` is "unstated", which every
 * renderer treats exactly as it did before the field existed. Neutralizing to
 * `false` would WITHDRAW the free-text channel rather than restore the line's
 * own behaviour - turning a smuggled field into a working suppression, which
 * is the harm this pass exists to prevent.
 */
function neutralizeQuestionCustomAnswer(questions: unknown): void {
  if (!Array.isArray(questions)) return;
  for (const question of questions) {
    if (!isRecord(question)) continue;
    question.allowsCustomAnswer = null;
  }
}

/**
 * Normalize live-only message fields on a snapshot that took the `1.6`
 * SHALLOW path.
 *
 * The shallow schema validates the whole bounded envelope deeply and leaves
 * `chat.messages` / `chat.events` structural, because a deep zod parse over a
 * full-chat history is seconds of render-thread CPU per snapshot. That skips
 * the compatibility defaults living inside those arrays - which for a `1.6`
 * peer is the interview settlement fields, `allowsCustomAnswer` on each
 * question, and the two browser arrays on a user-authored message. Consumers
 * are typed as if they are present, so without this pass they read `undefined`
 * where the type promises a value (`block.draftAnswers.map` throws).
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
 * The pass stays narrow - user-authored payloads and interview blocks only -
 * and mutates in place rather than rebuilding, because copying the history is
 * the cost the shallow path exists to avoid.
 *
 * SCOPE - `chat.messages` ONLY. The snapshot's queue needs nothing here: the
 * frozen `1.6` schema DEEP-parses it, so a browser payload on a `1.6` queue
 * item is stripped as an unknown key and the caller's live re-parse then
 * supplies `[]` from the live payload schema's `.default([])`. That second,
 * live parse is therefore part of the contract rather than a cosmetic
 * re-validation. The frames that arrive OUTSIDE a snapshot get no frozen parse
 * at all - see `normalizeV16BrowserPayloadsInFrame`.
 */
export function normalizeV16MessagesInShallowSnapshot(
  messages: ReadonlyArray<unknown>,
): void {
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (message.role === "user") {
      normalizeUserAuthoredPayload(message.message);
      continue;
    }
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
      neutralizeQuestionCustomAnswer(block.questions);
      neutralizeAnswerSelection(block.answers);
    }
  }
}

/**
 * Neutralize the `1.7`-only browser arrays on a NON-snapshot server frame that
 * arrived on the `1.6` line.
 *
 * Snapshots get their neutralization for free: they are parsed against the
 * frozen `1.6` schemas first, which strip the browser keys as unknown before a
 * live re-parse defaults them to `[]`. `messageAccepted` and `queueChanged` are
 * not: a client parses them with the LIVE union whatever line it negotiated, so
 * a mislabeled, stale or hostile "`1.6`" peer's browser payload would arrive
 * VALIDATED and be written into history as canonical - the same smuggling the
 * snapshot pass exists to prevent, through the door beside it.
 *
 * Same OVERWRITE reading as `normalizeV16MessagesInShallowSnapshot`: a legal
 * `1.6` frame cannot carry these fields, so on this line they are absent
 * whatever bytes arrived. Empty, never `undefined` - consumers are typed as if
 * both arrays are present.
 *
 * Mutates in place and ignores every other frame kind, so a caller can hand it
 * each parsed frame unconditionally.
 */
export function normalizeV16BrowserPayloadsInFrame(frame: unknown): void {
  if (!isRecord(frame)) return;
  if (frame.kind === "messageAccepted") {
    const message = frame.message;
    if (!isRecord(message) || message.role !== "user") return;
    normalizeUserAuthoredPayload(message.message);
    return;
  }
  if (frame.kind !== "queueChanged") return;
  const queue = frame.queue;
  if (!isRecord(queue) || !Array.isArray(queue.items)) return;
  for (const item of queue.items) {
    if (!isRecord(item) || item.kind !== "prompt") continue;
    normalizeUserAuthoredPayload(item.message);
  }
}

/**
 * Neutralize the `1.7`-only interview fields on a frame received on a
 * pre-`1.7` line.
 *
 * The interview half of receive-side `1.7` compatibility, and the one the two
 * passes above do not reach: `normalizeV16BrowserPayloadsInFrame` owns the
 * USER-authored browser payloads, and `normalizeV16MessagesInShallowSnapshot`
 * neutralizes a message history but nothing beside it. A pre-`1.7` peer's
 * interview fields otherwise reach consumers unopposed - the same smuggling
 * the two passes above refuse, through the doors beside them. On the TYPED
 * carriers they arrive validated, which is the sharper version of the problem:
 * the live union accepted them, so nothing downstream has reason to doubt
 * them. On a chat event's `metadata` - `record(string, unknown)` - and on a
 * shallow snapshot's `z.custom` histories they arrive unexamined instead, and
 * this pass is the only thing that looks at them at all.
 *
 * TWO ROUTES REACH THIS, and the second is easy to lose. Most frames fall
 * through to the generic live parse and are handed here after it. But the
 * exact-`1.6` snapshot takes its own fast path in `ChatStreamClient`, and
 * BOTH schemas on that path leave `chat.messages` and `chat.events`
 * structural (`z.custom(isStructuralRecord)`) - so neither parse strips
 * anything inside either history, and that route calls this pass directly on
 * the frame it just parsed. Wiring it to the message-only pass instead is
 * what left the shipped `1.6` cohort's event log open.
 *
 * EVERY carrier of an interview, because a pass written for one of them
 * silently leaves the rest open - which is the exact defect the outbound
 * projector's `blockDelta` case was fixed for, and this is its inbound mirror.
 *
 * "Mirror" is how the enumeration below was DERIVED rather than recalled:
 * `projectChatServerFrameForVersion` already had to decide, frame by frame,
 * what a pre-`1.7` peer may see, so its interview-bearing cases are the list,
 * one for one, and adding a case there without one here reopens a door. It is
 * a strong heuristic, not a proof - two hand-written switches agreeing is not
 * an independent oracle, and the projector is not exhaustive over every
 * live/frozen difference (`turnStateChanged`'s `activeTurn` differs by line
 * with no case at all). What is checked here is the INTERVIEW surface, against
 * the schemas and the receive call sites.
 *
 * Its other non-interview cases are accounted for by name rather than by
 * silence. `messageAccepted` is one of them - see the bullet below for why it
 * is not a live interview carrier despite having an arm here. Of the rest:
 * `queueChanged` carries browser payloads, owned by
 * `normalizeV16BrowserPayloadsInFrame` beside this; `managedCommandsChanged`
 * has no interview surface at all; and `actionAck`'s only `1.7` delta is the
 * `interviewDeliveryRetry` value in its `action` enum, which no consumer
 * dispatches on - the GUI matches an ack to its OWN `pendingActions` by
 * `clientActionId` and never reads `action`, and a client on this line cannot
 * have queued that action to match. That one the projector refuses outright
 * rather than projecting, which is why it has no field to neutralize here.
 *
 * Only this direction needs a pass at all. A host resolver selects the
 * negotiated contract's OWN `clientFrameSchema` and parses against it, so a
 * pre-`1.7` client's `1.7` field is dropped as an unknown key before the
 * session handler runs. A client cannot mirror that: apart from the two
 * snapshot fast paths and the windowed union, it parses server frames with the
 * live union whatever line it negotiated - which is precisely the asymmetry
 * these passes exist to cover.
 *
 * - `snapshot`, on both routes. `1.0`-`1.5` match NEITHER fast path (one is
 *   exact-current, the other exact-`1.6`) and reach the generic parse whole;
 *   exact-`1.6` arrives from its fast path. BOTH histories it carries:
 *   `chat.messages` holds the blocks, and `chat.events` is the second place
 *   settlement reaches a subscriber - the one the outbound `projectSnapshot`
 *   calls "the easier to miss", and it was missed here.
 * - `eventAppended`, the single-event door onto the same durable log.
 * - `interviewAnswered` and `interviewErrored`, the dedicated lifecycle frames.
 *   Both gained `1.7` fields of their own (`delivery`, `settlementId`,
 *   `settlementSource`, plus `outcome`/`draftAnswers` on the errored one), and
 *   `interviewAnswered.answers` is a live answer array - so selection evidence
 *   has a straight path in that no message-level pass can see.
 * - `blockDelta`, on BOTH its arms: questions ride `interview.requested`,
 *   answer selection rides `interview.resolved`.
 * - `messageAccepted` is DEFENSIVE, not a live carrier, and the difference is
 *   worth stating because the arm reads like the others: its `message` binds
 *   `userMessageSchema`, whose `role` is the literal `"user"`, so a parsed
 *   frame cannot hold an assistant message with interview blocks. The arm
 *   costs one delegation and covers the unparsed and malformed inputs this
 *   helper also accepts; it is not what closes a hole.
 *
 * `interviewRequested` alone needs nothing, and this is a fact about the frame
 * rather than an omission: its live shape is `blockId` + `requestedAt`, byte
 * for byte its pre-`1.7` shape. The questions live on the block, never on it.
 *
 * The message cases delegate to the pass above, so all seven message-level
 * fields are neutralized together rather than by two rules that could drift.
 * Its overlap with the browser pass on a user-authored `messageAccepted` is
 * idempotent by construction - both write the same empty arrays.
 *
 * Same OVERWRITE reading as the passes above: a legal pre-`1.7` frame cannot
 * carry these fields, so on this line they are absent whatever bytes arrived.
 * Mutates in place and ignores every other frame kind, so a caller can hand it
 * each parsed frame unconditionally.
 */
export function normalizeV16InterviewFieldsInFrame(frame: unknown): void {
  if (!isRecord(frame)) return;
  switch (frame.kind) {
    case "snapshot": {
      const snapshot = frame.snapshot;
      if (!isRecord(snapshot)) return;
      const chat = snapshot.chat;
      if (!isRecord(chat)) return;
      // Independently guarded, not `&&`-chained: a snapshot whose `messages`
      // is not an array must still have its `events` neutralized, and vice
      // versa. Defensive rather than a live bypass - both production routes
      // parse these as `z.array(...)`, so a non-array half fails before it
      // reaches here - but this function takes `unknown` by contract, and a
      // guard that lets one malformed history silence the other is the kind
      // of coupling that becomes a bypass the first time a caller hands it
      // something less validated.
      if (Array.isArray(chat.messages)) {
        normalizeV16MessagesInShallowSnapshot(chat.messages);
      }
      if (Array.isArray(chat.events)) {
        for (const event of chat.events) {
          neutralizeChatEventInterviewMetadata(event);
        }
      }
      return;
    }
    case "messageAccepted": {
      normalizeV16MessagesInShallowSnapshot([frame.message]);
      return;
    }
    case "eventAppended": {
      neutralizeChatEventInterviewMetadata(frame.event);
      return;
    }
    case "interviewAnswered": {
      neutralizeAnswerSelection(frame.answers);
      frame.settlementId = null;
      frame.settlementSource = null;
      frame.delivery = null;
      return;
    }
    case "interviewErrored": {
      // `draftAnswers` is emptied rather than selection-neutralized: the whole
      // array is `1.7`-only, so on this line there are no drafts to keep. It
      // is cleared BESIDE `outcome` because the live frame's own refinement
      // ties them together - drafts are only meaningful under `skipped`, so
      // nulling `outcome` while leaving drafts would manufacture exactly the
      // combination that schema rejects.
      frame.outcome = null;
      frame.draftAnswers = [];
      frame.settlementId = null;
      frame.settlementSource = null;
      frame.delivery = null;
      return;
    }
    case "blockDelta": {
      const event = frame.event;
      if (!isRecord(event)) return;
      if (event.type === "interview.requested") {
        neutralizeQuestionCustomAnswer(event.questions);
        return;
      }
      if (event.type !== "interview.resolved") return;
      neutralizeAnswerSelection(event.answers);
      return;
    }
    default: {
      return;
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
 * Drop `allowsCustomAnswer` from every question of one interview carrier.
 *
 * Stripped HERE - on the legacy path - and nowhere else. `1.7`+ take the
 * projector's identity return by design (`is identity on {1,7}`) and observe
 * the field, the same way they observe interview settlement; the freeze
 * boundary for questions is `@1.6`, which is exactly the set this path serves.
 *
 * Without it the projected frame would carry a field the frozen `@1.6`
 * contract then strips on parse, so `parse(projected)` would stop equalling
 * `projected` - the invariant the compat suite pins.
 */
function stripQuestionCustomAnswer(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((question) => {
    if (!isRecord(question)) return question;
    const { allowsCustomAnswer: _allowsCustomAnswer, ...rest } = question;
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
  return {
    ...rest,
    questions: stripQuestionCustomAnswer(block.questions),
    answers: stripAnswerSelection(block.answers),
  };
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

function projectUserAuthoredPayload(value: unknown): unknown {
  if (!isRecord(value) || value.kind !== "user") return value;
  if (!Object.hasOwn(value, "browserAnnotations")) return value;
  const { browserAnnotations: _browserAnnotations, ...rest } = value;
  return rest;
}

function projectMessage(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (value.role === "user") {
    const message = projectUserAuthoredPayload(value.message);
    return message === value.message ? value : { ...value, message };
  }
  if (value.role !== "assistant") return value;
  const blocks = projectBlocks(value.blocks);
  return blocks === value.blocks ? value : { ...value, blocks };
}

function projectMessages(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(projectMessage);
}

function projectQueue(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.items)) return value;
  let changed = false;
  const items = value.items.map((item) => {
    if (!isRecord(item) || item.kind !== "prompt") return item;
    const message = projectUserAuthoredPayload(item.message);
    if (message === item.message) return item;
    changed = true;
    return { ...item, message };
  });
  return changed ? { ...value, items } : value;
}

/**
 * Drop `relaunchOnHostRestart` from a list of managed commands. `1.6` shipped
 * binding the command WITHOUT it (`managedCommandSchemaPreRelaunch`), and the
 * flag rides `1.7`+ only; the same strip serves the snapshot's set and the
 * `managedCommandsChanged` frame. Identity when nothing carries the key.
 */
function projectManagedCommands(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  let changed = false;
  const projected = value.map((command) => {
    if (
      !isRecord(command) ||
      !Object.hasOwn(command, "relaunchOnHostRestart")
    ) {
      return command;
    }
    changed = true;
    const { relaunchOnHostRestart: _relaunchOnHostRestart, ...rest } = command;
    return rest;
  });
  return changed ? projected : value;
}

function projectSnapshot(
  frame: ProjectedChatSubscribeServerFrame,
): ProjectedChatSubscribeServerFrame {
  const snapshot = frame.snapshot;
  if (!isRecord(snapshot)) return frame;
  const chat = snapshot.chat;
  if (!isRecord(chat)) return frame;
  // Only rewrite the key when the snapshot carries it: a pre-`1.6` peer's
  // snapshot has already had the set stripped, and must not grow it back as
  // an explicit `undefined`.
  const managedCommands = Object.hasOwn(snapshot, "managedCommands")
    ? { managedCommands: projectManagedCommands(snapshot.managedCommands) }
    : {};
  return {
    ...frame,
    snapshot: {
      ...snapshot,
      queue: projectQueue(snapshot.queue),
      ...managedCommands,
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
 * Every `1.7`-only surface is covered, including the nested ones that are easy
 * to miss because they are several levels below the frame kind:
 *
 * - `snapshot` → `chat.messages[].blocks[]` interview blocks;
 * - `messageAccepted` → browser annotations on its user message;
 * - `blockDelta` → `interview.resolved` answers;
 * - `eventAppended` and the snapshot's `chat.events` → interview settlement
 *   metadata on durable chat events (see `INTERVIEW_SETTLEMENT_METADATA_KEY`);
 * - `interviewAnswered` → answers plus the delivery projection;
 * - `interviewErrored` → outcome, saved drafts and delivery;
 * - the snapshot's `managedCommands` and the `managedCommandsChanged` frame →
 *   `relaunchOnHostRestart` on each command (the `1.6` line binds the
 *   pre-relaunch command shape).
 *
 * Queue prompt items carry the same user-authored browser payload as accepted
 * messages, so snapshots and `queueChanged` frames project that payload too.
 */
export function projectChatServerFrameForVersion(
  frame: ProjectedChatSubscribeServerFrame,
  negotiated: SchemaVersion | null,
): ProjectedChatSubscribeServerFrame {
  // BEFORE the 1.7 identity return: `chat.imported` shipped on the 1.8 line,
  // and a released 1.7 client's strict event enum fails the WHOLE snapshot on
  // an unknown member - so every pre-1.8 peer must never see the event. A
  // client that cannot render an import provenance row has nothing to do with
  // the value anyway.
  const preImportSafe = projectPreImportedFrame(frame, negotiated);
  if (supportsV17(negotiated)) return preImportSafe;
  frame = preImportSafe;

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
    case "queueChanged": {
      const queue = projectQueue(frame.queue);
      return queue === frame.queue ? frame : { ...frame, queue };
    }
    case "managedCommandsChanged": {
      const managedCommands = projectManagedCommands(frame.managedCommands);
      return managedCommands === frame.managedCommands
        ? frame
        : { ...frame, managedCommands };
    }
    case "eventAppended": {
      const event = projectChatEvent(frame.event);
      return event === frame.event ? frame : { ...frame, event };
    }
    case "blockDelta": {
      const event = frame.event;
      if (!isRecord(event)) return frame;
      // Questions travel on `interview.requested`, answers on
      // `interview.resolved` - two carriers on the same frame kind, so a strip
      // written for one silently misses the other.
      if (event.type === "interview.requested") {
        return {
          ...frame,
          event: {
            ...event,
            questions: stripQuestionCustomAnswer(event.questions),
          },
        };
      }
      if (event.type !== "interview.resolved") return frame;
      return {
        ...frame,
        event: { ...event, answers: stripAnswerSelection(event.answers) },
      };
    }
    case "interviewAnswered": {
      const {
        delivery: _delivery,
        settlementId: _settlementId,
        settlementSource: _settlementSource,
        ...rest
      } = frame;
      return { ...rest, answers: stripAnswerSelection(frame.answers) };
    }
    case "interviewErrored": {
      const {
        outcome: _outcome,
        draftAnswers: _draftAnswers,
        settlementId: _settlementId,
        settlementSource: _settlementSource,
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

// ─── Chat-event interview metadata (BOTH directions) ───────────────────────
//
// The outbound projector and the inbound normalizer bind the same vocabulary,
// so they live together: the keys below, the projection that removes them for
// a pre-`1.7` peer, and the neutralizer that refuses them from one. Splitting
// the pair across the file is what let the inbound half ship without the
// event-log door at all.

/**
 * The ONE metadata key a `1.7`+ host may use to attach interview settlement
 * facts to a durable chat event.
 *
 * A namespaced envelope, not flat keys, and the reason is concrete rather than
 * stylistic: the `interview.*` chat events ALREADY carry flat metadata on
 * `1.4`-`1.6` whose names collide with the settlement vocabulary. The durable
 * settlement writer itself puts `reason` and `code` on `interview.errored`
 * beside the envelope, and a forked request carries `carriedFromChatId` -
 * while the settlement payload has its own `source` and `reason`. A projector
 * that stripped settlement facts by flat name would delete those, silently
 * changing what `1.4`-`1.6` peers have always received.
 *
 * (`source: "traycer_a2a"` is the example that used to sit here, and it is
 * NOT one: the host sets it on a RUNTIME `interview.requested` event, whose
 * durable counterpart is written with `metadata: null`. Tests still use it as
 * a synthetic colliding key, which is exactly what it is.)
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

/**
 * The content-free companion fact proving a provider accepted an
 * already-settled delivery. Carries `settlementId` and `deliveryId` - `1.7`
 * identities both - on a durable `interview.errored` event.
 */
export const INTERVIEW_DELIVERY_ACCEPTANCE_METADATA_KEY =
  "interviewDeliveryAcceptance";

/**
 * The companion fact for the settlement→outbox repair path, carrying
 * `settlementId`, `diagnosticId`, `code` and `source`.
 */
export const INTERVIEW_DELIVERY_REPAIR_DIAGNOSTIC_METADATA_KEY =
  "interviewDeliveryRepairDiagnostic";

/**
 * The delivery identities a history rewrite cancelled, written on a
 * `history.deleted` event: `[{ settlementId, deliveryId, blockId }]`.
 *
 * The one structured interview fact that does NOT ride an `interview.*` event,
 * which is exactly why it outlived the first four - see
 * `INTERVIEW_METADATA_CHAT_EVENT_TYPES` below.
 */
export const DELETED_INTERVIEW_DELIVERIES_METADATA_KEY =
  "deletedInterviewDeliveries";

/**
 * EVERY `1.7`-only structured interview key a durable chat event's metadata
 * may carry, as one list both directions read.
 *
 * A list rather than four named deletions, and the reason is a bug this
 * already caused. The doc on `INTERVIEW_SETTLEMENT_METADATA_KEY` above states
 * the obligation plainly - "a typed projector cannot strip a key it was never
 * told about" - and the host then added the two companion keys below as its
 * OWN local constants while importing the first two from here. Protocol had
 * never heard of them, so both projectors passed them straight through to
 * every pre-`1.7` peer, `settlementId` included, for as long as they existed.
 *
 * So the vocabulary lives here and the host imports all four. Adding a key
 * means adding it to this list, which is the only edit that makes it
 * strippable in either direction. `answers` is deliberately NOT here - it is a
 * pre-`1.7` key whose CONTENTS are filtered rather than removed, which is a
 * different operation.
 */
const INTERVIEW_STRUCTURED_METADATA_KEYS: ReadonlyArray<string> = [
  INTERVIEW_SETTLEMENT_METADATA_KEY,
  INTERVIEW_DELIVERY_METADATA_KEY,
  INTERVIEW_DELIVERY_ACCEPTANCE_METADATA_KEY,
  INTERVIEW_DELIVERY_REPAIR_DIAGNOSTIC_METADATA_KEY,
  DELETED_INTERVIEW_DELIVERIES_METADATA_KEY,
];

/**
 * Event types whose METADATA can carry a `1.7` interview fact.
 *
 * Enumerated by what the metadata holds, not by what the event is about, and
 * that distinction is the whole reason this list has a name of its own. It was
 * `INTERVIEW_CHAT_EVENT_TYPES` - the three `interview.*` types - and under that
 * predicate a fifth structured key survived every widening of the KEY list,
 * because it rides `history.deleted`: a history rewrite cancels the delivery
 * obligations of the interviews it removed, and records which ones it
 * cancelled as `settlementId`/`deliveryId` pairs. No reading of "is this an
 * interview event" reaches it, so both directions returned at this gate before
 * the key list was ever consulted.
 *
 * The lesson is in the name: a gate that enumerates the SUBJECT will keep
 * missing carriers, because a fact travels on whatever event happens to know
 * it. Add an event type here the moment its metadata can hold one.
 *
 * Ordinary metadata on these events is untouched either way -
 * `history.deleted` keeps `fromMessageId`, its anchors and its counts, exactly
 * as every pre-`1.7` peer has always received them.
 */
const INTERVIEW_METADATA_CHAT_EVENT_TYPES: ReadonlyArray<string> = [
  "interview.requested",
  "interview.resolved",
  "interview.errored",
  "history.deleted",
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
  if (!INTERVIEW_METADATA_CHAT_EVENT_TYPES.includes(event.type)) return event;
  const metadata = event.metadata;
  if (!isRecord(metadata)) return event;

  const structuredKeys = INTERVIEW_STRUCTURED_METADATA_KEYS.filter((key) =>
    Object.hasOwn(metadata, key),
  );
  const answerKeys = INTERVIEW_ANSWER_METADATA_KEYS.filter((key) =>
    Array.isArray(metadata[key]),
  );
  if (structuredKeys.length === 0 && answerKeys.length === 0) return event;

  const projectedMetadata: Record<string, unknown> = { ...metadata };
  for (const key of structuredKeys) {
    delete projectedMetadata[key];
  }
  for (const key of answerKeys) {
    projectedMetadata[key] = stripAnswerSelection(metadata[key]);
  }
  return { ...event, metadata: projectedMetadata };
}

/**
 * The inbound mirror of `projectChatEvent`: neutralize the `1.7`-only
 * interview metadata on ONE durable chat event received on a pre-`1.7` line.
 *
 * Deliberately NOT stated as "parsed with the live union", because on the
 * carrier this pass exists for it never is. `chatEventSchema.metadata` is
 * `record(string, unknown)`, so even a deep parse leaves these values opaque -
 * and on the `1.6` snapshot route the events are `z.custom` and not parsed at
 * all. This helper is the only thing between that metadata and a consumer,
 * which is why it validates the shapes it walks rather than trusting them.
 *
 * Deliberately adjacent to the projector, gated on the same event types and
 * the same enumerated keys. The event log reaches a subscriber through two
 * frames - a `snapshot`'s `chat.events` and `eventAppended` - and both call
 * this, so the projector's own claim ("selection evidence reaches a `1.4`-`1.6`
 * peer through `snapshot.chat.events` and `eventAppended` unless it is
 * stripped here") is now true in both directions.
 *
 * The settlement and delivery keys are DELETED, where the typed fields this
 * pass touches take their live neutral default instead (`null`, `[]` or `{}`,
 * per field). The difference is the carrier, not the intent: `metadata` is an
 * open record, so no consumer type promises those keys and ABSENT is exactly
 * the state a conforming pre-`1.7` peer produces - the same state
 * `projectChatEvent` hands one. A block or frame field, by contrast, is
 * declared present on the live type, so "unstated" there has to be spelled
 * with a value.
 *
 * `selection` inside `metadata.answers` is NULLED rather than deleted, and
 * that is deliberate canonicalization rather than a default this parse
 * supplies. `chatEventSchema.metadata` is `record(string, unknown)`, so those
 * answers never pass through `runtimeInterviewAnswerSchema` and a projected
 * legacy event leaves `selection` absent, not null. Null is chosen because it
 * is the one value the live answer schema calls "no evidence" wherever an
 * answer IS parsed, so every reader sees the same neutral whichever carrier it
 * came from. No consumer distinguishes absent from null here today; if one
 * ever must, delete it and this comment is the reason to revisit.
 *
 * Mutates in place, matching the rest of the receive-side passes. The
 * projector rebuilds because it must not touch the host's own frame; a
 * received frame is this client's alone.
 */
function neutralizeChatEventInterviewMetadata(event: unknown): void {
  if (!isRecord(event)) return;
  if (typeof event.type !== "string") return;
  if (!INTERVIEW_METADATA_CHAT_EVENT_TYPES.includes(event.type)) return;
  const metadata = event.metadata;
  if (!isRecord(metadata)) return;
  for (const key of INTERVIEW_STRUCTURED_METADATA_KEYS) {
    delete metadata[key];
  }
  for (const key of INTERVIEW_ANSWER_METADATA_KEYS) {
    neutralizeAnswerSelection(metadata[key]);
  }
}

const CHAT_SUBSCRIBE_V18_MINOR = 8;

function supportsV18(negotiated: SchemaVersion | null): boolean {
  return (
    negotiated !== null &&
    negotiated.major === 1 &&
    negotiated.minor >= CHAT_SUBSCRIBE_V18_MINOR
  );
}

const CHAT_IMPORTED_EVENT_TYPE = "chat.imported";

function isImportedChatEvent(event: unknown): boolean {
  return isRecord(event) && event.type === CHAT_IMPORTED_EVENT_TYPE;
}

/**
 * Withhold `chat.imported` from every pre-`1.8` peer.
 *
 * An `eventAppended` carrying it THROWS - the host's send path catches and
 * drops the frame, the same drop `interviewDeliveryRetry` takes - because
 * there is no older shape to project it onto. A snapshot instead filters the
 * event out of the durable log, since the snapshot itself must still land.
 */
function projectPreImportedFrame(
  frame: ProjectedChatSubscribeServerFrame,
  negotiated: SchemaVersion | null,
): ProjectedChatSubscribeServerFrame {
  if (supportsV18(negotiated)) return frame;
  if (frame.kind === "eventAppended") {
    if (isImportedChatEvent(frame.event)) {
      throw new Error(
        "chat.imported event requires chat.subscribe@1.8 or newer",
      );
    }
    return frame;
  }
  if (frame.kind !== "snapshot") return frame;
  const snapshot = frame.snapshot;
  if (!isRecord(snapshot)) return frame;
  const chat = snapshot.chat;
  if (!isRecord(chat)) return frame;
  const events = chat.events;
  if (!Array.isArray(events)) return frame;
  if (!events.some(isImportedChatEvent)) return frame;
  return {
    ...frame,
    snapshot: {
      ...snapshot,
      chat: {
        ...chat,
        events: events.filter((event) => !isImportedChatEvent(event)),
      },
    },
  };
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
