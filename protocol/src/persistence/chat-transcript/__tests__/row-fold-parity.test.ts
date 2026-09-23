import { describe, expect, it } from "vitest";
import {
  chatEventSchema,
  type ChatEvent,
} from "@traycer/protocol/persistence/epic/chat-events";
import {
  messageSchema,
  type Message,
} from "@traycer/protocol/persistence/epic/messages";
import type { ChatSessionAnchor } from "@traycer/protocol/persistence/epic/senders";
import {
  foldTranscriptRows,
  projectTranscriptRows,
  turnKeysWithLaterOverlappingChanges,
} from "@traycer/protocol/persistence/chat-transcript/row-projection";
import {
  checkpointChangePaths,
  overlappingCheckpointIds,
  overlappingCheckpointKeys,
  type TurnCheckpointManifest,
} from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import {
  buildRowSkeleton,
  transcriptPreviewProjection,
} from "@traycer/protocol/persistence/chat-transcript/build-skeleton";
import {
  compareTranscriptRowOrder,
  encodeTranscriptRowOrder,
  EMPTY_TRANSCRIPT_FOLD_STATE,
  TRANSCRIPT_FOLD_STATE_VERSION,
  TRANSCRIPT_MESSAGE_FOLD_FACTS_VERSION,
  turnRowUnitKey,
  type TranscriptFoldChange,
  type TranscriptFoldLoad,
  type TranscriptFoldLoadResult,
  type TranscriptFoldState,
} from "@traycer/protocol/persistence/chat-transcript/row-projection-fold-state";
import {
  RowFoldStore,
  type ApplyResult,
  type RowFoldChangeInput,
} from "./support/row-fold-store";
import { legacyProjectTranscriptRows } from "./support/legacy-row-projection-oracle";

/**
 * Seeded, deterministic parity fuzz between the incremental fold
 * (`foldTranscriptRows`, driven through {@link RowFoldStore}) and the legacy
 * whole-history projection (the frozen oracle). Every op checks the store's
 * rows and skeleton against fresh oracle/`buildRowSkeleton`/
 * `projectTranscriptRows` runs over the SAME live records, and asserts the
 * increment declined only where the contract says it may.
 */

// ---------------------------------------------------------------------------
// Deterministic RNG
// ---------------------------------------------------------------------------

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)];
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

let globalIdSeq = 0;
function freshId(prefix: string): string {
  globalIdSeq += 1;
  return `${prefix}${globalIdSeq}`;
}

function anchor(profileId: string): ChatSessionAnchor {
  return {
    harnessId: "claude",
    hostId: "host-1",
    sessionId: `session-${profileId}`,
    sessionWorkspaceSnapshot: {
      workspaceKind: "session-snapshot",
      primaryWorkspace: "/repo",
      secondaryWorkspaces: [],
    },
    claudeMessageUuid: "claude-msg-1",
    turnTailUuid: null,
    createdAt: 1000,
    coveredUntilMessageId: null,
    profileId,
    labelSnapshot: profileId,
    accountUuid: null,
    accentColor: null,
  };
}

const ANCHORS: readonly (ChatSessionAnchor | null)[] = [
  null,
  anchor("a"),
  anchor("b"),
];

function userMessage(
  id: string,
  ts: number,
  sessionAnchor: ChatSessionAnchor | null,
): Message {
  return messageSchema.parse({
    role: "user",
    messageId: id,
    sender: { type: "user", userId: "u-1" },
    message: { kind: "user", content: { type: "doc" } },
    timestamp: ts,
    sessionAnchor,
  });
}

function textBlock(ts: number): unknown {
  return {
    blockId: freshId("blk"),
    status: "completed",
    timestamp: ts,
    type: "text",
    text: "hi",
    providerNotice: null,
  };
}

function autonomousResumeBlock(ts: number): unknown {
  return {
    blockId: freshId("blk"),
    status: "completed",
    timestamp: ts,
    type: "autonomous_resume",
    deliveryPlacement: null,
    triggers: [],
    wakeTriggers: [],
  };
}

function steerBlock(
  ts: number,
  queueItemId: string,
  messageId: string,
  mode: "safe_point" | "interrupt_restart",
): unknown {
  return {
    blockId: freshId("blk"),
    status: "completed",
    timestamp: ts,
    type: "steer",
    queueItemId,
    messageId,
    content: { type: "doc" },
    mode,
    sender: null,
  };
}

interface AssistantOpts {
  readonly turnProfile: boolean;
  readonly startedAt: number | null;
}

function assistantMessage(
  id: string,
  turnId: string | null,
  ts: number,
  blocks: readonly unknown[],
  opts: AssistantOpts,
): Message {
  return messageSchema.parse({
    role: "assistant",
    messageId: id,
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "agent-1",
      displayName: null,
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks,
    startedAt: opts.startedAt,
    timestamp: ts,
    turnId,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    imageResolutions: [],
    ...(opts.turnProfile
      ? { turnProfile: { profileId: "p", labelSnapshot: "P" } }
      : {}),
  });
}

interface EventFields {
  readonly id: string | null;
  readonly type: string;
  readonly ts: number;
  readonly turnId: string | null;
  readonly messageId: string | null;
  readonly queueItemId: string | null;
  readonly approvalId: string | null;
  readonly blockId: string | null;
  readonly metadata: Readonly<Record<string, unknown>> | null;
  readonly message: string | null;
}

const EVENT_DEFAULTS: EventFields = {
  id: null,
  type: "",
  ts: 0,
  turnId: null,
  messageId: null,
  queueItemId: null,
  approvalId: null,
  blockId: null,
  metadata: null,
  message: null,
};

function ev(fields: EventFields): ChatEvent {
  return chatEventSchema.parse({
    eventId: fields.id ?? freshId("ev"),
    type: fields.type,
    timestamp: fields.ts,
    clientActionId: null,
    actor: null,
    message: fields.message,
    turnId: fields.turnId,
    messageId: fields.messageId,
    queueItemId: fields.queueItemId,
    approvalId: fields.approvalId,
    blockId: fields.blockId,
    severity: "info",
    metadata: fields.metadata,
  });
}

function promptQueueItem(fields: {
  readonly queueItemId: string;
  readonly messageId: string;
  readonly ts: number;
  readonly status: string;
  readonly steerRequest: {
    readonly mode: "safe_point" | "interrupt_restart";
    readonly targetTurnId: string;
    readonly requestedAt: number;
  } | null;
}): Readonly<Record<string, unknown>> {
  return {
    kind: "prompt",
    queueItemId: fields.queueItemId,
    messageId: fields.messageId,
    message: { kind: "user", content: { type: "doc", content: [] } },
    sender: { type: "user", userId: "u-1" },
    settings: {
      harnessId: "codex",
      model: "gpt-5-codex",
      permissionMode: "supervised",
      reasoningEffort: null,
      agentMode: "epic",
    },
    status: fields.status,
    targetTurnId:
      fields.steerRequest === null ? null : fields.steerRequest.targetTurnId,
    steerRequest: fields.steerRequest,
    fallbackReason: null,
    createdAt: fields.ts,
    updatedAt: fields.ts,
  };
}

/** A `queue.steerRequested` event carrying a durable interrupt-restart request. */
function steerRequestedEvent(
  ts: number,
  turnId: string,
  queueItemId: string,
  messageId: string,
): ChatEvent {
  return ev({
    ...EVENT_DEFAULTS,
    type: "queue.steerRequested",
    ts,
    turnId,
    messageId,
    queueItemId,
    metadata: {
      items: [
        promptQueueItem({
          queueItemId,
          messageId,
          ts,
          status: "steer_requested",
          steerRequest: {
            mode: "interrupt_restart",
            targetTurnId: turnId,
            requestedAt: ts,
          },
        }),
      ],
    },
  });
}

type SteerRetractionType =
  | "queue.fallback"
  | "queue.resumed"
  | "queue.cancelled"
  | "queue.steerAborted";

/** Retracts a steer by naming the messageId directly. */
function steerRetractByMessage(
  type: SteerRetractionType,
  ts: number,
  messageId: string,
): ChatEvent {
  return ev({ ...EVENT_DEFAULTS, type, ts, messageId });
}

/** Retracts a steer by naming the queueItemId directly. */
function steerRetractByQueueItem(
  type: SteerRetractionType,
  ts: number,
  queueItemId: string,
): ChatEvent {
  return ev({ ...EVENT_DEFAULTS, type, ts, queueItemId });
}

/** Retracts a steer via an `items` snapshot in which the item no longer holds an active steer. */
function steerRetractBySnapshot(
  type: SteerRetractionType,
  ts: number,
  queueItemId: string,
  messageId: string,
): ChatEvent {
  return ev({
    ...EVENT_DEFAULTS,
    type,
    ts,
    metadata: {
      items: [
        promptQueueItem({
          queueItemId,
          messageId,
          ts,
          status: "pending",
          steerRequest: null,
        }),
      ],
    },
  });
}

function checkpointEvent(fields: {
  readonly ts: number;
  readonly turnId: string;
  readonly checkpointId: string;
  readonly entries: readonly {
    readonly filePath: string;
    readonly beforeHash: string;
    readonly afterHash: string;
  }[];
}): ChatEvent {
  return ev({
    ...EVENT_DEFAULTS,
    type: "checkpoint.captured",
    ts: fields.ts,
    turnId: fields.turnId,
    metadata: {
      schemaVersion: 1,
      checkpointId: fields.checkpointId,
      capturingUserId: "u-1",
      capturingHostId: "h-1",
      allowedRoots: ["/w"],
      workingDirectory: "/w",
      capturedAt: fields.ts,
      entries: fields.entries.map((entry) => ({
        filePath: entry.filePath,
        operation: "edit" as const,
        beforeHash: entry.beforeHash,
        afterHash: entry.afterHash,
        undoable: true,
        reason: null,
        artifact: null,
      })),
    },
  });
}

type SetupEventType =
  | "setup.creating"
  | "setup.running"
  | "setup.succeeded"
  | "setup.failed"
  | "setup.cancelled"
  | "worktree.missing";

function setupEvent(
  type: SetupEventType,
  ts: number,
  workspacePath: string,
  triggeringMessageId: string | null,
): ChatEvent {
  return ev({
    ...EVENT_DEFAULTS,
    type,
    ts,
    metadata: { workspacePath, triggeringMessageId },
  });
}

function pauseOpenEvent(
  type: "approval.requested" | "interview.requested",
  ts: number,
  turnId: string,
  correlation: {
    readonly approvalId: string | null;
    readonly blockId: string | null;
  },
): ChatEvent {
  return ev({
    ...EVENT_DEFAULTS,
    type,
    ts,
    turnId,
    approvalId: correlation.approvalId,
    blockId: correlation.blockId,
  });
}

function pauseCloseEvent(
  type:
    | "approval.resolved"
    | "approval.denied"
    | "approval.abandoned"
    | "interview.resolved"
    | "interview.errored",
  ts: number,
  turnId: string | null,
  correlation: {
    readonly approvalId: string | null;
    readonly blockId: string | null;
  },
): ChatEvent {
  return ev({
    ...EVENT_DEFAULTS,
    type,
    ts,
    turnId,
    approvalId: correlation.approvalId,
    blockId: correlation.blockId,
  });
}

function turnEvent(
  type: "turn.started" | "turn.completed" | "turn.stopped" | "turn.interrupted",
  ts: number,
  turnId: string,
  messageId: string | null,
): ChatEvent {
  return ev({ ...EVENT_DEFAULTS, type, ts, turnId, messageId });
}

// ---------------------------------------------------------------------------
// Parity assertions
// ---------------------------------------------------------------------------

function roundtrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertRowParity(store: RowFoldStore, label: string): void {
  const input = store.projectionInput();

  const storeRows = roundtrip(store.rowsSorted());
  const oracleRows = roundtrip(legacyProjectTranscriptRows(input));
  expect(storeRows, `${label}: rows vs legacy oracle`).toEqual(oracleRows);

  const projectedRows = roundtrip(projectTranscriptRows(input));
  expect(
    projectedRows,
    `${label}: projectTranscriptRows vs legacy oracle`,
  ).toEqual(oracleRows);

  const storeSkeleton = roundtrip(store.skeletonSorted());
  const freshSkeleton = roundtrip(
    buildRowSkeleton(input, transcriptPreviewProjection, null),
  );
  expect(storeSkeleton, `${label}: skeleton vs buildRowSkeleton`).toEqual(
    freshSkeleton,
  );

  const orders = store.allOrders();
  const encoded = orders.map(encodeTranscriptRowOrder);
  expect(new Set(encoded).size, `${label}: order keys unique`).toBe(
    encoded.length,
  );
  const byComparator = [...orders]
    .sort(compareTranscriptRowOrder)
    .map(encodeTranscriptRowOrder);
  const byEncodedString = [...encoded].sort();
  expect(
    byEncodedString,
    `${label}: order key sort matches comparator sort`,
  ).toEqual(byComparator);
}

interface StepOptions {
  readonly mayDecline: boolean;
}

function applyStep(
  store: RowFoldStore,
  change: RowFoldChangeInput,
  options: StepOptions,
  label: string,
) {
  const result = store.apply(change);
  if (!result.continued) {
    expect(
      options.mayDecline,
      `${label}: unexpected decline (${result.reason})`,
    ).toBe(true);
  }
  assertRowParity(store, label);
  return result;
}

function emptyChange(activeTurnId: string | null): RowFoldChangeInput {
  return { upserts: [], removes: [], events: [], activeTurnId };
}

// ---------------------------------------------------------------------------
// The randomized fuzz engine (scenario families a-f)
// ---------------------------------------------------------------------------

interface Features {
  readonly steerBlocks: boolean;
  readonly interruptRestart: boolean;
  readonly historyEdits: boolean;
  readonly pauseEvents: boolean;
  readonly checkpoints: boolean;
  /**
   * Swaps the checkpoint branch's simple one-entry/one-path emitter for
   * {@link checkpointHeavyOp}'s wider mix (P1): 1-4 entries over a 5-path
   * pool, no-ops, non-undoable null/null entries, unparseable/null metadata,
   * `turnId: null` checkpoints, and deliberate superseding-manifest overlap
   * shapes. Requires `checkpoints: true`.
   */
  readonly checkpointHeavy: boolean;
  readonly setupCards: boolean;
  readonly legacyRecords: boolean;
  readonly activeTurnFlips: boolean;
}

const LIVE_CHAT_FEATURES: Features = {
  steerBlocks: true,
  interruptRestart: true,
  historyEdits: false,
  pauseEvents: false,
  checkpoints: false,
  checkpointHeavy: false,
  setupCards: false,
  legacyRecords: false,
  activeTurnFlips: true,
};

const HISTORY_EDIT_FEATURES: Features = {
  ...LIVE_CHAT_FEATURES,
  historyEdits: true,
};

const EVENTS_FEATURES: Features = {
  ...LIVE_CHAT_FEATURES,
  pauseEvents: true,
  checkpoints: true,
  setupCards: true,
};

const LEGACY_FEATURES: Features = {
  ...LIVE_CHAT_FEATURES,
  legacyRecords: true,
  historyEdits: true,
};

const ACTIVE_FLIP_FEATURES: Features = {
  ...EVENTS_FEATURES,
  activeTurnFlips: true,
};

const BATCH_FEATURES: Features = { ...EVENTS_FEATURES, historyEdits: true };

/** P1: the checkpoint-heavy fuzz feature mix. See {@link checkpointHeavyOp}. */
const CHECKPOINT_HEAVY_FEATURES: Features = {
  ...EVENTS_FEATURES,
  checkpointHeavy: true,
};

/** P1: counters the checkpoint-heavy fuzz reports at the end of its run. */
interface CheckpointFuzzStats {
  ops: number;
  supersedes: number;
  subset: number;
  superset: number;
  disjoint: number;
  empty: number;
}

function newCheckpointFuzzStats(): CheckpointFuzzStats {
  return {
    ops: 0,
    supersedes: 0,
    subset: 0,
    superset: 0,
    disjoint: 0,
    empty: 0,
  };
}

interface ChatModel {
  readonly users: string[];
  readonly turns: string[];
  readonly messages: string[];
  clock: number;
  /**
   * P1: each turn's last RETAINED checkpoint's changed paths, as this fuzz
   * model constructed it - used only by {@link checkpointHeavyOp} to build
   * deliberate subset/superset/disjoint/empty superseding relations. Other
   * families never touch it.
   */
  readonly checkpointPaths: Map<string, readonly string[]>;
  readonly checkpointStats: CheckpointFuzzStats;
}

function newModel(): ChatModel {
  return {
    users: [],
    turns: [],
    messages: [],
    clock: 1000,
    checkpointPaths: new Map(),
    checkpointStats: newCheckpointFuzzStats(),
  };
}

// ---------------------------------------------------------------------------
// P1: the checkpoint-heavy manifest mix
// ---------------------------------------------------------------------------

const CHECKPOINT_PATH_POOL: readonly string[] = [
  "/w/a.ts",
  "/w/b.ts",
  "/w/c.ts",
  "/w/d.ts",
  "/w/e.ts",
];

function realCheckpointEntry(filePath: string): unknown {
  return {
    filePath,
    operation: "edit",
    beforeHash: "h0",
    afterHash: freshId("h"),
    undoable: true,
    reason: null,
    artifact: null,
  };
}

/** `undoable: true`, `beforeHash === afterHash` - a genuine no-op entry. */
function noOpCheckpointEntry(filePath: string): unknown {
  return {
    filePath,
    operation: "edit",
    beforeHash: "h-same",
    afterHash: "h-same",
    undoable: true,
    reason: null,
    artifact: null,
  };
}

/**
 * `undoable: false`, `beforeHash === afterHash === null` - a denied/binary
 * edit attempt. Despite the equal (null) hashes this is NOT a no-op per
 * `isNoOpCheckpointEntry`, because `undoable` is false: it counts as a real
 * change.
 */
function nonUndoableNullCheckpointEntry(filePath: string): unknown {
  return {
    filePath,
    operation: "edit",
    beforeHash: null,
    afterHash: null,
    undoable: false,
    reason: "denied",
    artifact: null,
  };
}

/**
 * Builds manifest entries whose changed-path set (per `checkpointChangePaths`)
 * is exactly `targetChangedPaths`. An empty target still produces content - a
 * manifest with entries that all turn out to be no-ops - rather than an empty
 * `entries` array, since that is the shape a real "touched nothing" turn
 * produces.
 */
function checkpointManifestEntriesFor(
  r: () => number,
  targetChangedPaths: readonly string[],
): unknown[] {
  if (targetChangedPaths.length === 0) {
    return [noOpCheckpointEntry(pick(r, CHECKPOINT_PATH_POOL))];
  }
  return targetChangedPaths.map((filePath) =>
    r() < 0.3
      ? nonUndoableNullCheckpointEntry(filePath)
      : realCheckpointEntry(filePath),
  );
}

function checkpointManifestMetadata(
  ts: number,
  checkpointId: string,
  entries: readonly unknown[],
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    checkpointId,
    capturingUserId: "u-1",
    capturingHostId: "h-1",
    allowedRoots: ["/w"],
    workingDirectory: "/w",
    capturedAt: ts,
    entries,
  };
}

/** A `checkpoint.captured` event with metadata supplied verbatim (may be unparseable or null). */
function rawCheckpointEvent(fields: {
  readonly ts: number;
  readonly turnId: string | null;
  readonly metadata: Readonly<Record<string, unknown>> | null;
}): ChatEvent {
  return ev({
    ...EVENT_DEFAULTS,
    type: "checkpoint.captured",
    ts: fields.ts,
    turnId: fields.turnId,
    metadata: fields.metadata,
  });
}

/**
 * P1's op generator: 1-4 entries over the 5-path pool, no-ops, non-undoable
 * null/null entries, unparseable metadata, `metadata: null`, `turnId: null`
 * checkpoints, and - the case the simple one-entry emitter can never hit -
 * a checkpoint SUPERSEDING an existing turn's retained one, with its changed
 * paths deliberately a subset, a superset, disjoint from, or empty relative
 * to the turn's prior retained paths.
 */
function checkpointHeavyOp(
  r: () => number,
  model: ChatModel,
  events: ChatEvent[],
): void {
  model.checkpointStats.ops += 1;
  const roll = r();

  if (roll < 0.1 && model.turns.length > 0) {
    events.push(
      rawCheckpointEvent({
        ts: model.clock,
        turnId: pick(r, model.turns),
        metadata: { schemaVersion: 99, checkpointId: freshId("cp") },
      }),
    );
    return;
  }
  if (roll < 0.2 && model.turns.length > 0) {
    events.push(
      rawCheckpointEvent({
        ts: model.clock,
        turnId: pick(r, model.turns),
        metadata: null,
      }),
    );
    return;
  }
  if (roll < 0.3) {
    const count = 1 + Math.floor(r() * 4);
    const paths = [
      ...new Set(
        Array.from({ length: count }, () => pick(r, CHECKPOINT_PATH_POOL)),
      ),
    ];
    events.push(
      rawCheckpointEvent({
        ts: model.clock,
        turnId: null,
        metadata: checkpointManifestMetadata(
          model.clock,
          freshId("cp"),
          checkpointManifestEntriesFor(r, paths),
        ),
      }),
    );
    return;
  }

  if (model.turns.length === 0) return;
  const turnId = pick(r, model.turns);
  const prior = model.checkpointPaths.get(turnId);
  let targetPaths: string[];
  if (prior !== undefined && r() < 0.6) {
    model.checkpointStats.supersedes += 1;
    const relation = r();
    if (relation < 0.25 && prior.length > 1) {
      targetPaths = [...prior].slice(
        0,
        Math.max(1, Math.floor(prior.length / 2)),
      );
      model.checkpointStats.subset += 1;
    } else if (relation < 0.5) {
      const extra = CHECKPOINT_PATH_POOL.filter((p) => !prior.includes(p));
      targetPaths = extra.length > 0 ? [...prior, pick(r, extra)] : [...prior];
      model.checkpointStats.superset += 1;
    } else if (relation < 0.75) {
      const disjointPool = CHECKPOINT_PATH_POOL.filter(
        (p) => !prior.includes(p),
      );
      targetPaths = disjointPool.length > 0 ? [pick(r, disjointPool)] : [];
      model.checkpointStats.disjoint += 1;
    } else {
      targetPaths = [];
      model.checkpointStats.empty += 1;
    }
  } else {
    // At least 2 distinct paths so a later supersede has room to pick a
    // genuine (non-trivial) subset.
    const uniqueCount = 2 + Math.floor(r() * 3);
    const shuffled = [...CHECKPOINT_PATH_POOL].sort(() => r() - 0.5);
    targetPaths = shuffled.slice(0, Math.min(uniqueCount, shuffled.length));
  }

  const checkpointId = freshId("cp");
  const entries = checkpointManifestEntriesFor(r, targetPaths);
  events.push(
    rawCheckpointEvent({
      ts: model.clock,
      turnId,
      metadata: checkpointManifestMetadata(model.clock, checkpointId, entries),
    }),
  );
  model.checkpointPaths.set(turnId, targetPaths);
}

function blocksFor(
  r: () => number,
  model: ChatModel,
  features: Features,
): unknown[] {
  const kind = r();
  const text = textBlock(model.clock);
  if (kind < 0.1) return [];
  if (kind < 0.25) return [autonomousResumeBlock(model.clock), text];
  if (features.steerBlocks && kind < 0.4 && model.users.length > 0) {
    const targetUser = pick(r, model.users);
    const mode: "safe_point" | "interrupt_restart" =
      features.interruptRestart && r() < 0.5
        ? "interrupt_restart"
        : "safe_point";
    return [text, steerBlock(model.clock, freshId("q"), targetUser, mode)];
  }
  return [text];
}

/** One randomized op, applied and checked. */
function randomOp(
  store: RowFoldStore,
  model: ChatModel,
  r: () => number,
  features: Features,
  label: string,
): ApplyResult {
  model.clock += Math.floor(r() * 5);
  const x = r();
  const upserts: Message[] = [];
  const removes: string[] = [];
  const events: ChatEvent[] = [];
  let activeTurnId: string | null = null;

  if (x < 0.22) {
    const id = freshId("m");
    upserts.push(userMessage(id, model.clock, pick(r, ANCHORS)));
    model.users.push(id);
    model.messages.push(id);
  } else if (x < 0.5) {
    let turnId: string;
    const startedAt = features.legacyRecords && r() < 0.2 ? null : model.clock;
    if (model.turns.length === 0 || r() < 0.4) {
      turnId = freshId("t");
      model.turns.push(turnId);
      if (r() < 0.5)
        events.push(turnEvent("turn.started", model.clock, turnId, null));
    } else {
      turnId =
        r() < 0.8 ? model.turns[model.turns.length - 1] : pick(r, model.turns);
    }
    const blocks = blocksFor(r, model, features);
    const id = freshId("m");
    upserts.push(
      assistantMessage(
        id,
        features.legacyRecords && r() < 0.15 ? null : turnId,
        model.clock,
        blocks,
        {
          turnProfile: r() < 0.15,
          startedAt,
        },
      ),
    );
    model.messages.push(id);
    if (r() < 0.3) activeTurnId = turnId;
  } else if (features.historyEdits && x < 0.6) {
    // Rewrite an existing user's session anchor (a fallback hop).
    if (model.users.length > 0) {
      const id = pick(r, model.users);
      upserts.push(userMessage(id, model.clock, pick(r, ANCHORS)));
    }
  } else if (features.historyEdits && x < 0.7) {
    // Rewrite an existing assistant record's blocks (facts change).
    if (model.turns.length > 0) {
      const turnId = pick(r, model.turns);
      const blocks = blocksFor(r, model, features);
      const id = freshId("m");
      upserts.push(
        assistantMessage(id, turnId, model.clock, blocks, {
          turnProfile: r() < 0.2,
          startedAt: model.clock,
        }),
      );
      model.messages.push(id);
    }
  } else if (features.historyEdits && x < 0.8) {
    // Remove one or a few live records, tail-biased, or occasionally re-upsert one.
    if (model.messages.length > 0) {
      const count = r() < 0.3 ? 1 + Math.floor(r() * 3) : 1;
      const tail = r() < 0.7;
      for (let i = 0; i < count; i += 1) {
        const index = tail
          ? model.messages.length - 1 - Math.min(i, model.messages.length - 1)
          : Math.floor(r() * model.messages.length);
        const id = model.messages[index];
        if (id !== undefined) removes.push(id);
      }
    }
  } else if (features.pauseEvents && x < 0.86 && model.turns.length > 0) {
    const turnId = pick(r, model.turns);
    if (r() < 0.5) {
      events.push(
        pauseOpenEvent(
          r() < 0.5 ? "approval.requested" : "interview.requested",
          model.clock,
          turnId,
          {
            approvalId: r() < 0.5 ? freshId("appr") : null,
            blockId: r() < 0.5 ? freshId("blk") : null,
          },
        ),
      );
    } else {
      events.push(
        pauseCloseEvent("approval.resolved", model.clock, turnId, {
          approvalId: freshId("appr-unmatched"),
          blockId: null,
        }),
      );
    }
  } else if (
    features.checkpoints &&
    x < 0.9 &&
    (model.turns.length > 0 || features.checkpointHeavy)
  ) {
    if (features.checkpointHeavy) {
      checkpointHeavyOp(r, model, events);
    } else {
      const turnId = pick(r, model.turns);
      events.push(
        checkpointEvent({
          ts: model.clock,
          turnId,
          checkpointId: freshId("cp"),
          entries: [
            {
              filePath: pick(r, ["/w/a.ts", "/w/b.ts", "/w/c.ts"]),
              beforeHash: "h0",
              afterHash: "h1",
            },
          ],
        }),
      );
    }
  } else if (features.setupCards && x < 0.94) {
    const triggering =
      model.users.length > 0 && r() < 0.5 ? pick(r, model.users) : null;
    events.push(
      setupEvent(
        pick(r, [
          "setup.creating",
          "setup.running",
          "setup.succeeded",
        ] as const),
        model.clock,
        "/repo",
        triggering,
      ),
    );
  } else if (model.turns.length > 0 && x < 0.97) {
    const turnId = pick(r, model.turns);
    const type = pick(r, [
      "turn.completed",
      "turn.stopped",
      "turn.interrupted",
    ] as const);
    events.push(
      turnEvent(
        type,
        model.clock,
        turnId,
        type === "turn.stopped" && model.users.length > 0
          ? pick(r, model.users)
          : null,
      ),
    );
  } else if (features.activeTurnFlips) {
    activeTurnId =
      model.turns.length > 0 && r() < 0.5 ? pick(r, model.turns) : null;
  }

  return applyStep(
    store,
    { upserts, removes, events, activeTurnId },
    { mayDecline: false },
    label,
  );
}

function runFuzzedFamily(
  name: string,
  features: Features,
  seeds: number,
  ops: number,
): void {
  describe(`fuzz family: ${name}`, () => {
    for (let seed = 1; seed <= seeds; seed += 1) {
      it(`seed ${seed}`, () => {
        const store = new RowFoldStore(`chat-${name}-${seed}`);
        const model = newModel();
        const r = rng(seed * 7919 + name.length);
        for (let op = 0; op < ops; op += 1) {
          randomOp(store, model, r, features, `${name} seed ${seed} op ${op}`);
        }
        expect(
          store.declines,
          `${name} seed ${seed}: unexpected declines`,
        ).toEqual([]);
      });
    }
  });
}

runFuzzedFamily("a-live-chat", LIVE_CHAT_FEATURES, 8, 50);
runFuzzedFamily("b-history-edits", HISTORY_EDIT_FEATURES, 8, 50);
runFuzzedFamily("c-events", EVENTS_FEATURES, 8, 50);
runFuzzedFamily("d-legacy-scattered", LEGACY_FEATURES, 6, 40);
runFuzzedFamily("e-active-turn-flips", ACTIVE_FLIP_FEATURES, 6, 40);
runFuzzedFamily("f-batches", BATCH_FEATURES, 6, 40);

// ---------------------------------------------------------------------------
// P1/P2: the checkpoint-heavy fuzz. `checkpointHeavyOp` supplies the ops;
// these two checks run on top of every op alongside the usual row/skeleton
// parity `applyStep` already asserts inside `randomOp`.
// ---------------------------------------------------------------------------

/**
 * P1's independent check: straight off `store.rowsSorted()`, every
 * re-described turn row's `context.hasLaterOverlappingChanges` must equal
 * what the pure whole-history rule computes from the SAME event log. This is
 * deliberately NOT the same comparison `assertRowParity` already makes
 * (store vs. legacy oracle, which could share a bug) - it triangulates
 * against `turnKeysWithLaterOverlappingChanges` itself.
 */
function assertOverlapMatchesWholeHistoryRule(
  store: RowFoldStore,
  label: string,
): void {
  const expected = turnKeysWithLaterOverlappingChanges(
    store.projectionInput().events,
  );
  for (const row of store.rowsSorted()) {
    const turnKey =
      row.source.kind === "assistant-slice"
        ? row.source.turnKey
        : row.source.kind === "steer"
          ? row.source.turnKey
          : null;
    if (turnKey === null) continue;
    expect(
      Boolean(row.context.hasLaterOverlappingChanges),
      `${label}: row ${row.rowId} (turn ${turnKey}) hasLaterOverlappingChanges`,
    ).toBe(expected.has(turnKey));
  }
}

/**
 * P2's mechanism checks over one op's loads: the fold never falls back to
 * loading every `checkpoint.captured` event, and neither checkpoint load
 * answers with more rows than the keys it was asked about.
 */
function assertCheckpointLoadMechanism(
  result: ApplyResult,
  label: string,
): void {
  for (const load of result.loads) {
    if (load.kind === "events-by-type") {
      expect(
        load.types?.includes("checkpoint.captured") ?? false,
        `${label}: an events-by-type load named checkpoint.captured`,
      ).toBe(false);
    }
    if (
      load.kind === "checkpoint-turns" ||
      load.kind === "checkpoint-last-changes"
    ) {
      expect(
        load.resultCount,
        `${label}: ${load.kind} answered with more rows than requested`,
      ).toBeLessThanOrEqual(load.requestedCount ?? Infinity);
    }
  }
}

describe("P1/P2: checkpoint-heavy fuzz", () => {
  const SEEDS = 8;
  const OPS = 500;
  const totals = newCheckpointFuzzStats();

  for (let seed = 1; seed <= SEEDS; seed += 1) {
    it(`seed ${seed}`, () => {
      const store = new RowFoldStore(`chat-checkpoint-heavy-${seed}`);
      const model = newModel();
      const r = rng(seed * 7919 + "checkpoint-heavy".length);
      for (let op = 0; op < OPS; op += 1) {
        const label = `checkpoint-heavy seed ${seed} op ${op}`;
        const result = randomOp(
          store,
          model,
          r,
          CHECKPOINT_HEAVY_FEATURES,
          label,
        );
        assertOverlapMatchesWholeHistoryRule(store, label);
        assertCheckpointLoadMechanism(result, label);
      }
      expect(
        store.declines,
        `checkpoint-heavy seed ${seed}: unexpected declines`,
      ).toEqual([]);
      totals.ops += model.checkpointStats.ops;
      totals.supersedes += model.checkpointStats.supersedes;
      totals.subset += model.checkpointStats.subset;
      totals.superset += model.checkpointStats.superset;
      totals.disjoint += model.checkpointStats.disjoint;
      totals.empty += model.checkpointStats.empty;
    });
  }

  it("covered a real mix of checkpoint ops, supersedes and path-set relations", () => {
    // Runs after the seeds above (vitest runs one describe's `it`s in
    // declaration order), so `totals` is fully accumulated here.
    expect(totals.ops, "checkpoint ops").toBeGreaterThan(50);
    expect(totals.supersedes, "superseding manifests").toBeGreaterThan(3);
    expect(totals.subset, "subset relations").toBeGreaterThan(0);
    expect(totals.superset, "superset relations").toBeGreaterThan(0);
    expect(totals.disjoint, "disjoint relations").toBeGreaterThan(0);
    expect(totals.empty, "empty relations").toBeGreaterThan(0);
    console.info(
      `P1 checkpoint-heavy fuzz coverage: ops=${totals.ops} ` +
        `supersedes=${totals.supersedes} subset=${totals.subset} ` +
        `superset=${totals.superset} disjoint=${totals.disjoint} ` +
        `empty=${totals.empty}`,
    );
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// P3: overlappingCheckpointKeys — subset sufficiency (property test)
// ---------------------------------------------------------------------------

describe("P3: overlappingCheckpointKeys — subset sufficiency", () => {
  it("the answer for S, computed from S plus the last changer of each of S's paths (in true order), equals the whole-list answer restricted to S", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const r = rng(seed * 104729 + 17);
      const n = 3 + Math.floor(r() * 12); // 3-14 checkpoints
      const checkpoints = Array.from({ length: n }, (_unused, index) => ({
        key: `cp${index}`,
        paths: Array.from({ length: 1 + Math.floor(r() * 3) }, () =>
          pick(r, CHECKPOINT_PATH_POOL),
        ),
      }));
      const whole = overlappingCheckpointKeys(checkpoints);

      const sSize = 1 + Math.floor(r() * n);
      const sIndices = new Set<number>();
      while (sIndices.size < sSize) sIndices.add(Math.floor(r() * n));
      const sKeys = new Set(
        [...sIndices].map((index) => checkpoints[index].key),
      );
      const sPaths = new Set<string>();
      for (const index of sIndices) {
        for (const path of checkpoints[index].paths) sPaths.add(path);
      }

      // The last changer of each of S's paths, over the WHOLE list, in true
      // (index) order - exactly what a store limited to S can afford to load.
      const lastChangerIndexByPath = new Map<string, number>();
      checkpoints.forEach((checkpoint, index) => {
        for (const path of checkpoint.paths) {
          if (sPaths.has(path)) lastChangerIndexByPath.set(path, index);
        }
      });
      const subsetIndices = new Set<number>([
        ...sIndices,
        ...lastChangerIndexByPath.values(),
      ]);
      const orderedSubsetIndices = [...subsetIndices].sort((a, b) => a - b);
      const subsetAnswer = overlappingCheckpointKeys(
        orderedSubsetIndices.map((index) => checkpoints[index]),
      );

      const wholeRestrictedToS = new Set(
        [...whole].filter((key) => sKeys.has(key)),
      );
      const subsetAnswerRestrictedToS = new Set(
        [...subsetAnswer].filter((key) => sKeys.has(key)),
      );
      expect(
        subsetAnswerRestrictedToS,
        `seed ${seed}: |S|=${String(sSize)} of ${String(n)}`,
      ).toEqual(wholeRestrictedToS);
    }
  });
});

// ---------------------------------------------------------------------------
// P4: the tightening — turn-keyed overlap distinguishes what a shared
// checkpoint id could not.
// ---------------------------------------------------------------------------

function turnCheckpointManifest(
  checkpointId: string,
  paths: readonly string[],
): TurnCheckpointManifest {
  return {
    schemaVersion: 1,
    checkpointId,
    capturingUserId: "u-1",
    capturingHostId: "h-1",
    allowedRoots: ["/w"],
    workingDirectory: "/w",
    capturedAt: 1000,
    entries: paths.map((filePath) => ({
      filePath,
      operation: "edit" as const,
      beforeHash: "h0",
      afterHash: "h1",
      undoable: true,
      reason: null,
      artifact: null,
    })),
  };
}

describe("P4: the tightening", () => {
  it("two turns whose retained checkpoints share one checkpoint id, where only one overlaps: turnKeysWithLaterOverlappingChanges flags only that turn, but overlappingCheckpointIds still merges them under the shared id", () => {
    // t1 and t2 each retain a checkpoint under the SAME checkpointId
    // ("shared"), touching disjoint paths. A later checkpoint on t3 touches
    // only t1's path.
    const events: ChatEvent[] = [
      checkpointEvent({
        ts: 1000,
        turnId: "t1",
        checkpointId: "shared",
        entries: [{ filePath: "/w/a.ts", beforeHash: "h0", afterHash: "h1" }],
      }),
      checkpointEvent({
        ts: 1001,
        turnId: "t2",
        checkpointId: "shared",
        entries: [{ filePath: "/w/b.ts", beforeHash: "h0", afterHash: "h1" }],
      }),
      checkpointEvent({
        ts: 1002,
        turnId: "t3",
        checkpointId: "c3",
        entries: [{ filePath: "/w/a.ts", beforeHash: "h1", afterHash: "h2" }],
      }),
    ];

    // The NEW behaviour: keyed by turn, only t1 (whose path a.ts is touched
    // by t3's later checkpoint) is flagged - t2's path b.ts is never touched
    // again.
    expect(turnKeysWithLaterOverlappingChanges(events)).toEqual(
      new Set(["t1"]),
    );

    // The OLD behaviour, unchanged: keyed by checkpoint id, t1's and t2's
    // manifests collapse under the one shared id, so the id is reported
    // overlapping even though only t1's own retained checkpoint actually is.
    const manifests: TurnCheckpointManifest[] = [
      turnCheckpointManifest("shared", ["/w/a.ts"]),
      turnCheckpointManifest("shared", ["/w/b.ts"]),
      turnCheckpointManifest("c3", ["/w/a.ts"]),
    ];
    expect(overlappingCheckpointIds(manifests)).toEqual(new Set(["shared"]));
    expect(checkpointChangePaths(manifests[0])).toEqual(["/w/a.ts"]);
  });
});

// ---------------------------------------------------------------------------
// P5: fold state version guard
// ---------------------------------------------------------------------------

describe("P5: fold state version guard", () => {
  it("a fold state written by another version declines rather than crashing or misreading it", () => {
    const staleState: TranscriptFoldState = {
      ...EMPTY_TRANSCRIPT_FOLD_STATE,
      version: EMPTY_TRANSCRIPT_FOLD_STATE.version + 1,
    };
    const steps = foldTranscriptRows(staleState, {
      chatId: "chat-stale-version",
      activeTurnId: null,
      upsertedMessages: [],
      removedMessages: [],
      appendedEvents: [],
    });
    const step = steps.next();
    expect(step.done, "declines immediately, before yielding any load").toBe(
      true,
    );
    const result = step.value;
    if (result.continued) {
      throw new Error("expected the fold to decline on a version mismatch");
    }
    expect(result.reason).toBe("fold state written by another version");
  });
});

// b. History edits: explicit scenarios the fuzzer cannot reliably hit
// ---------------------------------------------------------------------------

describe("b. history edits: explicit scenarios", () => {
  it("removes a tail range (checkpoint restore), then re-upserts one removed id at a NEW position", () => {
    const store = new RowFoldStore("chat-tail-remove");
    const u1 = userMessage("u1", 1000, null);
    const a1 = assistantMessage("a1", "t1", 1001, [textBlock(1001)], {
      turnProfile: false,
      startedAt: 1001,
    });
    const u2 = userMessage("u2", 1002, null);
    const a2 = assistantMessage("a2", "t2", 1003, [textBlock(1003)], {
      turnProfile: false,
      startedAt: 1003,
    });
    applyStep(
      store,
      {
        upserts: [u1, a1, u2, a2],
        removes: [],
        events: [],
        activeTurnId: null,
      },
      { mayDecline: false },
      "seed",
    );
    applyStep(
      store,
      { upserts: [], removes: ["u2", "a2"], events: [], activeTurnId: null },
      { mayDecline: false },
      "remove tail",
    );
    const reinserted = userMessage("u2", 1002, null);
    applyStep(
      store,
      { upserts: [reinserted], removes: [], events: [], activeTurnId: null },
      { mayDecline: false },
      "reinsert removed id",
    );
  });

  it("removes middle records", () => {
    const store = new RowFoldStore("chat-middle-remove");
    const msgs = [
      userMessage("u1", 1000, null),
      assistantMessage("a1", "t1", 1001, [textBlock(1001)], {
        turnProfile: false,
        startedAt: 1001,
      }),
      userMessage("u2", 1002, null),
      assistantMessage("a2", "t2", 1003, [textBlock(1003)], {
        turnProfile: false,
        startedAt: 1003,
      }),
      userMessage("u3", 1004, null),
      assistantMessage("a3", "t3", 1005, [textBlock(1005)], {
        turnProfile: false,
        startedAt: 1005,
      }),
    ];
    applyStep(
      store,
      { upserts: msgs, removes: [], events: [], activeTurnId: null },
      { mayDecline: false },
      "seed",
    );
    applyStep(
      store,
      { upserts: [], removes: ["u2", "a2"], events: [], activeTurnId: null },
      { mayDecline: false },
      "remove middle",
    );
  });

  it("rewrites an old user's sessionAnchor (fallback hop)", () => {
    const store = new RowFoldStore("chat-fallback-hop");
    const users = Array.from({ length: 5 }, (_, i) =>
      userMessage(`u${i}`, 1000 + i, anchor("original")),
    );
    applyStep(
      store,
      { upserts: users, removes: [], events: [], activeTurnId: null },
      { mayDecline: false },
      "seed",
    );
    const rewritten = userMessage("u0", 1000, anchor("hopped"));
    applyStep(
      store,
      { upserts: [rewritten], removes: [], events: [], activeTurnId: null },
      { mayDecline: false },
      "fallback hop",
    );
  });

  it("rewrites old assistant blocks so facts change (add/remove steer targets, autonomous toggle, turnProfile added)", () => {
    const store = new RowFoldStore("chat-facts-rewrite");
    const u1 = userMessage("u1", 1000, null);
    const a1 = assistantMessage("a1", "t1", 1001, [textBlock(1001)], {
      turnProfile: false,
      startedAt: 1001,
    });
    applyStep(
      store,
      { upserts: [u1, a1], removes: [], events: [], activeTurnId: null },
      { mayDecline: false },
      "seed",
    );

    const addSteer = assistantMessage(
      "a1",
      "t1",
      1001,
      [textBlock(1001), steerBlock(1001, "q1", "u1", "safe_point")],
      {
        turnProfile: false,
        startedAt: 1001,
      },
    );
    applyStep(
      store,
      { upserts: [addSteer], removes: [], events: [], activeTurnId: null },
      { mayDecline: false },
      "add steer target",
    );

    const removeSteer = assistantMessage("a1", "t1", 1001, [textBlock(1001)], {
      turnProfile: false,
      startedAt: 1001,
    });
    applyStep(
      store,
      { upserts: [removeSteer], removes: [], events: [], activeTurnId: null },
      { mayDecline: false },
      "remove steer target",
    );

    const autonomousToggle = assistantMessage(
      "a1",
      "t1",
      1001,
      [autonomousResumeBlock(1001), textBlock(1001)],
      {
        turnProfile: false,
        startedAt: 1001,
      },
    );
    applyStep(
      store,
      {
        upserts: [autonomousToggle],
        removes: [],
        events: [],
        activeTurnId: null,
      },
      { mayDecline: false },
      "autonomous toggle",
    );

    const withProfile = assistantMessage(
      "a1",
      "t1",
      1001,
      [autonomousResumeBlock(1001), textBlock(1001)],
      {
        turnProfile: true,
        startedAt: 1001,
      },
    );
    applyStep(
      store,
      { upserts: [withProfile], removes: [], events: [], activeTurnId: null },
      { mayDecline: false },
      "turnProfile added",
    );
  });

  it("appends a late record to an old turn, and interleaves a turn's records across two user records", () => {
    const store = new RowFoldStore("chat-late-append-split-turn");
    const u1 = userMessage("u1", 1000, null);
    const a1 = assistantMessage("a1", "t1", 1001, [textBlock(1001)], {
      turnProfile: false,
      startedAt: 1001,
    });
    applyStep(
      store,
      { upserts: [u1, a1], removes: [], events: [], activeTurnId: null },
      { mayDecline: false },
      "seed",
    );

    for (let i = 0; i < 30; i += 1) {
      applyStep(
        store,
        {
          upserts: [
            userMessage(`filler-u${i}`, 1002 + i, null),
            assistantMessage(
              `filler-a${i}`,
              `filler-t${i}`,
              1002 + i,
              [textBlock(1002 + i)],
              { turnProfile: false, startedAt: 1002 + i },
            ),
          ],
          removes: [],
          events: [],
          activeTurnId: null,
        },
        { mayDecline: false },
        `filler ${i}`,
      );
    }

    const lateRecord = assistantMessage(
      "a1-late",
      "t1",
      2500,
      [textBlock(2500)],
      { turnProfile: false, startedAt: 1001 },
    );
    applyStep(
      store,
      { upserts: [lateRecord], removes: [], events: [], activeTurnId: null },
      { mayDecline: false },
      "late record on old turn",
    );

    const u2 = userMessage("u2", 1001.5, null);
    applyStep(
      store,
      { upserts: [u2], removes: [], events: [], activeTurnId: null },
      { mayDecline: false },
      "interleaved user",
    );
  });
});

// ---------------------------------------------------------------------------
// c. Events: pause correlation, turn.stopped variants, checkpoint overlap,
//    setup windows, and every row-materializing event kind.
// ---------------------------------------------------------------------------

describe("c. events: pause correlation", () => {
  it("closes a pause open in a LATER change, correlated by approvalId", () => {
    const store = new RowFoldStore("chat-pause-later-close");
    const u1 = userMessage("u1", 1000, null);
    applyStep(
      store,
      { upserts: [u1], removes: [], events: [], activeTurnId: null },
      { mayDecline: false },
      "seed",
    );
    const turnId = "t1";
    applyStep(
      store,
      {
        upserts: [],
        removes: [],
        events: [turnEvent("turn.started", 1001, turnId, null)],
        activeTurnId: turnId,
      },
      { mayDecline: false },
      "turn.started",
    );
    const open = pauseOpenEvent("approval.requested", 1002, turnId, {
      approvalId: "appr-1",
      blockId: null,
    });
    applyStep(
      store,
      { upserts: [], removes: [], events: [open], activeTurnId: turnId },
      { mayDecline: false },
      "pause open",
    );
    applyStep(
      store,
      emptyChange(turnId),
      { mayDecline: false },
      "unrelated change",
    );
    const close = pauseCloseEvent("approval.resolved", 1010, null, {
      approvalId: "appr-1",
      blockId: null,
    });
    applyStep(
      store,
      { upserts: [], removes: [], events: [close], activeTurnId: turnId },
      { mayDecline: false },
      "pause close later",
    );
  });

  it("closes a pause carrying a DIFFERENT turnId than the open - attributed to the OPEN's turn", () => {
    const store = new RowFoldStore("chat-pause-different-turn");
    const turnA = "t-a";
    const turnB = "t-b";
    applyStep(
      store,
      {
        upserts: [],
        removes: [],
        events: [turnEvent("turn.started", 1000, turnA, null)],
        activeTurnId: turnA,
      },
      { mayDecline: false },
      "turn A started",
    );
    const open = pauseOpenEvent("interview.requested", 1001, turnA, {
      approvalId: null,
      blockId: "blk-1",
    });
    applyStep(
      store,
      { upserts: [], removes: [], events: [open], activeTurnId: turnA },
      { mayDecline: false },
      "interview open",
    );
    const close = pauseCloseEvent("interview.resolved", 1005, turnB, {
      approvalId: null,
      blockId: "blk-1",
    });
    applyStep(
      store,
      { upserts: [], removes: [], events: [close], activeTurnId: turnB },
      { mayDecline: false },
      "interview close, different turnId",
    );
  });
});

describe("c. events: turn.stopped variants", () => {
  it("stops a turn with no assistant records (synthesized stopped row), with and without a trigger user", () => {
    const store = new RowFoldStore("chat-stopped-no-records");
    const u1 = userMessage("u1", 1000, null);
    applyStep(
      store,
      { upserts: [u1], removes: [], events: [], activeTurnId: null },
      { mayDecline: false },
      "seed",
    );
    applyStep(
      store,
      {
        upserts: [],
        removes: [],
        events: [turnEvent("turn.stopped", 1001, "t-empty", "u1")],
        activeTurnId: null,
      },
      { mayDecline: false },
      "stopped with trigger",
    );
    applyStep(
      store,
      {
        upserts: [],
        removes: [],
        events: [turnEvent("turn.stopped", 1002, "t-empty-2", null)],
        activeTurnId: null,
      },
      { mayDecline: false },
      "stopped without trigger",
    );
  });

  it("removes the trigger user of an already-stopped turn", () => {
    const store = new RowFoldStore("chat-stopped-trigger-removed");
    const u1 = userMessage("u1", 1000, null);
    applyStep(
      store,
      {
        upserts: [u1],
        removes: [],
        events: [turnEvent("turn.stopped", 1001, "t-empty", "u1")],
        activeTurnId: null,
      },
      { mayDecline: false },
      "seed with trigger",
    );
    applyStep(
      store,
      { upserts: [], removes: ["u1"], events: [], activeTurnId: null },
      { mayDecline: false },
      "remove trigger",
    );
  });
});

describe("c. events: checkpoint overlap", () => {
  it("marks earlier turns whose files a LATER checkpoint touches again, and clears it when the later one stops overlapping", () => {
    const store = new RowFoldStore("chat-checkpoint-overlap");
    applyStep(
      store,
      {
        upserts: [],
        removes: [],
        events: [
          checkpointEvent({
            ts: 1000,
            turnId: "t1",
            checkpointId: "c1",
            entries: [
              { filePath: "/w/a.ts", beforeHash: "h0", afterHash: "h1" },
            ],
          }),
        ],
        activeTurnId: null,
      },
      { mayDecline: false },
      "checkpoint 1",
    );
    applyStep(
      store,
      {
        upserts: [],
        removes: [],
        events: [
          checkpointEvent({
            ts: 1001,
            turnId: "t2",
            checkpointId: "c2",
            entries: [
              { filePath: "/w/a.ts", beforeHash: "h1", afterHash: "h2" },
            ],
          }),
        ],
        activeTurnId: null,
      },
      { mayDecline: false },
      "checkpoint 2 overlaps",
    );
    applyStep(
      store,
      {
        upserts: [],
        removes: [],
        events: [
          checkpointEvent({
            ts: 1001,
            turnId: "t2",
            checkpointId: "c2-rewrite",
            entries: [
              { filePath: "/w/b.ts", beforeHash: "h0", afterHash: "h1" },
            ],
          }),
        ],
        activeTurnId: null,
      },
      { mayDecline: false },
      "checkpoint 2 rewritten to not overlap",
    );
  });
});

describe("c. events: setup windows", () => {
  it("partitions creating/running/succeeded/failed/cancelled, a worktree.missing re-bind, and a genesis pin", () => {
    const store = new RowFoldStore("chat-setup-windows");
    const u1 = userMessage("u1", 1000, null);
    applyStep(
      store,
      { upserts: [u1], removes: [], events: [], activeTurnId: null },
      { mayDecline: false },
      "seed",
    );
    applyStep(
      store,
      {
        upserts: [],
        removes: [],
        events: [setupEvent("setup.creating", 999, "/repo", "u1")],
        activeTurnId: null,
      },
      { mayDecline: false },
      "genesis window creating",
    );
    applyStep(
      store,
      {
        upserts: [],
        removes: [],
        events: [setupEvent("setup.running", 1000, "/repo", "u1")],
        activeTurnId: null,
      },
      { mayDecline: false },
      "genesis window running",
    );
    applyStep(
      store,
      {
        upserts: [],
        removes: [],
        events: [setupEvent("setup.succeeded", 1001, "/repo", "u1")],
        activeTurnId: null,
      },
      { mayDecline: false },
      "genesis window succeeded",
    );
    applyStep(
      store,
      {
        upserts: [],
        removes: [],
        events: [setupEvent("worktree.missing", 1002, "/repo", null)],
        activeTurnId: null,
      },
      { mayDecline: false },
      "worktree missing",
    );
    applyStep(
      store,
      {
        upserts: [],
        removes: [],
        events: [setupEvent("setup.running", 1003, "/repo", null)],
        activeTurnId: null,
      },
      { mayDecline: false },
      "re-bind window running",
    );
    applyStep(
      store,
      {
        upserts: [],
        removes: [],
        events: [setupEvent("setup.failed", 1004, "/repo", null)],
        activeTurnId: null,
      },
      { mayDecline: false },
      "re-bind window failed",
    );
    applyStep(
      store,
      {
        upserts: [],
        removes: [],
        events: [setupEvent("setup.running", 1005, "/repo", null)],
        activeTurnId: null,
      },
      { mayDecline: false },
      "re-bind window retried",
    );
    applyStep(
      store,
      {
        upserts: [],
        removes: [],
        events: [setupEvent("setup.cancelled", 1006, "/repo", null)],
        activeTurnId: null,
      },
      { mayDecline: false },
      "re-bind window cancelled",
    );
  });

  it("a mid-chat setup window anchors above its triggering message and moves the card when the anchor row moves", () => {
    const store = new RowFoldStore("chat-setup-anchor-move");
    const u1 = userMessage("u1", 1000, anchor("original"));
    applyStep(
      store,
      { upserts: [u1], removes: [], events: [], activeTurnId: null },
      { mayDecline: false },
      "seed",
    );
    applyStep(
      store,
      {
        upserts: [],
        removes: [],
        events: [setupEvent("setup.creating", 1000.5, "/repo", "u1")],
        activeTurnId: null,
      },
      { mayDecline: false },
      "mid-chat setup card",
    );
    applyStep(
      store,
      {
        upserts: [],
        removes: [],
        events: [setupEvent("setup.succeeded", 1001, "/repo", "u1")],
        activeTurnId: null,
      },
      { mayDecline: false },
      "mid-chat setup succeeded",
    );
    const rewritten = userMessage("u1", 1000, anchor("hopped"));
    applyStep(
      store,
      { upserts: [rewritten], removes: [], events: [], activeTurnId: null },
      { mayDecline: false },
      "anchor row rewritten",
    );
  });
});

describe("c. events: interrupt_restart steer lifecycle retractions", () => {
  it("retracts by messageId, by queueItemId, and by an items snapshot", () => {
    const store = new RowFoldStore("chat-steer-retractions");
    const u1 = userMessage("u1", 1000, null);
    const u2 = userMessage("u2", 1001, null);
    const u3 = userMessage("u3", 1002, null);
    applyStep(
      store,
      { upserts: [u1, u2, u3], removes: [], events: [], activeTurnId: null },
      { mayDecline: false },
      "seed",
    );

    const turnId = "t1";
    applyStep(
      store,
      {
        upserts: [],
        removes: [],
        events: [steerRequestedEvent(1003, turnId, "q1", "u1")],
        activeTurnId: turnId,
      },
      { mayDecline: false },
      "steer requested u1",
    );
    applyStep(
      store,
      {
        upserts: [],
        removes: [],
        events: [steerRequestedEvent(1004, turnId, "q2", "u2")],
        activeTurnId: turnId,
      },
      { mayDecline: false },
      "steer requested u2",
    );
    applyStep(
      store,
      {
        upserts: [],
        removes: [],
        events: [steerRequestedEvent(1005, turnId, "q3", "u3")],
        activeTurnId: turnId,
      },
      { mayDecline: false },
      "steer requested u3",
    );

    applyStep(
      store,
      {
        upserts: [],
        removes: [],
        events: [steerRetractByMessage("queue.fallback", 1006, "u1")],
        activeTurnId: turnId,
      },
      { mayDecline: false },
      "retract by messageId",
    );
    applyStep(
      store,
      {
        upserts: [],
        removes: [],
        events: [steerRetractByQueueItem("queue.resumed", 1007, "q2")],
        activeTurnId: turnId,
      },
      { mayDecline: false },
      "retract by queueItemId",
    );
    applyStep(
      store,
      {
        upserts: [],
        removes: [],
        events: [steerRetractBySnapshot("queue.cancelled", 1008, "q3", "u3")],
        activeTurnId: turnId,
      },
      { mayDecline: false },
      "retract by items snapshot",
    );
  });

  it("appends the steer user before AND after the block naming it", () => {
    const store = new RowFoldStore("chat-steer-user-before-and-after");
    const u1 = userMessage("u1", 1000, null);
    const a1 = assistantMessage(
      "a1",
      "t1",
      1001,
      [textBlock(1001), steerBlock(1001, "q1", "u1", "safe_point")],
      {
        turnProfile: false,
        startedAt: 1001,
      },
    );
    applyStep(
      store,
      { upserts: [u1, a1], removes: [], events: [], activeTurnId: null },
      { mayDecline: false },
      "steer target exists before the block",
    );

    // A steer naming a user id BEFORE that record exists (orphaned until inserted).
    const a2 = assistantMessage(
      "a2",
      "t2",
      1002,
      [textBlock(1002), steerBlock(1002, "q2", "future-u", "safe_point")],
      {
        turnProfile: false,
        startedAt: 1002,
      },
    );
    applyStep(
      store,
      { upserts: [a2], removes: [], events: [], activeTurnId: null },
      { mayDecline: false },
      "steer block names a not-yet-existing user",
    );
    const futureUser = userMessage("future-u", 999, null);
    applyStep(
      store,
      { upserts: [futureUser], removes: [], events: [], activeTurnId: null },
      { mayDecline: false },
      "the named user appears afterward",
    );
  });
});

describe("c. events: row-materializing event kinds", () => {
  it("chat.forked, chat.imported, an unattended approval.denied, and a notification-anchor send.failed", () => {
    const store = new RowFoldStore("chat-row-materializing-events");
    const forked = ev({
      ...EVENT_DEFAULTS,
      type: "chat.forked",
      ts: 1000,
      metadata: {
        sourceChatId: "src-1",
        sourceHostId: "host-1",
        sourceChatTitle: "Old chat",
      },
    });
    const imported = ev({
      ...EVENT_DEFAULTS,
      type: "chat.imported",
      ts: 999,
      metadata: {
        sourceProvider: "claude",
        nativeSessionId: "native-1",
        importedAt: 999,
        sourceCwd: "/repo",
      },
    });
    const denied = ev({
      ...EVENT_DEFAULTS,
      type: "approval.denied",
      ts: 1001,
      metadata: {
        autoJudge: {
          attendanceReason: "agent-created",
          rule: "r1",
          reason: "no human attending",
        },
      },
    });
    const failed = ev({
      ...EVENT_DEFAULTS,
      type: "send.failed",
      ts: 1002,
      message: "network error",
      metadata: { notificationAnchor: true, code: "ECONNRESET" },
    });
    applyStep(
      store,
      {
        upserts: [],
        removes: [],
        events: [forked, imported, denied, failed],
        activeTurnId: null,
      },
      { mayDecline: false },
      "row-materializing events",
    );
  });
});

// ---------------------------------------------------------------------------
// Explicit decline tests
// ---------------------------------------------------------------------------

function runFold(
  prior: TranscriptFoldState,
  change: TranscriptFoldChange,
  answer: (load: TranscriptFoldLoad) => TranscriptFoldLoadResult,
) {
  const steps = foldTranscriptRows(prior, change);
  let step = steps.next();
  while (step.done !== true) step = steps.next(answer(step.value));
  return step.value;
}

const NO_LOADS = (load: TranscriptFoldLoad): TranscriptFoldLoadResult => {
  switch (load.kind) {
    case "facts-from":
    case "facts-of-turns":
      return { kind: "facts", facts: [] };
    case "messages-of-turns":
    case "messages-by-id":
      return { kind: "messages", messages: [] };
    case "events-of-turns":
      return { kind: "turn-events", events: [] };
    case "events-by-type":
      return { kind: "events", events: [] };
    case "pause-open":
      return { kind: "pause-open", turnId: null };
    case "checkpoint-turns":
      return { kind: "checkpoint-turns", turns: [] };
    case "checkpoint-last-changes":
      return { kind: "checkpoint-last-changes", changes: [] };
    case "unit-rows":
    case "rows-by-id":
      return { kind: "rows", rows: [] };
  }
};

describe("explicit decline tests", () => {
  it("declines when the prior state's version does not match", () => {
    const badState: TranscriptFoldState = {
      ...EMPTY_TRANSCRIPT_FOLD_STATE,
      version: TRANSCRIPT_FOLD_STATE_VERSION + 1,
    };
    const result = runFold(
      badState,
      {
        chatId: "c",
        activeTurnId: null,
        upsertedMessages: [],
        removedMessages: [],
        appendedEvents: [],
      },
      NO_LOADS,
    );
    expect(result.continued).toBe(false);
  });

  it("declines when a message's stored fold facts version does not match", () => {
    const message = userMessage("u1", 1000, null);
    const priorState: TranscriptFoldState = {
      ...EMPTY_TRANSCRIPT_FOLD_STATE,
      messagesThrough: 0,
    };
    const result = runFold(
      priorState,
      {
        chatId: "c",
        activeTurnId: null,
        upsertedMessages: [
          {
            position: 0,
            message,
            previous: {
              position: 0,
              facts: {
                v: TRANSCRIPT_MESSAGE_FOLD_FACTS_VERSION + 1,
                role: "user",
                timestamp: 1000,
                sessionAnchor: null,
              },
            },
          },
        ],
        removedMessages: [],
        appendedEvents: [],
      },
      NO_LOADS,
    );
    expect(result.continued).toBe(false);
  });

  it("declines when a row-relevant event is rewritten in place with a different body", () => {
    const original = ev({
      ...EVENT_DEFAULTS,
      id: "ev-fixed",
      type: "turn.started",
      ts: 1000,
      turnId: "t-a",
    });
    const rewritten = ev({
      ...EVENT_DEFAULTS,
      id: "ev-fixed",
      type: "turn.started",
      ts: 1000,
      turnId: "t-b",
    });
    const priorState: TranscriptFoldState = {
      ...EMPTY_TRANSCRIPT_FOLD_STATE,
      eventsThrough: 0,
    };
    const result = runFold(
      priorState,
      {
        chatId: "c",
        activeTurnId: null,
        upsertedMessages: [],
        removedMessages: [],
        appendedEvents: [{ position: 0, event: rewritten, previous: original }],
      },
      NO_LOADS,
    );
    expect(result.continued).toBe(false);
  });

  it("continues on an IDENTICAL rewrite of a row-relevant event", () => {
    const original = ev({
      ...EVENT_DEFAULTS,
      id: "ev-fixed",
      type: "turn.started",
      ts: 1000,
      turnId: "t-a",
    });
    const identical = ev({
      ...EVENT_DEFAULTS,
      id: "ev-fixed",
      type: "turn.started",
      ts: 1000,
      turnId: "t-a",
    });
    const priorState: TranscriptFoldState = {
      ...EMPTY_TRANSCRIPT_FOLD_STATE,
      eventsThrough: 0,
    };
    const result = runFold(
      priorState,
      {
        chatId: "c",
        activeTurnId: null,
        upsertedMessages: [],
        removedMessages: [],
        appendedEvents: [{ position: 0, event: identical, previous: original }],
      },
      NO_LOADS,
    );
    expect(result.continued).toBe(true);
  });

  it("continues on a rewrite of a NON-row-relevant event type", () => {
    const original = ev({
      ...EVENT_DEFAULTS,
      id: "ev-fixed",
      type: "queue.added",
      ts: 1000,
    });
    const rewritten = ev({
      ...EVENT_DEFAULTS,
      id: "ev-fixed",
      type: "queue.added",
      ts: 1000,
      message: "different",
    });
    const priorState: TranscriptFoldState = {
      ...EMPTY_TRANSCRIPT_FOLD_STATE,
      eventsThrough: 0,
    };
    const result = runFold(
      priorState,
      {
        chatId: "c",
        activeTurnId: null,
        upsertedMessages: [],
        removedMessages: [],
        appendedEvents: [{ position: 0, event: rewritten, previous: original }],
      },
      NO_LOADS,
    );
    expect(result.continued).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mechanism tests, on a ~2000-record chat built through the store.
// ---------------------------------------------------------------------------

describe("mechanism tests on a large chat", () => {
  /**
   * Seeds through raw `store.apply` calls, without the O(record-count) oracle
   * comparison `applyStep` runs after every op - a ~2000-record chat built
   * through 1000 checked increments would be O(n^2) and time out. Each
   * mechanism test still runs the full parity check once, on the resulting
   * store, via {@link assertRowParity}.
   */
  function buildLargeChat(): {
    readonly store: RowFoldStore;
    readonly earlyTurnKey: string;
    readonly earlyUserId: string;
  } {
    const store = new RowFoldStore("chat-large");
    let earlyTurnKey = "";
    let earlyUserId = "";
    for (let i = 0; i < 1000; i += 1) {
      const uid = `u${i}`;
      const ts = 1000 + i * 2;
      const userResult = store.apply({
        upserts: [userMessage(uid, ts, null)],
        removes: [],
        events: [],
        activeTurnId: null,
      });
      expect(userResult.continued, `seed user ${i}`).toBe(true);
      const turnId = `t${i}`;
      if (i === 5) {
        earlyTurnKey = turnId;
        earlyUserId = uid;
      }
      const assistantResult = store.apply({
        upserts: [
          assistantMessage(`a${i}`, turnId, ts + 1, [textBlock(ts + 1)], {
            turnProfile: false,
            startedAt: ts + 1,
          }),
        ],
        removes: [],
        events: [],
        activeTurnId: null,
      });
      expect(assistantResult.continued, `seed assistant ${i}`).toBe(true);
    }
    return { store, earlyTurnKey, earlyUserId };
  }

  it("appending a tail record issues facts-from with a NON-null position and answers < 50 facts", () => {
    const { store } = buildLargeChat();
    const result = store.apply({
      upserts: [userMessage("tail-user", 999_999, null)],
      removes: [],
      events: [],
      activeTurnId: null,
    });
    expect(result.continued).toBe(true);
    const factsFrom = result.loads.filter((load) => load.kind === "facts-from");
    expect(factsFrom.length, "expected exactly one facts-from load").toBe(1);
    expect(factsFrom[0].position).not.toBeNull();
    expect(factsFrom[0].resultCount).toBeLessThan(50);
    assertRowParity(store, "tail append mechanism");
  });

  it("a streaming upsert with unchanged facts issues NO facts-from load", () => {
    const { store } = buildLargeChat();
    const ts = 1000 + 499 * 2 + 1;
    const streamed = assistantMessage(
      "a499",
      "t499",
      ts,
      [textBlock(ts), textBlock(ts)],
      { turnProfile: false, startedAt: ts },
    );
    const result = store.apply({
      upserts: [streamed],
      removes: [],
      events: [],
      activeTurnId: null,
    });
    expect(result.continued).toBe(true);
    expect(result.loads.filter((load) => load.kind === "facts-from")).toEqual(
      [],
    );
    assertRowParity(store, "streaming upsert mechanism");
  });

  it("an edit of an early user sessionAnchor issues facts-from position: null (widen) and still continues", () => {
    const { store, earlyUserId } = buildLargeChat();
    const rewritten = userMessage(earlyUserId, 1000, anchor("hopped"));
    const result = store.apply({
      upserts: [rewritten],
      removes: [],
      events: [],
      activeTurnId: null,
    });
    expect(result.continued).toBe(true);
    const factsFrom = result.loads.filter((load) => load.kind === "facts-from");
    expect(factsFrom.some((load) => load.position === null)).toBe(true);
    assertRowParity(store, "widen mechanism");
  });

  it("a turn whose walked state did not change is absent from the re-described units", () => {
    const { store, earlyTurnKey } = buildLargeChat();
    const result = store.apply({
      upserts: [userMessage("tail-user-2", 999_998, null)],
      removes: [],
      events: [],
      activeTurnId: null,
    });
    expect(result.continued).toBe(true);
    expect(result.touchedUnitKeys).not.toContain(turnRowUnitKey(earlyTurnKey));
    expect(result.touchedUnitKeys.length).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// g. Long agent chats: crosses MAX_TURNS_AFTER_LAST_USER (8) and
//    MAX_TURNS_AFTER_OPEN_TURN (32); an open turn gains a record after the
//    region moved past it; then an edit of the old user record.
// ---------------------------------------------------------------------------

describe("g. long agent chats", () => {
  it("one user message then 45 autonomous turns, an old open turn gaining a late record, then an old user edit - all continue", () => {
    const store = new RowFoldStore("chat-long-agent");
    const u1 = userMessage("u1", 1000, anchor("orig"));
    applyStep(
      store,
      { upserts: [u1], removes: [], events: [], activeTurnId: null },
      { mayDecline: false },
      "seed user",
    );

    const openTurnId = "t-open-0";
    applyStep(
      store,
      {
        upserts: [],
        removes: [],
        events: [turnEvent("turn.started", 1001, openTurnId, null)],
        activeTurnId: openTurnId,
      },
      { mayDecline: false },
      "open turn started",
    );

    for (let i = 1; i <= 45; i += 1) {
      const turnId = `t-auto-${i}`;
      const ts = 1002 + i;
      const blocks = [autonomousResumeBlock(ts), textBlock(ts)];
      applyStep(
        store,
        {
          upserts: [
            assistantMessage(`a-auto-${i}`, turnId, ts, blocks, {
              turnProfile: false,
              startedAt: ts,
            }),
          ],
          removes: [],
          events: [turnEvent("turn.completed", ts, turnId, null)],
          activeTurnId: null,
        },
        { mayDecline: false },
        `autonomous turn ${i}`,
      );
    }

    applyStep(
      store,
      {
        upserts: [
          assistantMessage("a-open-late", openTurnId, 2100, [textBlock(2100)], {
            turnProfile: false,
            startedAt: 1001,
          }),
        ],
        removes: [],
        events: [],
        activeTurnId: openTurnId,
      },
      { mayDecline: false },
      "open turn gains late record",
    );

    const rewritten = userMessage("u1", 1000, anchor("hopped-late"));
    applyStep(
      store,
      {
        upserts: [rewritten],
        removes: [],
        events: [],
        activeTurnId: openTurnId,
      },
      { mayDecline: false },
      "old user edited after long autonomous run",
    );
  });
});

// ---------------------------------------------------------------------------
// f. Batches: one change carrying several upserts/removes/events.
// ---------------------------------------------------------------------------

describe("f. batches: one change carries several touches at once", () => {
  it("upserts three messages, removes one, and appends two events in a single change", () => {
    const store = new RowFoldStore("chat-batch");
    const seedMsgs = [
      userMessage("u1", 1000, null),
      assistantMessage("a1", "t1", 1001, [textBlock(1001)], {
        turnProfile: false,
        startedAt: 1001,
      }),
      userMessage("u2", 1002, null),
    ];
    applyStep(
      store,
      { upserts: seedMsgs, removes: [], events: [], activeTurnId: null },
      { mayDecline: false },
      "seed",
    );

    const batch: RowFoldChangeInput = {
      upserts: [
        userMessage("u3", 1003, null),
        assistantMessage("a2", "t2", 1004, [textBlock(1004)], {
          turnProfile: false,
          startedAt: 1004,
        }),
      ],
      removes: ["u2"],
      events: [
        turnEvent("turn.started", 1003, "t2", null),
        turnEvent("turn.completed", 1005, "t2", null),
      ],
      activeTurnId: null,
    };
    applyStep(store, batch, { mayDecline: false }, "batched change");
  });
});
