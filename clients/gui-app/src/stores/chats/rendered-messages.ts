import { useMemo } from "react";
import type {
  AgentSender,
  AssistantMessage,
  ChatEvent,
  Message,
  UserMessage,
  UserMessageSender,
} from "@traycer/protocol/persistence/epic/schemas";
import type {
  ChatActiveTurn,
  ChatApprovalState,
  ChatFileEditApprovalState,
  ChatPendingInterviewState,
  ChatQueuedItem,
  ChatRunStatus,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { chatQueuedItemSchema } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  isNoOpCheckpointEntry,
  turnCheckpointManifestSchema,
  type TurnCheckpointManifest,
} from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import { AUTH_ERROR_CODE } from "@traycer/protocol/host/agent/gui/agent-runtime";
import {
  buildAttachmentsFromJSONContent,
  extractPlainTextFromComposerJSONContent,
} from "@/lib/composer/tiptap-json-content";
import { isRenderableSubAgentBlock } from "@/lib/chat/subagent-blocks";
import { transientLiveAssistantMessageId } from "@/lib/chat/transient-live-assistant-message-id";
import type {
  AssistantTurnMeta,
  ChatMessage as ChatMessageModel,
  ChatMessageRunState,
  ArtifactChangeRow,
  ChatMessageSteerBadge,
  FileChangeSegment,
  MessageSegment,
  SegmentEndState,
  SegmentTodoItem,
  SubagentChildSegment,
} from "@/stores/composer/chat-store";
import type { AgentSenderDisplay } from "@/lib/chat/sender-display";
import type {
  LiveAssistantMessage,
  PendingUserMessage,
} from "@/stores/chats/chat-session-store";
import {
  mergeSnapshotSourceBlockIds,
  singleSnapshotSourceBlockId,
} from "@/lib/chat/snapshot-source-block-ids";
import type { ContentBlock } from "@traycer/protocol/persistence/epic/schemas";
import type { WorktreeBindingOwnerKind } from "@traycer/protocol/host/worktree-schemas";
import {
  buildSetupCardRows,
  type SetupCardRow,
} from "@/stores/chats/setup-card-rows";

type PlanContentBlock = Extract<ContentBlock, { type: "plan" }>;

/**
 * Fallback React row key for the pre-turn assistant placeholder when the host
 * reports `running` before exposing an active turn id. As soon as a turn id is
 * known, in-progress and persisted assistant rows use `assistant:<turnId>` so
 * the message list updates completion in place instead of replacing the row.
 */
const LIVE_ASSISTANT_ROW_ID = "assistant:live";

function isRenderablePlanBlock(block: PlanContentBlock): boolean {
  // Render a plan only once it carries content. A status-only block (e.g. an
  // empty `ready` finalizer) must NOT render as a blank card. `planStatus` is
  // deliberately NOT a render trigger - a content-less plan is never shown.
  return (
    block.markdownPreview.length > 0 ||
    block.steps.length > 0 ||
    block.fullContentRef !== null
  );
}

export interface RenderedMessagesDisplayContext {
  readonly resolveUserSenderLabel: (sender: UserMessageSender) => string;
  readonly resolveAgentSenderDisplay: (
    sender: AgentSender,
  ) => AgentSenderDisplay;
  readonly resolveAgentReasoningLabel: (
    sender: AgentSender,
    reasoningEffort: string | null,
  ) => string | null;
  readonly contentBlocksText: (blocks: ReadonlyArray<ContentBlock>) => string;
}

export interface RenderedMessagesInput {
  readonly messages: ReadonlyArray<Message>;
  readonly events: ReadonlyArray<ChatEvent>;
  readonly pendingUserMessages: ReadonlyArray<PendingUserMessage>;
  readonly liveAssistantMessage: LiveAssistantMessage | null;
  readonly activeTurn: ChatActiveTurn | null;
  readonly pendingApprovals?: ReadonlyArray<ChatApprovalState>;
  readonly pendingFileEditApprovals?: ReadonlyArray<ChatFileEditApprovalState>;
  readonly pendingInterviews?: ReadonlyArray<ChatPendingInterviewState>;
  /**
   * Host-owned chat run state. Drives the in-progress indicator on the
   * active assistant turn's row (`running` → "Working…", `stopping` →
   * "Stopping…"). `idle` leaves every row indicator-free.
   */
  readonly runStatus: ChatRunStatus;
  /**
   * Chat-tile binding identity, threaded straight into `buildSetupCardRows` so
   * a synthesized setup-card row can route its per-workspace retry mutation and
   * scope the terminal-liveness query. These are tile-owned and stable across
   * renders (they never change for a mounted chat), so they make churn-free
   * memo deps.
   */
  readonly epicId: string;
  readonly ownerId: string;
  readonly ownerKind: WorktreeBindingOwnerKind;
  /**
   * Tab-scoped id the setup card needs for its focus-terminal path. Carried on
   * the synthesized (never-persisted) setup-card segment rather than as a
   * per-row prop so it doesn't bust the message-virtualizer cache.
   */
  readonly viewTabId: string;
}

/*
 * Per-Message cache for user rows. `Message` references are stable across
 * snapshot deltas (the protocol re-issues the same object identity), so a
 * WeakMap keyed on the message gives O(1) reuse without invalidation logic.
 */
const renderCache = new WeakMap<
  RenderedMessagesDisplayContext,
  WeakMap<Message, ChatMessageModel>
>();

/*
 * Per-assistant-turn cache. Unlike user messages, assistant turns are
 * synthesized by coalescing one-or-more `Message`s sharing a `turnId` (plus
 * optional live-blocks injection), so there's no single `Message` reference
 * to key on. Instead we hash the turn's blocks into a `signature` and reuse
 * the cached `ChatMessageModel` whenever the signature matches the last
 * call. During streaming the live turn's signature changes on block status,
 * timestamp, or renderable text updates, so it recomputes; every other
 * persisted turn returns a reference-stable model that lets `React.memo` on
 * `ChatMessage` skip rendering. Without this cache, all visible rows
 * re-render per delta because the assistant model is rebuilt fresh each
 * call.
 */
interface AssistantTurnCacheEntry {
  cacheKey: string;
  models: ReadonlyArray<ChatMessageModel>;
}

const TURN_SIGNATURE_HASH_OFFSET = 2166136261;
const TURN_SIGNATURE_HASH_PRIME = 16777619;

const assistantTurnCache = new WeakMap<
  RenderedMessagesDisplayContext,
  Map<string, AssistantTurnCacheEntry>
>();

function userCacheForContext(
  ctx: RenderedMessagesDisplayContext,
): WeakMap<Message, ChatMessageModel> {
  const existing = renderCache.get(ctx);
  if (existing !== undefined) return existing;
  const created = new WeakMap<Message, ChatMessageModel>();
  renderCache.set(ctx, created);
  return created;
}

function assistantTurnCacheForContext(
  ctx: RenderedMessagesDisplayContext,
): Map<string, AssistantTurnCacheEntry> {
  const existing = assistantTurnCache.get(ctx);
  if (existing !== undefined) return existing;
  const created = new Map<string, AssistantTurnCacheEntry>();
  assistantTurnCache.set(ctx, created);
  return created;
}

function turnSignature(blocks: ReadonlyArray<ContentBlock>): string {
  if (blocks.length === 0) return "0";

  let hash = hashNumberField(TURN_SIGNATURE_HASH_OFFSET, blocks.length);
  for (const block of blocks) {
    hash = hashStringField(hash, block.blockId);
    hash = hashStringField(hash, block.type);
    hash = hashStringField(hash, block.status);
    hash = hashNumberField(hash, block.timestamp);
    hash = hashNumberField(hash, blockContentVersion(block));
  }
  return `${blocks.length}:${hash}`;
}

function blockContentVersion(block: ContentBlock): number {
  // `text.delta` / `reasoning.delta` only ever append to `text` / `content`, so
  // length alone catches every accumulator update. Avoid hashing the full body
  // — this signature runs once per block per render during streaming.
  switch (block.type) {
    case "text":
      return block.text.length;
    case "reasoning":
      return block.content.length;
    case "steer":
      return extractPlainTextFromComposerJSONContent(block.content).length;
    case "plan":
      return planBlockContentVersion(block);
    default:
      return 0;
  }
}

function planBlockContentVersion(
  block: Extract<ContentBlock, { type: "plan" }>,
): number {
  let hash = hashStringField(TURN_SIGNATURE_HASH_OFFSET, block.planStatus);
  hash = hashStringField(hash, planContentIdentity(block));
  hash = hashStringField(hash, block.title ?? "");
  hash = hashStringField(hash, block.summary ?? "");
  // Hash the full preview, not just its length: a same-length edit (no
  // fullContentRef/revision change, e.g. a short inline plan) would otherwise
  // reuse a stale cached segment.
  hash = hashStringField(hash, block.markdownPreview);
  hash = hashStringField(hash, block.approvalId ?? "");
  hash = hashStringField(hash, block.supersededByPlanId ?? "");
  hash = block.steps.reduce((next, step) => {
    let stepHash = hashStringField(next, step.id ?? "");
    stepHash = hashStringField(stepHash, step.status);
    stepHash = hashStringField(stepHash, step.text);
    return hashStringField(stepHash, step.activeForm ?? "");
  }, hash);
  return block.actions.reduce((next, action) => {
    let actionHash = hashStringField(next, action.id);
    actionHash = hashStringField(actionHash, action.label);
    actionHash = hashStringField(actionHash, action.decision);
    return hashStringField(actionHash, action.variant);
  }, hash);
}

function hashStringField(hash: number, value: string): number {
  let next = hashNumberField(hash, value.length);
  for (let index = 0; index < value.length; index += 1) {
    next ^= value.charCodeAt(index);
    next = Math.imul(next, TURN_SIGNATURE_HASH_PRIME);
  }
  return next >>> 0;
}

function hashNumberField(hash: number, value: number): number {
  let next = hash;
  const normalized = Number.isFinite(value) ? Math.trunc(value) : 0;
  const low = normalized >>> 0;
  const high = Math.floor(normalized / 0x100000000) >>> 0;
  next ^= low;
  next = Math.imul(next, TURN_SIGNATURE_HASH_PRIME);
  next ^= high;
  next = Math.imul(next, TURN_SIGNATURE_HASH_PRIME);
  return next >>> 0;
}

function checkpointSignature(view: CheckpointManifestView | null): string {
  if (view === null) return "checkpoint:none";
  return [
    "checkpoint",
    view.manifest.checkpointId,
    view.hasLaterOverlappingChanges ? "overlap" : "base",
    view.manifest.entries
      .map((entry) =>
        [
          entry.filePath,
          entry.operation,
          entry.undoable ? "undoable" : "not-undoable",
          entry.reason ?? "",
          entry.beforeHash ?? "",
          entry.afterHash ?? "",
        ].join(":"),
      )
      .join("|"),
  ].join(";");
}

function steeredMessageIdsFromEvents(
  events: ReadonlyArray<ChatEvent>,
): ReadonlySet<string> {
  const steeredMessageIds = new Set<string>();
  const steerRequestMessageIdsByQueueItemId = new Map<string, string>();
  for (const event of events) {
    if (event.type === "queue.steerRequested") {
      if (
        event.messageId !== null &&
        event.queueItemId !== null &&
        isInterruptRestartSteerRequest(event)
      ) {
        steeredMessageIds.add(event.messageId);
        steerRequestMessageIdsByQueueItemId.set(
          event.queueItemId,
          event.messageId,
        );
      }
      continue;
    }

    if (
      event.type === "queue.fallback" ||
      event.type === "queue.resumed" ||
      event.type === "queue.cancelled" ||
      event.type === "queue.steerAborted"
    ) {
      if (event.messageId !== null) {
        steeredMessageIds.delete(event.messageId);
      }
      if (event.queueItemId !== null) {
        const messageId = steerRequestMessageIdsByQueueItemId.get(
          event.queueItemId,
        );
        if (messageId !== undefined) {
          steeredMessageIds.delete(messageId);
          steerRequestMessageIdsByQueueItemId.delete(event.queueItemId);
        }
      }
      for (const item of queueItemsFromEventMetadata(event.metadata)) {
        if (queueItemHasActiveInterruptRestartSteer(item)) {
          continue;
        }
        steeredMessageIds.delete(item.messageId);
        steerRequestMessageIdsByQueueItemId.delete(item.queueItemId);
      }
    }
  }
  return steeredMessageIds;
}

function isInterruptRestartSteerRequest(event: ChatEvent): boolean {
  if (event.type !== "queue.steerRequested") return false;
  const requestedItems = queueItemsFromEventMetadata(event.metadata);
  for (const item of requestedItems) {
    if (item.queueItemId !== event.queueItemId) continue;
    return item.steerRequest?.mode === "interrupt_restart";
  }
  return false;
}

function queueItemHasActiveInterruptRestartSteer(
  item: ChatQueuedItem,
): boolean {
  return (
    (item.status === "steer_requested" || item.status === "steering") &&
    item.steerRequest !== null &&
    item.steerRequest.mode === "interrupt_restart"
  );
}

function queueItemsFromEventMetadata(
  metadata: ChatEvent["metadata"],
): ReadonlyArray<ChatQueuedItem> {
  if (metadata === null) return [];
  const stateItems = metadata["items"];
  if (Array.isArray(stateItems)) {
    return stateItems.flatMap((item) => {
      const parsed = chatQueuedItemSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
  }
  const parsed = chatQueuedItemSchema.safeParse(metadata["item"]);
  return parsed.success ? [parsed.data] : [];
}

function nestedSteeredUsersSignature(
  blocks: ReadonlyArray<ContentBlock>,
  userMessagesById: ReadonlyMap<string, UserMessage>,
): string {
  const parts = blocks.flatMap((block) => {
    if (block.type !== "steer") return [];
    const message = userMessagesById.get(block.messageId);
    if (message === undefined) return [];
    return [
      [
        message.messageId,
        message.timestamp,
        extractPlainTextFromComposerJSONContent(message.message.content),
      ].join(":"),
    ];
  });
  return parts.length === 0 ? "steer-users:none" : parts.join("|");
}

function completedSteerBadge(
  mode: ChatMessageSteerBadge["mode"],
): ChatMessageSteerBadge {
  return { status: "steered", mode };
}

// Identity-stable empties for the head/tail partition's no-merge fast path.
const NO_MESSAGES: ReadonlyArray<Message> = [];
const NO_RENDERED_MESSAGES: ReadonlyArray<ChatMessageModel> = [];
const NO_STEERED_IDS: ReadonlySet<string> = new Set();
const NO_PENDING_APPROVALS: ReadonlyArray<ChatApprovalState> = [];
const NO_PENDING_FILE_EDIT_APPROVALS: ReadonlyArray<ChatFileEditApprovalState> =
  [];
const NO_PENDING_INTERVIEWS: ReadonlyArray<ChatPendingInterviewState> = [];

interface TurnPauseAccounting {
  readonly pausedDurationMs: number;
  readonly pausedSinceMs: number | null;
}

interface PauseInterval {
  readonly startedAt: number;
  readonly endedAt: number | null;
}

interface PendingPauseRequest {
  readonly turnId: string;
  readonly startedAt: number;
}

interface PendingTurnMetaInput {
  readonly harnessId: AgentSender["harnessId"] | null;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly serviceTier: string | null;
}

interface ActiveTurnProjection {
  readonly turnId: string | null;
  readonly metaInput: PendingTurnMetaInput;
}

const NO_TURN_PAUSE: TurnPauseAccounting = {
  pausedDurationMs: 0,
  pausedSinceMs: null,
};

const NO_PENDING_TURN_META_INPUT: PendingTurnMetaInput = {
  harnessId: null,
  model: null,
  reasoningEffort: null,
  serviceTier: null,
};

function turnPauseSignature(pause: TurnPauseAccounting): string {
  return `${pause.pausedDurationMs}:${pause.pausedSinceMs ?? "none"}`;
}

function buildTurnPauseAccounting(input: {
  readonly events: ReadonlyArray<ChatEvent>;
  readonly activeTurnId: string | null;
  readonly pendingApprovals: ReadonlyArray<ChatApprovalState>;
  readonly pendingFileEditApprovals: ReadonlyArray<ChatFileEditApprovalState>;
  readonly pendingInterviews: ReadonlyArray<ChatPendingInterviewState>;
}): ReadonlyMap<string, TurnPauseAccounting> {
  const intervalsByTurn = new Map<string, PauseInterval[]>();
  const pendingRequests = new Map<string, PendingPauseRequest>();
  const livePendingKeys = livePendingPauseKeys(input);

  const startRequest = (
    key: string,
    turnId: string | null,
    startedAt: number,
  ): void => {
    if (turnId === null) return;
    pendingRequests.set(key, { turnId, startedAt });
  };
  const finishRequest = (key: string, endedAt: number): void => {
    const pending = pendingRequests.get(key);
    if (pending === undefined) return;
    addPauseInterval(intervalsByTurn, pending.turnId, {
      startedAt: pending.startedAt,
      endedAt,
    });
    pendingRequests.delete(key);
  };

  for (const event of input.events) {
    if (event.type === "approval.requested" && event.approvalId !== null) {
      startRequest(
        approvalPauseKey(event.approvalId),
        event.turnId,
        event.timestamp,
      );
      continue;
    }
    if (isApprovalWaitEndEvent(event) && event.approvalId !== null) {
      finishRequest(approvalPauseKey(event.approvalId), event.timestamp);
      continue;
    }
    if (event.type === "interview.requested" && event.blockId !== null) {
      startRequest(
        interviewPauseKey(event.blockId),
        event.turnId,
        event.timestamp,
      );
      continue;
    }
    if (isInterviewWaitEndEvent(event) && event.blockId !== null) {
      finishRequest(interviewPauseKey(event.blockId), event.timestamp);
    }
  }

  for (const [key, pending] of pendingRequests) {
    if (!livePendingKeys.has(key)) continue;
    addPauseInterval(intervalsByTurn, pending.turnId, {
      startedAt: pending.startedAt,
      endedAt: null,
    });
  }

  if (input.activeTurnId !== null) {
    addFallbackLivePendingIntervals(input, intervalsByTurn, pendingRequests);
  }

  return pauseAccountingFromIntervals(intervalsByTurn);
}

function livePendingPauseKeys(input: {
  readonly pendingApprovals: ReadonlyArray<ChatApprovalState>;
  readonly pendingFileEditApprovals: ReadonlyArray<ChatFileEditApprovalState>;
  readonly pendingInterviews: ReadonlyArray<ChatPendingInterviewState>;
}): ReadonlySet<string> {
  return new Set([
    ...input.pendingApprovals.map((approval) =>
      approvalPauseKey(approval.approvalId),
    ),
    ...input.pendingFileEditApprovals.map((approval) =>
      approvalPauseKey(approval.approvalId),
    ),
    ...input.pendingInterviews.map((interview) =>
      interviewPauseKey(interview.blockId),
    ),
  ]);
}

function addFallbackLivePendingIntervals(
  input: {
    readonly activeTurnId: string | null;
    readonly pendingApprovals: ReadonlyArray<ChatApprovalState>;
    readonly pendingFileEditApprovals: ReadonlyArray<ChatFileEditApprovalState>;
    readonly pendingInterviews: ReadonlyArray<ChatPendingInterviewState>;
  },
  intervalsByTurn: Map<string, PauseInterval[]>,
  pendingRequests: ReadonlyMap<string, PendingPauseRequest>,
): void {
  const activeTurnId = input.activeTurnId;
  if (activeTurnId === null) return;
  const addIfMissing = (key: string, requestedAt: number): void => {
    if (pendingRequests.has(key)) return;
    addPauseInterval(intervalsByTurn, activeTurnId, {
      startedAt: requestedAt,
      endedAt: null,
    });
  };
  input.pendingApprovals.forEach((approval) =>
    addIfMissing(approvalPauseKey(approval.approvalId), approval.requestedAt),
  );
  input.pendingFileEditApprovals.forEach((approval) =>
    addIfMissing(approvalPauseKey(approval.approvalId), approval.requestedAt),
  );
  input.pendingInterviews.forEach((interview) =>
    addIfMissing(interviewPauseKey(interview.blockId), interview.requestedAt),
  );
}

function pauseAccountingFromIntervals(
  intervalsByTurn: ReadonlyMap<string, ReadonlyArray<PauseInterval>>,
): ReadonlyMap<string, TurnPauseAccounting> {
  const out = new Map<string, TurnPauseAccounting>();
  for (const [turnId, intervals] of intervalsByTurn) {
    out.set(turnId, mergePauseIntervals(intervals));
  }
  return out;
}

function mergePauseIntervals(
  intervals: ReadonlyArray<PauseInterval>,
): TurnPauseAccounting {
  const sorted = [...intervals]
    .filter(
      (interval) =>
        interval.endedAt === null || interval.endedAt > interval.startedAt,
    )
    .sort((a, b) => a.startedAt - b.startedAt);
  let pausedDurationMs = 0;
  let openStart: number | null = null;
  let current: PauseInterval | null = null;

  const flushCurrent = (): void => {
    if (current === null) return;
    if (current.endedAt === null) {
      openStart = current.startedAt;
    } else {
      pausedDurationMs += current.endedAt - current.startedAt;
    }
    current = null;
  };

  for (const interval of sorted) {
    if (current === null) {
      current = interval;
      continue;
    }
    if (current.endedAt === null) continue;
    if (interval.startedAt > current.endedAt) {
      flushCurrent();
      current = interval;
      continue;
    }
    current = {
      startedAt: current.startedAt,
      endedAt:
        interval.endedAt === null
          ? null
          : Math.max(current.endedAt, interval.endedAt),
    };
  }
  flushCurrent();

  return {
    pausedDurationMs,
    pausedSinceMs: openStart,
  };
}

function addPauseInterval(
  intervalsByTurn: Map<string, PauseInterval[]>,
  turnId: string,
  interval: PauseInterval,
): void {
  const existing = intervalsByTurn.get(turnId);
  if (existing === undefined) {
    intervalsByTurn.set(turnId, [interval]);
    return;
  }
  existing.push(interval);
}

function approvalPauseKey(approvalId: string): string {
  return `approval:${approvalId}`;
}

function interviewPauseKey(blockId: string): string {
  return `interview:${blockId}`;
}

function isApprovalWaitEndEvent(event: ChatEvent): boolean {
  return (
    event.type === "approval.resolved" ||
    event.type === "approval.denied" ||
    event.type === "approval.abandoned"
  );
}

function isInterviewWaitEndEvent(event: ChatEvent): boolean {
  return (
    event.type === "interview.resolved" || event.type === "interview.errored"
  );
}

export function useRenderedMessages(
  input: RenderedMessagesInput,
  displayContext: RenderedMessagesDisplayContext,
): ReadonlyArray<ChatMessageModel> {
  // The store assigns a fresh `activeTurn` object on every snapshot, so depend
  // on its stable primitive fields (not the object identity) to avoid busting
  // this memo each frame. These are all set at turn-start and never rewritten
  // per delta, so they make safe, churn-free deps.
  const activeTurnProjection = projectActiveTurn(input.activeTurn);
  const activeTurnId = activeTurnProjection.turnId;
  const activeTurnMetaInput = activeTurnProjection.metaInput;
  const runStatus = input.runStatus;
  // The run-state indicator belongs to the single active turn; `idle`
  // surfaces no indicator on any row.
  const activeRunState: ChatMessageRunState | null =
    runStatus === "idle" ? null : runStatus;
  const pendingApprovals = input.pendingApprovals ?? NO_PENDING_APPROVALS;
  const pendingFileEditApprovals =
    input.pendingFileEditApprovals ?? NO_PENDING_FILE_EDIT_APPROVALS;
  const pendingInterviews = input.pendingInterviews ?? NO_PENDING_INTERVIEWS;
  const turnPauseAccounting = useMemo(
    () =>
      buildTurnPauseAccounting({
        events: input.events,
        activeTurnId,
        pendingApprovals,
        pendingFileEditApprovals,
        pendingInterviews,
      }),
    [
      input.events,
      activeTurnId,
      pendingApprovals,
      pendingFileEditApprovals,
      pendingInterviews,
    ],
  );

  // Event-derived views change only when the event log changes, never per
  // streamed delta - memoize them so a delta doesn't re-scan the events.
  const checkpointViews = useMemo(
    () => checkpointManifestViewsFromEvents(input.events),
    [input.events],
  );
  const steeredMessageIds = useMemo(
    () => steeredMessageIdsFromEvents(input.events),
    [input.events],
  );
  // The setup card row(s) are derived from the same event log, keyed on events
  // plus the (stable) binding identity, so a streamed delta doesn't re-scan or
  // re-partition the setup lifecycle windows.
  const epicId = input.epicId;
  const ownerId = input.ownerId;
  const ownerKind = input.ownerKind;
  const viewTabId = input.viewTabId;
  const setupCardRows = useMemo(
    () => buildSetupCardRows(input.events, { epicId, ownerId, ownerKind }),
    [input.events, epicId, ownerId, ownerKind],
  );
  // Project each row into its transcript card PLUS the placement signals the
  // final merge needs (anchor target + genesis-pin discriminator), so that merge
  // never has to index `setupCardRows` positionally in parallel with the cards.
  const setupCardEntries = useMemo(
    () =>
      setupCardRows.map((row, index) => ({
        message: buildSetupCardMessage(row, ownerId, viewTabId, index),
        anchorId: row.triggeringMessageId,
        hasCreatingEvent: row.hasCreatingEvent,
      })),
    [setupCardRows, ownerId, viewTabId],
  );
  const forkedChatLinkMessages = useMemo(
    () => buildForkedChatLinkMessages(input.events, viewTabId),
    [input.events, viewTabId],
  );

  // The live row's blocks merge INTO a persisted turn only when a persisted
  // assistant message already shares its `turnId` (multi-record / post-snapshot
  // turns). The store routes streamed deltas to EITHER `messages` or
  // `liveAssistantMessage`, never both, so in the common streaming case the
  // live row stands alone and the persisted render is independent of it.
  const liveAssistant = input.liveAssistantMessage;
  const liveTurnKey = liveAssistant === null ? null : liveAssistant.turnId;

  // Head/tail partition for the merge case: carve the live turn's records out
  // of the settled walk so a streaming delta re-derives ONLY the active turn
  // (the tail), leaving the settled head untouched per tick. The final memo
  // re-interleaves the partitions through the shared `createdAt` sort, so the
  // split never changes row ids or order. Per-tick stability: every dep here
  // changes on snapshots or turn boundaries, never on streamed deltas. An
  // empty `activeTurn` means the live row (if any) stands alone.
  const partition = useMemo((): {
    readonly settled: ReadonlyArray<Message>;
    readonly activeTurn: ReadonlyArray<Message>;
  } => {
    const isActiveTurnRecord = (message: Message): boolean =>
      message.role === "assistant" && message.turnId === liveTurnKey;
    const activeTurn =
      liveTurnKey === null
        ? NO_MESSAGES
        : input.messages.filter(isActiveTurnRecord);
    if (activeTurn.length === 0) {
      return { settled: input.messages, activeTurn: NO_MESSAGES };
    }
    return {
      settled: input.messages.filter((message) => !isActiveTurnRecord(message)),
      activeTurn,
    };
  }, [input.messages, liveTurnKey]);
  const liveMergesIntoPersisted = partition.activeTurn.length > 0;

  // User records can be referenced from either partition (steer rows render
  // inside their nesting turn); build the lookup once per snapshot and thread
  // it everywhere instead of letting each walk rebuild it.
  const userMessagesById = useMemo(
    () => userMessagesByIdFromMessages(input.messages),
    [input.messages],
  );

  const activeTurnSteeredIdsKey = liveMergesIntoPersisted
    ? activeTurnSteeredIdsContentKey(partition.activeTurn, liveAssistant)
    : "";
  const activeTurnSteeredMessageIds = useMemo(
    (): ReadonlySet<string> =>
      new Set(
        activeTurnSteeredIdsKey === ""
          ? []
          : activeTurnSteeredIdsKey.split("\n"),
      ),
    [activeTurnSteeredIdsKey],
  );

  // Turns present in the snapshot (plus the live turn) survive the cache
  // sweep; anything else fell out of the transcript (branch edits, deletes).
  const retainedTurnKeys = useMemo((): ReadonlySet<string> => {
    const keys = new Set(
      input.messages
        .filter(
          (message): message is AssistantMessage =>
            message.role === "assistant",
        )
        .map(assistantTurnKey),
    );
    if (liveTurnKey !== null) keys.add(liveTurnKey);
    return keys;
  }, [input.messages, liveTurnKey]);

  const persisted = useMemo(() => {
    return renderPersistedMessages({
      messages: partition.settled,
      userMessagesById,
      liveAssistant: null,
      externallyNestedSteeredMessageIds: activeTurnSteeredMessageIds,
      checkpointViews,
      activeTurnId,
      activeRunState,
      turnPauseAccounting,
      steeredMessageIds,
      sweepRetainedTurnKeys: retainedTurnKeys,
      ctx: displayContext,
    });
  }, [
    partition,
    userMessagesById,
    activeTurnSteeredMessageIds,
    retainedTurnKeys,
    checkpointViews,
    activeTurnId,
    activeRunState,
    turnPauseAccounting,
    steeredMessageIds,
    displayContext,
  ]);

  // The tail: re-derives per streamed delta, but walks only the active turn's
  // records. The live turn always carries `startedAt` (set at turn start), so
  // the settled walk's `lastUserTimestamp` legacy anchor fallback is not
  // needed here.
  const activeTurn = useMemo(
    () =>
      partition.activeTurn.length === 0
        ? NO_RENDERED_MESSAGES
        : renderPersistedMessages({
            messages: partition.activeTurn,
            userMessagesById,
            liveAssistant,
            externallyNestedSteeredMessageIds: NO_STEERED_IDS,
            checkpointViews,
            activeTurnId,
            activeRunState,
            turnPauseAccounting,
            steeredMessageIds,
            // The tail walk runs per streamed delta; only the settled-head
            // walk (once per snapshot) sweeps the turn cache.
            sweepRetainedTurnKeys: null,
            ctx: displayContext,
          }),
    [
      partition,
      userMessagesById,
      liveAssistant,
      checkpointViews,
      activeTurnId,
      activeRunState,
      turnPauseAccounting,
      steeredMessageIds,
      displayContext,
    ],
  );

  const pending = useMemo(
    () =>
      input.pendingUserMessages.map((message) =>
        renderPendingUserMessage(message, displayContext),
      ),
    [input.pendingUserMessages, displayContext],
  );

  const live = useMemo(
    () =>
      renderLiveAssistant({
        liveAssistant,
        userMessagesById,
        mergesIntoPersisted: liveMergesIntoPersisted,
        checkpointViews,
        activeRunState,
        turnPauseAccounting,
        ctx: displayContext,
      }),
    [
      liveAssistant,
      userMessagesById,
      liveMergesIntoPersisted,
      checkpointViews,
      activeRunState,
      turnPauseAccounting,
      displayContext,
    ],
  );

  return useMemo(() => {
    // Pre-turn window: the host reports `running`/`stopping` (a send was
    // accepted) but no assistant row exists yet - provider-session/worktree
    // setup runs before the turn materializes. Synthesize a pending-assistant
    // row so the response area shows "Working…" immediately. It shares the live
    // row's key, so when the real turn arrives it swaps in place (no flicker).
    // `pending` (the optimistic user messages, timestamped `Date.now()`) is
    // included so the indicator's `createdAt` floor sits above them and the row
    // sorts BELOW the just-sent message instead of jumping above it.
    // Suppress the pre-turn "Working…" indicator only while the LIVE setup
    // lifecycle is in flight: the open (current) window has a workspace still
    // `setting-up`, so the card itself stands in for the awaited turn. Two
    // guards matter:
    //  - `row.isActive` (NOT the row state): a window closed by a boundary
    //    (`worktree.missing` / re-bind) can be stranded at `setting-up` when the
    //    worktree vanished mid-setup, and that historical card must never gate a
    //    later normal turn.
    //  - per-workspace `setting-up` (NOT the rolled-up `aggregate.state`): the
    //    rollup ranks `failed` above `setting-up`, so a multi-repo window with
    //    one failed + one still-running repo rolls up to `failed`; keying off the
    //    aggregate would wrongly un-suppress the indicator while a repo is still
    //    in flight (a stray "Working…" beside the live card).
    const setupGating = setupCardRows.some(
      (row) =>
        row.isActive &&
        row.model.workspaces.some(
          (workspace) =>
            workspace.state === "creating" || workspace.state === "setting-up",
        ),
    );
    const trailing = setupGating
      ? []
      : renderPendingRunIndicator({
          activeRunState,
          activeTurnId,
          activeTurnMeta: pendingTurnMeta(activeTurnMetaInput, displayContext),
          turnPauseAccounting,
          rendered: [...persisted, ...activeTurn, ...pending, ...live],
        });

    // Drop a pending optimistic echo whose `messageId` is already persisted.
    // The optimistic "pending" user row and its persisted counterpart share an
    // `id` (the messageId). Setup-gating's long accepted-but-not-running window
    // lets the persisted message arrive (via snapshot) while the pending slot is
    // already orphaned, so without this guard BOTH render (the "double message"
    // bug). The invariant is "pending = not yet persisted" - once a message is
    // persisted, its pending echo is stale and must drop.
    const persistedIds = new Set(
      [...persisted, ...activeTurn].map((message) => message.id),
    );
    const dedupedPending = pending.filter(
      (message) => !persistedIds.has(message.id),
    );

    // `baseRows` = everything that sorts by `createdAt`. Assembled before the
    // cards so the common case can early-out without the anchor machinery.
    const baseRows = [
      ...persisted,
      ...activeTurn,
      ...dedupedPending,
      ...live,
      ...forkedChatLinkMessages,
      ...trailing,
    ];

    // Overwhelmingly common case - this chat has no worktree setup card: a plain
    // `createdAt` sort. Skips the per-render anchor Set/Map/weave entirely. This
    // memo re-runs on every streamed delta, so the no-card path must stay cheap.
    if (setupCardEntries.length === 0) {
      return baseRows.sort((a, b) => a.createdAt - b.createdAt);
    }

    // Pin the chat's GENESIS setup card to the top - but ONLY when window 0 is
    // genuinely the initial worktree, not a creation that happened mid-chat. The
    // discriminator is `hasCreatingEvent`: a window with a `setup.creating` event
    // was announced LIVE during a conversation send. A window with NO creating
    // event is the back-filled genesis worktree (epic-create / catch-up at
    // chat-attach), whose `createdAt` can be stamped late, so it pins to the top
    // where the genesis belongs.
    const pinGenesisCard = !setupCardEntries[0].hasCreatingEvent;

    // Every OTHER (mid-chat) setup card anchors DIRECTLY above the user message
    // whose send created it - by message id (`anchorId`), NOT `createdAt`. The
    // card is broadcast before the slow `git worktree add` while its message
    // persists only AFTER the add, so a timestamp sort would drop the card below
    // the message and then jump it above once the persisted message lands.
    // Anchoring by id keeps the card pinned immediately above its message across
    // the optimistic-echo -> persisted-message swap (both share the id).
    const baseIds = new Set(baseRows.map((message) => message.id));
    const cardsByAnchor = new Map<string, ChatMessageModel[]>();
    const floatingCards: ChatMessageModel[] = [];
    setupCardEntries.forEach((entry, index) => {
      if (pinGenesisCard && index === 0) return;
      // Anchor only when the triggering message is an actual transcript row. It
      // is NOT for: a send still QUEUED behind an active turn (rendered as a
      // queue item, not a row), a STEERED send (nested inside its turn), or a
      // message later BRANCHED/DELETED away. Those fall back to a `createdAt`
      // float so the card still renders - near the tail for a fresh creation,
      // chronologically for a historical one - rather than vanishing, and it
      // re-anchors on its own once/if the message becomes a transcript row.
      if (entry.anchorId !== null && baseIds.has(entry.anchorId)) {
        const list = cardsByAnchor.get(entry.anchorId);
        if (list === undefined) {
          cardsByAnchor.set(entry.anchorId, [entry.message]);
        } else {
          list.push(entry.message);
        }
      } else {
        floatingCards.push(entry.message);
      }
    });

    const sorted = [...baseRows, ...floatingCards].sort(
      (a, b) => a.createdAt - b.createdAt,
    );

    // Weave each anchored card in immediately above its message. A push loop
    // (not flatMap) avoids allocating a wrapper array per transcript row.
    let woven: ReadonlyArray<ChatMessageModel> = sorted;
    if (cardsByAnchor.size > 0) {
      const interleaved: ChatMessageModel[] = [];
      for (const message of sorted) {
        const anchored = cardsByAnchor.get(message.id);
        if (anchored !== undefined) interleaved.push(...anchored);
        interleaved.push(message);
      }
      woven = interleaved;
    }
    return pinGenesisCard ? [setupCardEntries[0].message, ...woven] : woven;
  }, [
    persisted,
    activeTurn,
    pending,
    live,
    forkedChatLinkMessages,
    setupCardRows,
    setupCardEntries,
    activeRunState,
    activeTurnId,
    activeTurnMetaInput,
    turnPauseAccounting,
    displayContext,
  ]);
}

function projectActiveTurn(
  activeTurn: ChatActiveTurn | null,
): ActiveTurnProjection {
  if (activeTurn === null) {
    return { turnId: null, metaInput: NO_PENDING_TURN_META_INPUT };
  }
  return {
    turnId: activeTurn.turnId,
    metaInput: {
      harnessId: activeTurn.harnessId,
      model: activeTurn.model,
      reasoningEffort: activeTurn.reasoningEffort,
      serviceTier: activeTurn.serviceTier,
    },
  };
}

/**
 * Project one `SetupCardRow` into a `role: "system"` transcript row carrying the
 * synthetic `setup-card` segment. The row id is keyed on `ownerId` + the
 * window's ordinal (its position in the chronological window list) so it is
 * stable across streamed deltas AND unique even if two lifecycle windows share
 * the same genesis `createdAt` (the genesis alone would collide on the React /
 * virtualizer key). Windows are append-only, so a window's ordinal never shifts.
 * `createdAt` (the window genesis) still drives the stable sort so the card
 * drops at the genesis / re-bind point. Every other `ChatMessage` field is
 * null/empty - the card owns its own rendering.
 */
function buildSetupCardMessage(
  row: SetupCardRow,
  ownerId: string,
  viewTabId: string,
  windowIndex: number,
): ChatMessageModel {
  const id = `setup-card:${ownerId}:${windowIndex}:${row.createdAt}`;
  return {
    id,
    role: "system",
    content: "",
    segments: [
      {
        id: `${id}:card`,
        kind: "setup-card",
        model: row.model,
        viewTabId,
      },
    ],
    structuredContent: null,
    attachments: [],
    settings: null,
    createdAt: row.createdAt,
    completedAt: null,
    persistentMessageId: null,
    senderLabel: null,
    assistantMeta: null,
    statusLabel: null,
    runState: null,
    agentSenderInfo: null,
    agentMessage: null,
    sessionAnchor: null,
    steerBadge: null,
  };
}

function buildForkedChatLinkMessages(
  events: ReadonlyArray<ChatEvent>,
  viewTabId: string,
): ReadonlyArray<ChatMessageModel> {
  return events.flatMap((event) => {
    if (event.type !== "chat.forked") return [];
    const metadata = event.metadata;
    if (metadata === null) return [];
    const sourceChatId = metadataString(metadata, "sourceChatId");
    const sourceHostId = metadataString(metadata, "sourceHostId");
    if (sourceChatId === null || sourceHostId === null) {
      return [];
    }
    const sourceChatTitle =
      metadataString(metadata, "sourceChatTitle") ?? "Untitled chat";
    const id = `forked-chat-link:${event.eventId}`;
    return [
      {
        id,
        role: "system",
        content: "",
        segments: [
          {
            id: `${id}:link`,
            kind: "forked-chat-link",
            viewTabId,
            sourceChatId,
            sourceChatTitle,
            sourceHostId,
          },
        ],
        structuredContent: null,
        attachments: [],
        settings: null,
        createdAt: event.timestamp,
        completedAt: null,
        persistentMessageId: null,
        senderLabel: null,
        assistantMeta: null,
        statusLabel: null,
        runState: null,
        agentSenderInfo: null,
        agentMessage: null,
        sessionAnchor: null,
        steerBadge: null,
      },
    ];
  });
}

function metadataString(
  metadata: NonNullable<ChatEvent["metadata"]>,
  key: string,
): string | null {
  const value = metadata[key];
  if (typeof value !== "string") return null;
  return value.length > 0 ? value : null;
}

/**
 * Build the run-metadata for the pre-turn pending indicator from the active
 * turn's primitive fields, mirroring what `renderAssistantTurnSlice` derives
 * for the live/persisted row so the provider icon + hover tooltip are present
 * during setup too. `null` when no active turn is known yet.
 */
function pendingTurnMeta(
  turn: PendingTurnMetaInput,
  ctx: RenderedMessagesDisplayContext,
): AssistantTurnMeta | null {
  if (turn.harnessId === null) return null;
  const sender: AgentSender = {
    type: "agent",
    harnessId: turn.harnessId,
    agentId: turn.model ?? turn.harnessId,
    displayName: turn.model,
    reply: { expectsReply: false },
  };
  const display = ctx.resolveAgentSenderDisplay(sender);
  return {
    provider: turn.harnessId,
    providerLabel: display.providerLabel,
    modelLabel: display.modelLabel,
    reasoningEffort: turn.reasoningEffort,
    reasoningEffortLabel: ctx.resolveAgentReasoningLabel(
      sender,
      turn.reasoningEffort,
    ),
    serviceTier: turn.serviceTier,
    // Cost is unknown until the turn completes; the pending/live footer omits it.
    costUsd: null,
  };
}

interface AssistantTurnAccumulator {
  messageId: string;
  sender: AgentSender;
  /**
   * Earliest wall-clock the host attributed to this turn. Sourced from
   * `message.startedAt` (schema field, never rewritten); when multiple
   * `AssistantMessage` records share one `turnId`, we take the min so the
   * turn start anchors at the FIRST record, not the most recently coalesced.
   * Null if every contributing record predates the `startedAt` schema field.
   */
  startedAt: number | null;
  /**
   * Latest wall-clock attributed to this turn. Host rewrites per delta on
   * the active record, and may also bump across multiple records sharing a
   * `turnId`; we take the max so `completedAt` reflects the actual turn end,
   * not just the first record's last delta.
   */
  timestamp: number;
  blocks: ContentBlock[];
  blocksVersion: number | null;
  /**
   * Per-turn run metadata mirrored from the contributing `AssistantMessage`
   * records (identical across records of one turn). Drives the elapsed
   * footer's info tooltip. `null` for turns persisted before these fields
   * existed.
   */
  reasoningEffort: string | null;
  serviceTier: string | null;
  /** Cumulative turn cost (USD) from the contributing record's final usage. */
  costUsd: number | null;
}

interface PersistedMessagesRenderInput {
  /** Records whose rows this call emits (one head/tail partition). */
  readonly messages: ReadonlyArray<Message>;
  /**
   * Snapshot-wide user lookup (steered user records render inside assistant
   * turns that may live in the other partition).
   */
  readonly userMessagesById: ReadonlyMap<string, UserMessage>;
  readonly liveAssistant: LiveAssistantMessage | null;
  /**
   * Steered user ids nested inside turns OUTSIDE this partition; their user
   * rows must be skipped here exactly as if the nesting turn were local.
   */
  readonly externallyNestedSteeredMessageIds: ReadonlySet<string>;
  readonly checkpointViews: ReadonlyMap<string, CheckpointManifestView>;
  readonly activeTurnId: string | null;
  readonly activeRunState: ChatMessageRunState | null;
  readonly turnPauseAccounting: ReadonlyMap<string, TurnPauseAccounting>;
  readonly steeredMessageIds: ReadonlySet<string>;
  /**
   * Turn keys to retain in the per-context assistant-turn cache; entries for
   * any other turn are evicted after the walk. Non-null only on the
   * settled-head walk (once per snapshot) - the per-delta tail walk passes
   * `null` so streaming never pays or races the sweep.
   */
  readonly sweepRetainedTurnKeys: ReadonlySet<string> | null;
  readonly ctx: RenderedMessagesDisplayContext;
}

interface RenderLiveAssistantInput {
  readonly liveAssistant: LiveAssistantMessage | null;
  /** Snapshot-wide user lookup for steer rows nested in the live turn. */
  readonly userMessagesById: ReadonlyMap<string, UserMessage>;
  // Whether a persisted assistant message already shares the live turnId; the
  // hook derives this once from the head/tail partition and threads it in so
  // we don't re-scan the snapshot for the same predicate every streamed frame.
  readonly mergesIntoPersisted: boolean;
  readonly checkpointViews: ReadonlyMap<string, CheckpointManifestView>;
  readonly activeRunState: ChatMessageRunState | null;
  readonly turnPauseAccounting: ReadonlyMap<string, TurnPauseAccounting>;
  readonly ctx: RenderedMessagesDisplayContext;
}

function renderPersistedMessages(
  input: PersistedMessagesRenderInput,
): ReadonlyArray<ChatMessageModel> {
  const userCache = userCacheForContext(input.ctx);
  const turnCache = assistantTurnCacheForContext(input.ctx);
  const turnAccumulator = new Map<string, AssistantTurnAccumulator>();
  for (const message of input.messages) {
    if (message.role !== "assistant") continue;
    addAssistantMessageToAccumulator(turnAccumulator, message);
  }
  appendLiveAssistantBlocks(turnAccumulator, input.liveAssistant);
  const userMessagesById = input.userMessagesById;
  const nestedSteeredMessageIds = new Set([
    ...nestedSteeredMessageIdsFromTurns(turnAccumulator, userMessagesById),
    ...input.externallyNestedSteeredMessageIds,
  ]);

  const emittedTurns = new Set<string>();
  const out: ChatMessageModel[] = [];
  // Prefer `assistantMessage.startedAt` (schema field, set at turn-start and
  // never overwritten). Legacy records persisted before that field exists come
  // through as null; for those we fall back to the most recent user-send
  // timestamp (set once at submit, also never rewritten) so the elapsed footer
  // has a meaningful anchor instead of collapsing onto the (per-delta
  // rewritten) `acc.timestamp`. `acc.timestamp` is the last-resort floor.
  let lastUserTimestamp: number | null = null;
  for (const message of input.messages) {
    if (message.role === "user") {
      if (nestedSteeredMessageIds.has(message.messageId)) {
        // A steered user message is a mid-turn interjection rendered INSIDE its
        // assistant turn, not the user-send that triggers a following turn.
        // Updating the fallback anchor here would mis-anchor a later turn's
        // startedAt on the steer instant, so skip it entirely.
        continue;
      }
      lastUserTimestamp = message.timestamp;
      out.push(renderPersistedUserMessage(message, input, userCache));
      continue;
    }
    out.push(
      ...renderPersistedAssistantMessageTurn({
        message,
        input,
        turnAccumulator,
        emittedTurns,
        turnCache,
        userMessagesById,
        lastUserTimestamp,
      }),
    );
  }
  if (input.sweepRetainedTurnKeys !== null) {
    sweepAssistantTurnCache(input.ctx, input.sweepRetainedTurnKeys);
  }
  return out;
}

/**
 * Evict cached turn models whose turns left the transcript (branch edits,
 * deleted messages). Runs once per snapshot, at the end of the settled-head
 * walk (the only caller passing non-null retain keys); without it the
 * per-context cache retains one rendered model array for every turn ever
 * seen, for the tile's whole lifetime.
 */
function sweepAssistantTurnCache(
  ctx: RenderedMessagesDisplayContext,
  retainTurnKeys: ReadonlySet<string>,
): void {
  const turnCache = assistantTurnCacheForContext(ctx);
  for (const key of turnCache.keys()) {
    if (!retainTurnKeys.has(key)) turnCache.delete(key);
  }
}

/**
 * Stable content key for the steered user ids nested inside the active turn
 * (its records plus the live blocks). Those user rows render inside the
 * turn's tail partition, so the settled walk must skip them exactly as if
 * the nesting turn were local. String-keyed so a plain text delta leaves the
 * derived set referentially stable; only a newly landed steer (a rare,
 * discrete event) invalidates the settled head.
 */
function activeTurnSteeredIdsContentKey(
  activeTurnRecords: ReadonlyArray<Message>,
  liveAssistant: LiveAssistantMessage | null,
): string {
  const ids = [
    ...activeTurnRecords.flatMap((message) =>
      message.role === "assistant" ? message.blocks : [],
    ),
    ...(liveAssistant === null ? [] : liveAssistant.blocks),
  ]
    .filter(
      (block): block is Extract<ContentBlock, { type: "steer" }> =>
        block.type === "steer",
    )
    .map((block) => block.messageId);
  return [...new Set(ids)].sort().join("\n");
}

function userMessagesByIdFromMessages(
  messages: ReadonlyArray<Message>,
): ReadonlyMap<string, UserMessage> {
  const usersById = new Map<string, UserMessage>();
  for (const message of messages) {
    if (message.role === "user") {
      usersById.set(message.messageId, message);
    }
  }
  return usersById;
}

function nestedSteeredMessageIdsFromTurns(
  turnAccumulator: ReadonlyMap<string, AssistantTurnAccumulator>,
  userMessagesById: ReadonlyMap<string, UserMessage>,
): ReadonlySet<string> {
  const messageIds = new Set<string>();
  for (const acc of turnAccumulator.values()) {
    for (const block of acc.blocks) {
      if (block.type === "steer" && userMessagesById.has(block.messageId)) {
        messageIds.add(block.messageId);
      }
    }
  }
  return messageIds;
}

function renderPersistedUserMessage(
  message: UserMessage,
  input: PersistedMessagesRenderInput,
  userCache: WeakMap<Message, ChatMessageModel>,
): ChatMessageModel {
  const steerBadge = input.steeredMessageIds.has(message.messageId)
    ? completedSteerBadge(null)
    : null;
  if (steerBadge !== null) {
    return renderUserMessage(message, input.ctx, steerBadge);
  }
  const cached = userCache.get(message);
  if (cached !== undefined) return cached;
  const model = renderUserMessage(message, input.ctx, null);
  userCache.set(message, model);
  return model;
}

interface PersistedAssistantTurnRenderInput {
  readonly message: AssistantMessage;
  readonly input: PersistedMessagesRenderInput;
  readonly turnAccumulator: ReadonlyMap<string, AssistantTurnAccumulator>;
  readonly emittedTurns: Set<string>;
  readonly turnCache: Map<string, AssistantTurnCacheEntry>;
  readonly userMessagesById: ReadonlyMap<string, UserMessage>;
  readonly lastUserTimestamp: number | null;
}

/**
 * Identity of the assistant turn a record contributes to. Records sharing a
 * key accumulate into ONE rendered turn (multi-record turns: subagent flows,
 * legacy/migrated snapshots); legacy records without a `turnId` fall back to
 * their timestamp.
 */
function assistantTurnKey(message: AssistantMessage): string {
  return message.turnId ?? `ts:${message.timestamp}`;
}

function renderPersistedAssistantMessageTurn(
  args: PersistedAssistantTurnRenderInput,
): ReadonlyArray<ChatMessageModel> {
  const { emittedTurns, input, message, turnAccumulator, turnCache } = args;
  const turnKey = assistantTurnKey(message);
  if (emittedTurns.has(turnKey)) return [];
  const acc = turnAccumulator.get(turnKey);
  if (acc === undefined) return [];
  emittedTurns.add(turnKey);

  const checkpointView = input.checkpointViews.get(turnKey) ?? null;
  // The "Changes" group is held back until the assistant turn completes, so
  // the cache key must distinguish active (streaming) from complete turns —
  // otherwise a turn that finishes without a block-status flip keeps the
  // group suppressed.
  const turnComplete = input.activeTurnId !== turnKey;
  const runState = turnComplete ? null : input.activeRunState;
  const pause = input.turnPauseAccounting.get(turnKey) ?? NO_TURN_PAUSE;
  const startedAt = acc.startedAt ?? args.lastUserTimestamp ?? acc.timestamp;
  // Signature includes `acc.timestamp` (when complete) and `startedAt` so a
  // post-completion snapshot re-emit that moves either instant (cloud-sync
  // replica swap, canonicalized timestamps) invalidates the cached model.
  // Without it, a stale `completedAt`/anchor would be served for the lifetime
  // of the ctx.
  const completionToken = turnComplete ? `done:${acc.timestamp}` : "live";
  const cacheKey = [
    acc.messageId,
    turnBlocksSignature(acc),
    checkpointSignature(checkpointView),
    nestedSteeredUsersSignature(acc.blocks, args.userMessagesById),
    completionToken,
    runState ?? "none",
    String(startedAt),
    turnPauseSignature(pause),
  ].join(":");
  const cached = turnCache.get(turnKey);
  if (cached !== undefined && cached.cacheKey === cacheKey) {
    return cached.models;
  }
  const models = renderAssistantTurnRows({
    acc,
    turnKey,
    checkpointView,
    turnComplete,
    runState,
    pause,
    userMessagesById: args.userMessagesById,
    startedAt,
    ctx: input.ctx,
  });
  turnCache.set(turnKey, { cacheKey, models });
  return models;
}

function addAssistantMessageToAccumulator(
  turnAccumulator: Map<string, AssistantTurnAccumulator>,
  message: AssistantMessage,
): void {
  const turnKey = assistantTurnKey(message);
  const existing = turnAccumulator.get(turnKey);
  if (existing !== undefined) {
    existing.blocks.push(...message.blocks);
    existing.blocksVersion = null;
    // A turn split across multiple AssistantMessage records (subagent flows,
    // legacy/migrated snapshots) must merge timestamps, not keep the FIRST
    // record's: completedAt = max(timestamp) so the elapsed reflects the real
    // turn end, and startedAt = min(startedAt) so the anchor is the earliest
    // recorded turn-start. Null `startedAt` (legacy records) loses to a real
    // value via `minNullable`.
    if (message.timestamp > existing.timestamp) {
      existing.timestamp = message.timestamp;
    }
    existing.startedAt = minNullable(existing.startedAt, message.startedAt);
    // Keep the first non-null run metadata; records of one turn agree, and a
    // legacy record's null must not overwrite a real value from a sibling.
    existing.reasoningEffort =
      existing.reasoningEffort ?? message.reasoningEffort;
    existing.serviceTier = existing.serviceTier ?? message.serviceTier;
    // `costUsd` is cumulative-to-turn-end and lands on the completing record,
    // which may be processed after an earlier sibling. Take the LATEST non-null
    // (last-wins) so the final cumulative cost is not pinned to a stale partial.
    existing.costUsd = message.usage?.costUsd ?? existing.costUsd;
    existing.messageId = message.messageId;
    return;
  }
  turnAccumulator.set(turnKey, {
    messageId: message.messageId,
    sender: message.sender,
    startedAt: message.startedAt,
    timestamp: message.timestamp,
    blocks: [...message.blocks],
    blocksVersion: message.blocksVersion ?? null,
    reasoningEffort: message.reasoningEffort,
    serviceTier: message.serviceTier,
    costUsd: message.usage?.costUsd ?? null,
  });
}

function minNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

function appendLiveAssistantBlocks(
  turnAccumulator: Map<string, AssistantTurnAccumulator>,
  liveAssistant: LiveAssistantMessage | null,
): void {
  if (liveAssistant === null) return;
  const acc = turnAccumulator.get(liveAssistant.turnId);
  if (acc === undefined) return;
  acc.blocks.push(...liveAssistant.blocks);
  acc.blocksVersion = null;
}

function turnBlocksSignature(acc: AssistantTurnAccumulator): string {
  if (acc.blocksVersion !== null) return `v:${acc.blocksVersion}`;
  return `h:${turnSignature(acc.blocks)}`;
}

interface AssistantTurnRenderInput {
  readonly acc: AssistantTurnAccumulator;
  readonly turnKey: string;
  readonly checkpointView: CheckpointManifestView | null;
  readonly turnComplete: boolean;
  readonly runState: ChatMessageRunState | null;
  readonly pause: TurnPauseAccounting;
  readonly userMessagesById: ReadonlyMap<string, UserMessage>;
  /**
   * Wall-clock turn start used to anchor `createdAt` on EVERY row this turn
   * emits (assistant slices and nested steer rows alike). A single per-turn
   * anchor keeps the turn's rows contiguous under the stable `createdAt` sort
   * (intra-turn order falls out of push order) and lets the final assistant
   * slice's `completedAt - createdAt` measure the whole turn, not just its
   * trailing chunk.
   */
  readonly startedAt: number;
  readonly ctx: RenderedMessagesDisplayContext;
}

type AssistantTurnTimelineEntry = {
  readonly kind: "block";
  readonly block: ContentBlock;
  readonly timestamp: number;
  readonly order: number;
};

function renderAssistantTurnRows(
  input: AssistantTurnRenderInput,
): ReadonlyArray<ChatMessageModel> {
  const entries = assistantTurnTimelineEntries(input.acc.blocks);
  const split = entries.some(entrySplitsAssistantTurn);
  const rows: ChatMessageModel[] = [];
  let chunk: ContentBlock[] = [];
  let chunkIndex = 0;

  const flushChunk = (): void => {
    if (chunk.length === 0) return;
    rows.push(
      renderAssistantTurnSlice({
        acc: input.acc,
        turnKey: input.turnKey,
        checkpointView: input.checkpointView,
        turnComplete: input.turnComplete,
        runState: split ? null : input.runState,
        pause: input.pause,
        ctx: input.ctx,
        blocks: chunk,
        chunkIndex,
        split,
        createdAt: input.startedAt,
      }),
    );
    chunk = [];
    chunkIndex += 1;
  };

  for (const entry of entries) {
    if (entry.block.type === "steer") {
      flushChunk();
      // Anchor the nested steer row at the turn start too, so it stays
      // contiguous with its surrounding slices under the stable `createdAt`
      // sort instead of jumping out by its own block timestamp.
      rows.push({
        ...renderSteerBlockUserMessage(
          entry.block,
          input.ctx,
          input.userMessagesById.get(entry.block.messageId) ?? null,
        ),
        createdAt: input.startedAt,
      });
      continue;
    }
    chunk.push(entry.block);
  }
  flushChunk();

  if (rows.length === 0 && !split) {
    return withTurnCompletion(
      [
        renderAssistantTurnSlice({
          acc: input.acc,
          turnKey: input.turnKey,
          checkpointView: input.checkpointView,
          turnComplete: input.turnComplete,
          runState: input.runState,
          pause: input.pause,
          ctx: input.ctx,
          blocks: [],
          chunkIndex: 0,
          split: false,
          createdAt: input.startedAt,
        }),
      ],
      input,
    );
  }

  if (split) {
    return withTurnCompletion(
      attachRunStateToTrailingAssistantSlice(rows, input, chunkIndex),
      input,
    );
  }
  return withTurnCompletion(rows, input);
}

/**
 * Stamp `completedAt` onto the LAST assistant row of a completed turn so the
 * "Worked for Nm Xs" footer renders once, on the turn's final slice, measuring
 * the whole turn (every row already anchors `createdAt` at the turn start).
 * Live turns get `null` so the footer stays hidden until completion.
 */
function withTurnCompletion(
  rows: ReadonlyArray<ChatMessageModel>,
  input: AssistantTurnRenderInput,
): ReadonlyArray<ChatMessageModel> {
  if (!input.turnComplete) return rows;
  const lastAssistantIndex = lastAssistantRowIndex(rows);
  if (lastAssistantIndex === -1) return rows;
  return rows.map((row, index) =>
    index === lastAssistantIndex
      ? { ...row, completedAt: input.acc.timestamp }
      : row,
  );
}

function entrySplitsAssistantTurn(entry: AssistantTurnTimelineEntry): boolean {
  return entry.block.type === "steer";
}

interface AssistantTurnSliceRenderInput {
  readonly acc: AssistantTurnAccumulator;
  readonly turnKey: string;
  readonly checkpointView: CheckpointManifestView | null;
  readonly turnComplete: boolean;
  readonly runState: ChatMessageRunState | null;
  readonly pause: TurnPauseAccounting;
  readonly ctx: RenderedMessagesDisplayContext;
  readonly blocks: ReadonlyArray<ContentBlock>;
  readonly chunkIndex: number;
  readonly split: boolean;
  readonly createdAt: number | null;
}

function renderAssistantTurnSlice(
  input: AssistantTurnSliceRenderInput,
): ChatMessageModel {
  const agentSender = input.ctx.resolveAgentSenderDisplay(input.acc.sender);
  const assistantMeta: AssistantTurnMeta = {
    provider: input.acc.sender.harnessId,
    providerLabel: agentSender.providerLabel,
    modelLabel: agentSender.modelLabel,
    reasoningEffort: input.acc.reasoningEffort,
    reasoningEffortLabel: input.ctx.resolveAgentReasoningLabel(
      input.acc.sender,
      input.acc.reasoningEffort,
    ),
    serviceTier: input.acc.serviceTier,
    costUsd: input.acc.costUsd,
  };
  const firstBlock = input.blocks.at(0) ?? null;
  const createdAt =
    input.createdAt !== null
      ? input.createdAt
      : (firstBlock?.timestamp ?? input.acc.timestamp);
  return {
    id: assistantSliceRowId(input.turnKey, input.chunkIndex, input.split),
    role: "assistant",
    content: input.ctx.contentBlocksText(input.blocks),
    segments: buildAssistantSegments(
      input.blocks,
      input.checkpointView,
      input.turnComplete,
    ),
    structuredContent: null,
    attachments: [],
    settings: null,
    createdAt,
    // Stamped onto the turn's last slice by `withTurnCompletion`; null on
    // every other slice and while the turn is still live.
    completedAt: null,
    pausedDurationMs: input.pause.pausedDurationMs,
    pausedSinceMs: input.pause.pausedSinceMs,
    persistentMessageId: input.acc.messageId,
    // Assistant rows render no provider/model label above the bubble (it moved
    // to the elapsed-footer hover, which reads `assistantMeta`), so there's no
    // sender label to carry here.
    senderLabel: null,
    assistantMeta,
    statusLabel: null,
    agentSenderInfo: null,
    agentMessage: null,
    runState: input.runState,
    sessionAnchor: null,
    steerBadge: null,
  };
}

function attachRunStateToTrailingAssistantSlice(
  rows: ReadonlyArray<ChatMessageModel>,
  input: AssistantTurnRenderInput,
  nextChunkIndex: number,
): ReadonlyArray<ChatMessageModel> {
  if (input.runState === null) return rows;
  const lastAssistantIndex = lastAssistantRowIndex(rows);
  if (lastAssistantIndex === rows.length - 1) {
    return rows.map((row, index) =>
      index === lastAssistantIndex ? { ...row, runState: input.runState } : row,
    );
  }
  const createdAt =
    rows.reduce((latest, row) => Math.max(latest, row.createdAt), 0) + 1;
  return [
    ...rows,
    renderAssistantTurnSlice({
      acc: input.acc,
      turnKey: input.turnKey,
      checkpointView: input.checkpointView,
      turnComplete: input.turnComplete,
      runState: input.runState,
      pause: input.pause,
      ctx: input.ctx,
      blocks: [],
      chunkIndex: nextChunkIndex,
      split: true,
      createdAt,
    }),
  ];
}

function lastAssistantRowIndex(rows: ReadonlyArray<ChatMessageModel>): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.role === "assistant") return index;
  }
  return -1;
}

function assistantTurnTimelineEntries(
  blocks: ReadonlyArray<ContentBlock>,
): ReadonlyArray<AssistantTurnTimelineEntry> {
  return blocks.map((block, index) => ({
    kind: "block",
    block,
    timestamp: block.timestamp,
    order: index * 2,
  }));
}

function renderSteerBlockUserMessage(
  block: Extract<ContentBlock, { type: "steer" }>,
  ctx: RenderedMessagesDisplayContext,
  userMessage: UserMessage | null,
): ChatMessageModel {
  if (userMessage !== null) {
    return renderUserMessage(userMessage, ctx, completedSteerBadge(block.mode));
  }
  return renderSteeredUserMessage({
    id: queueSteerRowId(block.queueItemId),
    content: block.content,
    timestamp: block.timestamp,
    persistentMessageId: null,
    sender: null,
    senderLabel: null,
    settings: null,
    steerBadge: {
      status: "steered",
      mode: block.mode,
    },
  });
}

function renderSteeredUserMessage(input: {
  readonly id: string;
  readonly content: ChatQueuedItem["message"]["content"];
  readonly timestamp: number;
  readonly persistentMessageId: string | null;
  readonly sender: UserMessageSender | null;
  readonly senderLabel: string | null;
  readonly settings: ChatMessageModel["settings"];
  readonly steerBadge: ChatMessageSteerBadge;
}): ChatMessageModel {
  const text = extractPlainTextFromComposerJSONContent(input.content);
  return {
    id: input.id,
    role: "user",
    content: text,
    segments:
      text.length > 0
        ? [
            {
              id: `${input.id}:text`,
              kind: "text",
              markdown: text,
              isStreaming: false,
            },
          ]
        : [],
    structuredContent: input.content,
    attachments: buildAttachmentsFromJSONContent(input.content),
    settings: input.settings,
    createdAt: input.timestamp,
    completedAt: null,
    persistentMessageId: input.persistentMessageId,
    senderLabel: input.senderLabel,
    assistantMeta: null,
    statusLabel: null,
    agentSenderInfo:
      input.sender === null ? null : agentSenderInfoFromSender(input.sender),
    agentMessage: null,
    runState: null,
    sessionAnchor: null,
    steerBadge: input.steerBadge,
  };
}

/**
 * Surface inter-agent provenance for a `role: "user"` row whose sender
 * is another agent (via `agent.sendMessage`). The receiver GUI uses
 * this to style the row distinctly from a human-authored message and
 * to render the "from agent / reply with `traycer agent send`" footer.
 * Returns `null` for human senders.
 */
function agentSenderInfoFromSender(
  sender: UserMessageSender,
): ChatMessageModel["agentSenderInfo"] {
  if (sender.type !== "agent") return null;
  return {
    agentId: sender.agentId,
    senderTitle: sender.displayName,
    expectReply: sender.reply.expectsReply,
    responseId: sender.reply.expectsReply ? sender.reply.responseId : null,
  };
}

function renderUserMessage(
  message: UserMessage,
  ctx: RenderedMessagesDisplayContext,
  steerBadge: ChatMessageSteerBadge | null,
): ChatMessageModel {
  const text = extractPlainTextFromComposerJSONContent(message.message.content);
  return {
    id: message.messageId,
    role: "user",
    content: text,
    segments:
      text.length > 0
        ? [
            {
              id: `${message.messageId}:text`,
              kind: "text",
              markdown: text,
              isStreaming: false,
            },
          ]
        : [],
    structuredContent: message.message.content,
    attachments: buildAttachmentsFromJSONContent(message.message.content),
    settings: null,
    createdAt: message.timestamp,
    completedAt: null,
    persistentMessageId: message.messageId,
    senderLabel: ctx.resolveUserSenderLabel(message.sender),
    assistantMeta: null,
    statusLabel: null,
    agentSenderInfo: agentSenderInfoFromSender(message.sender),
    agentMessage: message.message.kind === "agent" ? message.message : null,
    runState: null,
    sessionAnchor: message.sessionAnchor,
    steerBadge,
  };
}

function renderPendingUserMessage(
  message: PendingUserMessage,
  ctx: RenderedMessagesDisplayContext,
): ChatMessageModel {
  const text = extractPlainTextFromComposerJSONContent(message.content);
  return {
    // Key by `messageId` (not `clientActionId`) so a pending/seeded message and
    // its persisted counterpart share a row key - the snapshot reconciliation
    // then updates the row in place instead of remounting it (no flicker).
    id: message.messageId,
    role: "user",
    content: text,
    segments:
      text.length > 0
        ? [
            {
              id: `${message.messageId}:text`,
              kind: "text",
              markdown: text,
              isStreaming: false,
            },
          ]
        : [],
    structuredContent: message.content,
    attachments: buildAttachmentsFromJSONContent(message.content),
    settings: message.settings,
    createdAt: message.timestamp,
    completedAt: null,
    persistentMessageId: null,
    senderLabel: ctx.resolveUserSenderLabel(message.sender),
    assistantMeta: null,
    statusLabel: "Pending",
    agentSenderInfo: agentSenderInfoFromSender(message.sender),
    agentMessage: null,
    runState: null,
    sessionAnchor: null,
    steerBadge: null,
  };
}

function renderLiveAssistant(
  input: RenderLiveAssistantInput,
): ReadonlyArray<ChatMessageModel> {
  const liveAssistant = input.liveAssistant;
  if (liveAssistant === null) return [];
  // The live row merges INTO a persisted turn (rendered there) when one already
  // shares its turnId; in that case it isn't rendered standalone here.
  if (input.mergesIntoPersisted) {
    return [];
  }
  return renderAssistantTurnRows({
    acc: {
      messageId: transientLiveAssistantMessageId(liveAssistant.turnId),
      sender: liveAssistant.sender,
      startedAt: liveAssistant.startedAt,
      timestamp: liveAssistant.timestamp,
      blocks: [...liveAssistant.blocks],
      blocksVersion: liveAssistant.blocksVersion,
      reasoningEffort: liveAssistant.reasoningEffort,
      serviceTier: liveAssistant.serviceTier,
      // A live turn has no final cost yet; it surfaces once the turn completes
      // and re-renders via the persisted path. The live footer is suppressed.
      costUsd: null,
    },
    turnKey: liveAssistant.turnId,
    checkpointView: input.checkpointViews.get(liveAssistant.turnId) ?? null,
    // Live turn is by definition still streaming — hold back the group.
    turnComplete: false,
    // Track the host's run state exactly: a live row lingering for one frame
    // after the turn completes (runStatus idle) must not show a spinner.
    runState: input.activeRunState,
    pause: input.turnPauseAccounting.get(liveAssistant.turnId) ?? NO_TURN_PAUSE,
    userMessagesById: input.userMessagesById,
    // Anchor on the turn-start (mirrors `ChatActiveTurn.startedAt`, set once at
    // turn-start) so the live row sorts at the same `createdAt` the persisted
    // form will use post-swap - prevents a sort-position jump at
    // live→persisted reconciliation.
    startedAt: liveAssistant.startedAt,
    ctx: input.ctx,
  }).map((message) =>
    message.role === "assistant"
      ? { ...message, statusLabel: "Streaming" }
      : message,
  );
}

/**
 * Synthesizes the trailing pending-assistant row for the pre-turn window - when
 * the host's `runStatus` is `running`/`stopping` but no assistant turn has
 * materialized yet. Returns `[]` once any in-progress assistant row exists (the
 * live row or a persisted active turn already carries the indicator) or when
 * the chat is idle. It uses the active turn id when available, falling back to
 * `LIVE_ASSISTANT_ROW_ID` only for the short window before the turn id lands.
 */
function renderPendingRunIndicator(input: {
  readonly activeRunState: ChatMessageRunState | null;
  readonly activeTurnId: string | null;
  readonly activeTurnMeta: AssistantTurnMeta | null;
  readonly turnPauseAccounting: ReadonlyMap<string, TurnPauseAccounting>;
  readonly rendered: ReadonlyArray<ChatMessageModel>;
}): ReadonlyArray<ChatMessageModel> {
  const {
    activeRunState,
    activeTurnId,
    activeTurnMeta,
    turnPauseAccounting,
    rendered,
  } = input;
  if (activeRunState === null) return [];
  const hasInProgressAssistant = rendered.some(
    (message) => message.role === "assistant" && message.runState !== null,
  );
  if (hasInProgressAssistant) return [];
  const latestCreatedAt = rendered.reduce(
    (max, message) => Math.max(max, message.createdAt),
    0,
  );
  const pause =
    activeTurnId === null
      ? NO_TURN_PAUSE
      : (turnPauseAccounting.get(activeTurnId) ?? NO_TURN_PAUSE);
  return [
    {
      id:
        activeTurnId === null
          ? LIVE_ASSISTANT_ROW_ID
          : assistantRowId(activeTurnId),
      role: "assistant",
      content: "",
      segments: [],
      structuredContent: null,
      attachments: [],
      settings: null,
      createdAt: latestCreatedAt + 1,
      completedAt: null,
      pausedDurationMs: pause.pausedDurationMs,
      pausedSinceMs: pause.pausedSinceMs,
      persistentMessageId: null,
      senderLabel: null,
      assistantMeta: activeTurnMeta,
      statusLabel: "Streaming",
      runState: activeRunState,
      agentSenderInfo: null,
      agentMessage: null,
      sessionAnchor: null,
      steerBadge: null,
    },
  ];
}

function assistantRowId(turnKey: string): string {
  return `assistant:${turnKey}`;
}

function assistantSliceRowId(
  turnKey: string,
  chunkIndex: number,
  split: boolean,
): string {
  if (!split) return assistantRowId(turnKey);
  return `${assistantRowId(turnKey)}:part:${chunkIndex}`;
}

function queueSteerRowId(queueItemId: string): string {
  return `steer:${queueItemId}`;
}

function buildAssistantSegments(
  blocks: ReadonlyArray<ContentBlock>,
  checkpointView: CheckpointManifestView | null,
  turnComplete: boolean,
): ReadonlyArray<MessageSegment> {
  const flat: MessageSegment[] = [];
  for (const block of blocks) {
    const segment = blockToSegment(block);
    if (segment !== null) {
      flat.push(segment);
    }
  }
  const nested = nestSubagentChildren(flat);
  const visible = suppressAuthErrors(
    suppressEditToolCalls(suppressSubagentSpawnToolCalls(nested)),
  );
  // The card's merged change rides on the `artifact_operation` block itself
  // (set at emit from the turn's checkpoint builder), so no manifest enrichment
  // is needed for the card - it's available the moment the edit completes.
  return groupFileChangeRuns(visible, checkpointView, turnComplete);
}

// Artifact rows for a turn's "Changes" group, from the manifest's tagged
// entries (one entry per artifact index.md). One row per artifact, carrying the
// merged before/after hashes for a click → diff.
function artifactChangeRowsFromManifest(
  manifest: TurnCheckpointManifest | null,
): ArtifactChangeRow[] {
  if (manifest === null) return [];
  return manifest.entries.flatMap((entry) => {
    if (!entry.artifact) return [];
    // A net-zero artifact (touched but left byte-identical this turn) is not a
    // change - drop it so the "Changes" group matches the Undo modal / restore,
    // mirroring the equal-hash drop the file side does in mergeFileChangesByPath.
    if (isNoOpCheckpointEntry(entry)) return [];
    return [
      {
        artifactId: entry.artifact.artifactId,
        artifactKind: entry.artifact.kind,
        title: entry.artifact.title,
        operation: entry.operation,
        filePath: entry.filePath,
        beforeHash: entry.beforeHash,
        afterHash: entry.afterHash,
      },
    ];
  });
}

/**
 * Drop `error` segments tagged `code: "auth"`. A signed-out provider is a
 * connection condition surfaced live above the composer (the re-auth banner),
 * not a transcript row - so the failed turn collapses to an empty slice instead
 * of leaving a scary red error card. An auth-only turn renders zero segments.
 */
function suppressAuthErrors<T extends MessageSegment>(
  flat: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return flat.filter(
    (s) => !(s.kind === "error" && s.code === AUTH_ERROR_CODE),
  );
}

function isSubagentChildSegment(
  segment: MessageSegment,
): segment is SubagentChildSegment {
  // artifact_operation is intentionally excluded — artifact cards stay
  // top-level (see the BLOCK_HANDLERS["artifact_operation"] handler).
  return (
    segment.kind === "tool" ||
    segment.kind === "file_change" ||
    segment.kind === "command"
  );
}

/**
 * Fold subagent-owned tool/file_change segments into the `children` of their
 * subagent segment so the renderer nests them under that block. Segments whose
 * `parentId` matches a subagent segment are removed from the top-level flow;
 * everything else (including subagent-owned segments with no matching block, in
 * case the subagent.started was dropped) stays top-level. Order is preserved.
 */
function nestSubagentChildren(
  flat: ReadonlyArray<MessageSegment>,
): ReadonlyArray<MessageSegment> {
  const subagentIds = new Set(
    flat.flatMap((segment) =>
      segment.kind === "subagent" ? [segment.id] : [],
    ),
  );
  if (subagentIds.size === 0) return flat;

  const childrenByParent = new Map<string, SubagentChildSegment[]>();
  const topLevel: MessageSegment[] = [];
  for (const segment of flat) {
    if (
      isSubagentChildSegment(segment) &&
      segment.parentId !== null &&
      subagentIds.has(segment.parentId)
    ) {
      const bucket = childrenByParent.get(segment.parentId);
      if (bucket === undefined) {
        childrenByParent.set(segment.parentId, [segment]);
      } else {
        bucket.push(segment);
      }
      continue;
    }
    topLevel.push(segment);
  }
  if (childrenByParent.size === 0) return flat;

  return topLevel.map((segment) => {
    if (segment.kind !== "subagent") return segment;
    const children = childrenByParent.get(segment.id);
    if (children === undefined) return segment;
    return { ...segment, children: coalesceSubagentChildren(children) };
  });
}

/**
 * Prepare a subagent's nested activity for display: drop raw edit tool_calls
 * superseded by their file_change card, then collapse repeated edits to the
 * same file into one row (first edit's pre-state -> last edit's post-state, the
 * net diff) using the same `mergeFileChangesByPath` that powers the top-level
 * "Changes" block. Tool calls and denied/failed edits keep their order and
 * position; the merged file rows land where the first real edit appeared.
 */
function coalesceSubagentChildren(
  children: ReadonlyArray<SubagentChildSegment>,
): ReadonlyArray<SubagentChildSegment> {
  const suppressed = suppressEditToolCalls(children);
  const realChanges = suppressed.filter(
    (segment): segment is FileChangeSegment =>
      segment.kind === "file_change" && isRealFileChange(segment),
  );
  if (realChanges.length <= 1) return suppressed;

  const merged = mergeFileChangesByPath(realChanges);
  let inserted = false;
  const out: SubagentChildSegment[] = [];
  for (const segment of suppressed) {
    if (segment.kind === "file_change" && isRealFileChange(segment)) {
      if (!inserted) {
        out.push(...merged);
        inserted = true;
      }
      continue;
    }
    out.push(segment);
  }
  return out;
}

/**
 * Drop `tool` segments that a sibling segment has superseded - shared by the
 * file-edit and sub-agent-spawn suppression policies so both apply the identical
 * rule. `shouldDrop` decides per tool-call id. Operates on whatever segment list
 * it is given (the top level, or a sub-agent's nested children).
 */
function rejectToolSegments<T extends MessageSegment>(
  segments: ReadonlyArray<T>,
  shouldDrop: (toolSegmentId: string) => boolean,
): ReadonlyArray<T> {
  return segments.filter(
    (segment) => segment.kind !== "tool" || !shouldDrop(segment.id),
  );
}

/**
 * A file-edit tool produces both a `tool_call` block (the raw Edit/Write/
 * apply_patch invocation) and a `file_change` block (the rendered diff /
 * status). We surface the edit through the `file_change` only - uniform across
 * harnesses (Codex never emits the tool_call) and avoids showing the same edit
 * twice. The coordinator names the file_change block `${toolCallId}:...`, so a
 * tool_call is dropped when some file_change's id is prefixed by it.
 */
function suppressEditToolCalls<T extends MessageSegment>(
  flat: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const fileChangeIds = flat.flatMap((segment) =>
    segment.kind === "file_change" ? [segment.id] : [],
  );
  if (fileChangeIds.length === 0) return flat;
  return rejectToolSegments(flat, (toolId) =>
    fileChangeIds.some((id) => id.startsWith(`${toolId}:`)),
  );
}

/**
 * Claude's `Task`/`Agent` spawn tool surfaces BOTH a `tool_call` block (the raw
 * spawn invocation) and a `subagent` block (the card). We surface the spawn
 * through the card only - the same policy `suppressEditToolCalls` applies to
 * file-edit tool calls, and parity with Codex/OpenCode which emit no separate
 * spawn tool call. The subagent block carries its spawning tool_call id as
 * `spawnToolCallId`, so a tool segment owning that id is dropped - both at the
 * top level and inside a sub-agent's nested children (the case where a sub-agent
 * itself spawned a sub-agent). Only suppresses when the card actually renders (a
 * non-rendering subagent leaves no segment, so its spawn tool stays visible as
 * the lone signal).
 */
function suppressSubagentSpawnToolCalls(
  flat: ReadonlyArray<MessageSegment>,
): ReadonlyArray<MessageSegment> {
  const spawnToolCallIds = new Set(
    flat.flatMap((segment) =>
      segment.kind === "subagent" && segment.spawnToolCallId !== null
        ? [segment.spawnToolCallId]
        : [],
    ),
  );
  if (spawnToolCallIds.size === 0) return flat;
  const shouldDrop = (toolId: string): boolean => spawnToolCallIds.has(toolId);
  return rejectToolSegments(flat, shouldDrop).map((segment) =>
    segment.kind === "subagent" && segment.children.length > 0
      ? {
          ...segment,
          children: rejectToolSegments(segment.children, shouldDrop),
        }
      : segment,
  );
}

interface ParsedCheckpointManifest {
  readonly turnId: string;
  readonly manifest: TurnCheckpointManifest;
}

interface CheckpointManifestView {
  readonly manifest: TurnCheckpointManifest;
  readonly hasLaterOverlappingChanges: boolean;
}

function checkpointManifestViewsFromEvents(
  events: ReadonlyArray<ChatEvent>,
): ReadonlyMap<string, CheckpointManifestView> {
  const checkpoints = events.flatMap((event) => {
    const checkpoint = checkpointManifestFromEvent(event);
    return isParsedCheckpointManifest(checkpoint) ? [checkpoint] : [];
  });
  const overlappingCheckpointIds = overlappingCheckpointIdsFor(checkpoints);
  return new Map(
    checkpoints.map((checkpoint) => [
      checkpoint.turnId,
      {
        manifest: checkpoint.manifest,
        hasLaterOverlappingChanges: overlappingCheckpointIds.has(
          checkpoint.manifest.checkpointId,
        ),
      },
    ]),
  );
}

function checkpointManifestFromEvent(
  event: ChatEvent,
): ParsedCheckpointManifest | null {
  if (event.type !== "checkpoint.captured") return null;
  if (event.turnId === null || event.metadata === null) return null;
  const parsed = turnCheckpointManifestSchema.safeParse(event.metadata);
  if (!parsed.success) return null;
  return { turnId: event.turnId, manifest: parsed.data };
}

function isParsedCheckpointManifest(
  value: ParsedCheckpointManifest | null,
): value is ParsedCheckpointManifest {
  return value !== null;
}

function overlappingCheckpointIdsFor(
  checkpoints: ReadonlyArray<ParsedCheckpointManifest>,
): ReadonlySet<string> {
  // Only real changes drive the "modified again in later turns" note:
  // a no-op entry isn't part of this turn's change set and isn't restored,
  // so an overlap with one would make the cumulative warning misleading.
  //
  // Record, per file path, the index of the last checkpoint that touches it.
  // A checkpoint then overlaps iff any path it touches is touched again by a
  // later checkpoint - i.e. that path's last-touch index is past this one.
  // One forward pass plus one scan keeps this O(checkpoints * entries) instead
  // of the quadratic pairwise comparison this hook reran on every event.
  const lastTouchIndexByPath = new Map<string, number>();
  checkpoints.forEach((checkpoint, index) => {
    checkpoint.manifest.entries
      .filter((entry) => !isNoOpCheckpointEntry(entry))
      .forEach((entry) => {
        lastTouchIndexByPath.set(entry.filePath, index);
      });
  });
  return new Set(
    checkpoints.flatMap((checkpoint, index) => {
      const touchedLater = checkpoint.manifest.entries.some(
        (entry) =>
          !isNoOpCheckpointEntry(entry) &&
          (lastTouchIndexByPath.get(entry.filePath) ?? index) > index,
      );
      return touchedLater ? [checkpoint.manifest.checkpointId] : [];
    }),
  );
}

function groupFileChangeRuns(
  flat: ReadonlyArray<MessageSegment>,
  checkpointView: CheckpointManifestView | null,
  turnComplete: boolean,
): ReadonlyArray<MessageSegment> {
  const files = flat.flatMap(fileChangesFromSegment);
  // Artifact rows come from the manifest's tagged entries (no inline
  // file_change segments exist for artifacts), so a turn that only touched
  // artifacts still gets a "Changes" group.
  const artifactRows = artifactChangeRowsFromManifest(
    checkpointView?.manifest ?? null,
  );
  if (files.length === 0 && artifactRows.length === 0) {
    return flat;
  }
  // The aggregated "Changes" block only appears once the turn completes; while
  // streaming the inline file_change rows / artifact cards show the in-progress
  // edits.
  if (!turnComplete) {
    return flat;
  }
  // The file_change rows stay inline (as the per-edit activity); the aggregated
  // "Changes" block is appended in addition. Only *actual* changes are grouped
  // - denied/failed edits never changed the file, so they're not counted as
  // changes (they still show inline with their status). Repeated edits to the
  // same file are merged into a single row whose diff spans the first edit's
  // pre-state to the last edit's post-state.
  const realChanges = mergeFileChangesByPath(files.filter(isRealFileChange));
  if (realChanges.length === 0 && artifactRows.length === 0) {
    return flat;
  }
  const groupId =
    realChanges.length > 0
      ? realChanges[0].id
      : (checkpointView?.manifest.checkpointId ?? artifactRows[0].filePath);
  return [
    ...flat,
    {
      id: `${groupId}:group`,
      kind: "file_change_group",
      files: realChanges,
      artifacts: artifactRows,
      checkpointManifest: checkpointView?.manifest ?? null,
      hasLaterOverlappingChanges:
        checkpointView?.hasLaterOverlappingChanges ?? false,
    },
  ];
}

function fileChangesFromSegment(segment: MessageSegment): FileChangeSegment[] {
  if (segment.kind === "file_change") return [segment];
  if (segment.kind === "subagent") {
    return segment.children.filter(
      (child): child is FileChangeSegment => child.kind === "file_change",
    );
  }
  return [];
}

function mergeFileChangesByPath(
  files: ReadonlyArray<FileChangeSegment>,
): ReadonlyArray<FileChangeSegment> {
  const order: string[] = [];
  const byPath = new Map<string, FileChangeSegment>();
  for (const file of files) {
    const existing = byPath.get(file.filePath);
    if (existing === undefined) {
      order.push(file.filePath);
      byPath.set(file.filePath, file);
      continue;
    }
    byPath.set(file.filePath, {
      ...file,
      id: `${existing.id}+${file.id}`,
      // The merged row spans the path's earliest before → latest after (the
      // `...file` spread already carries `afterHash`); keep the first snapshot's
      // `beforeHash` so an expand reconstructs the full first→last diff.
      beforeHash: existing.beforeHash,
      // Approximate the merged counts by summing the per-edit counts. The exact
      // net diff is recomputed from content when the row is expanded; the
      // collapsed header only needs an indicative magnitude.
      additions: existing.additions + file.additions,
      deletions: existing.deletions + file.deletions,
      sourceBlockIds: mergeSnapshotSourceBlockIds(
        existing.sourceBlockIds,
        file.sourceBlockIds,
      ),
      isStreaming: existing.isStreaming || file.isStreaming,
      // The merged row shows the path's FINAL outcome, so the later edit's
      // end-state wins (the `...file` spread already carries it; stated
      // explicitly here alongside isStreaming so the merge rule is unambiguous).
      endState: file.endState,
    });
  }
  return order.flatMap((path) => {
    const merged = byPath.get(path);
    if (merged === undefined) return [];
    // Net no-op (edited back to the original, or created-then-deleted): the
    // content-addressed endpoints match, so drop the row from the "Changes"
    // group. Equal hashes (incl. both null) ⇒ identical content.
    return merged.beforeHash === merged.afterHash ? [] : [merged];
  });
}

/**
 * True when the file was actually changed (so it belongs in the aggregated
 * "Changes" block). "denied" / "capture_failed" edits never touched the file
 * and stay inline with their status instead.
 */
function isRealFileChange(segment: FileChangeSegment): boolean {
  return segment.reason !== "denied" && segment.reason !== "capture_failed";
}

// Surface the terminal `interrupted`/`superseded` status to action segments so
// they render a neutral "stopped"/"superseded" badge instead of a spinner (the
// turn ended before the block's own completion event arrived). The normal
// streaming/completed/errored lifecycle carries no end-state. Exhaustive switch
// (no default): adding a new block status fails to compile here until it is
// explicitly classified, so a new terminal state can't silently render nothing.
function segmentEndState(status: ContentBlock["status"]): SegmentEndState {
  switch (status) {
    case "interrupted":
    case "superseded":
      return status;
    case "streaming":
    case "completed":
    case "errored":
      return null;
  }
}

/**
 * Total run duration of a finished action block: its immutable `startedAt` (the
 * first event) to its `timestamp` (completion). Only a cleanly COMPLETED block
 * has a meaningful total - a force-finalized (interrupted/superseded) or errored
 * block's `timestamp` is the turn-end, not the real finish, so it returns null
 * and the end-state badge conveys the outcome instead. Null while streaming or
 * for blocks persisted before `startedAt` existed. Shared by the reasoning and
 * sub-agent handlers so their duration semantics stay identical.
 */
function completedDurationMs(
  status: ContentBlock["status"],
  startedAt: number | null,
  timestamp: number,
): number | null {
  if (status !== "completed" || startedAt === null) return null;
  return Math.max(0, timestamp - startedAt);
}

/**
 * Todo-block → item mapping for the rendered todo segment, including the
 * synthetic `${blockId}:item:${index}` id fallback for items persisted
 * without ids.
 */
function todoItemsFromBlock(
  block: Extract<ContentBlock, { type: "todo" }>,
): ReadonlyArray<SegmentTodoItem> {
  return block.items.map((item, index) => ({
    id: item.id ?? `${block.blockId}:item:${index}`,
    status: item.status,
    text: item.text,
    priority: item.priority,
    activeForm: item.activeForm,
  }));
}

function hasSnapshotHash(hash: string | null | undefined): hash is string {
  return hash !== null && hash !== undefined;
}

const BLOCK_HANDLERS: {
  [K in ContentBlock["type"]]: (
    block: Extract<ContentBlock, { type: K }>,
  ) => Omit<MessageSegment, "id"> | null;
} = {
  text: (block) =>
    block.text.length === 0
      ? null
      : {
          kind: "text",
          markdown: block.text,
          isStreaming: block.status === "streaming",
        },
  reasoning: (block) =>
    block.content.length === 0
      ? null
      : {
          kind: "reasoning",
          markdown: block.content,
          isStreaming: block.status === "streaming",
          // `timestamp` is the completion time once finalized; `startedAt` is the
          // immutable first-delta time.
          durationMs: completedDurationMs(
            block.status,
            block.startedAt,
            block.timestamp,
          ),
        },
  tool_call: (block) => ({
    kind: "tool",
    toolName: block.toolName,
    inputSummary: block.inputSummary,
    inputDetail: block.inputDetail,
    taskTodoItems: block.taskTodoItems,
    error: block.error,
    agentMessageSend: block.agentMessageSend,
    isStreaming: block.status === "streaming",
    endState: segmentEndState(block.status),
    progress: block.progress,
    startedAt: block.timestamp,
    parentId: block.parentBlockId ?? null,
  }),
  file_change: (block) => ({
    kind: "file_change",
    filePath: block.filePath,
    operation: block.operation,
    diffSource: block.diffSource,
    beforeHash: block.beforeHash,
    afterHash: block.afterHash,
    additions: block.additions,
    deletions: block.deletions,
    sourceBlockIds: singleSnapshotSourceBlockId(block.blockId),
    reason: block.reason,
    isStreaming: block.status === "streaming",
    endState: segmentEndState(block.status),
    parentId: block.parentBlockId ?? null,
  }),
  command: (block) => ({
    kind: "command",
    command: block.command,
    cwd: block.cwd,
    exitCode: block.exitCode,
    isStreaming: block.status === "streaming",
    endState: segmentEndState(block.status),
    // No command-progress signal today; the field exists for footer symmetry.
    progress: null,
    startedAt: block.timestamp,
    parentId: block.parentBlockId ?? null,
  }),
  subagent: (block) =>
    isRenderableSubAgentBlock(block)
      ? {
          kind: "subagent",
          name: block.name,
          agentType: block.agentType,
          task: block.task,
          progressUpdates: block.progressUpdates,
          result: block.result,
          isStreaming: block.status === "streaming",
          endState: segmentEndState(block.status),
          startedAt: block.startedAt,
          // While streaming the card ticks live from `startedAt`; once cleanly
          // completed it shows the spawn->completion total. An interrupted/
          // superseded card shows only its end-state badge, not a (turn-end-
          // inflated) duration - see completedDurationMs.
          durationMs: completedDurationMs(
            block.status,
            block.startedAt,
            block.timestamp,
          ),
          spawnToolCallId: block.spawnToolCallId ?? null,
          children: [],
        }
      : null,
  approval: (block) => ({
    kind: "approval",
    toolName: block.toolName,
    description: block.description,
    inputSummary: block.inputSummary,
    inputDetail: block.inputDetail,
    decision: block.decision,
  }),
  steer: () => null,
  todo: (block) => ({
    kind: "todo",
    items: todoItemsFromBlock(block),
  }),
  plan: (block) =>
    isRenderablePlanBlock(block)
      ? {
          kind: "plan",
          planId: block.planId,
          planStatus: block.planStatus,
          harnessId: block.harnessId,
          source: block.source,
          title: block.title,
          summary: block.summary,
          markdownPreview: block.markdownPreview,
          fullContentRef: block.fullContentRef,
          steps: block.steps,
          actions: block.actions,
          approvalId: block.approvalId,
          supersededByPlanId: block.supersededByPlanId,
          isStreaming: block.status === "streaming",
          contentIdentity: planContentIdentity(block),
        }
      : null,
  error: (block) => ({
    kind: "error",
    message: block.message,
    recoverable: block.recoverable,
    code: block.code,
  }),
  compaction: (block) => ({
    kind: "compaction",
    status: block.status,
    trigger: block.trigger,
    preTokens: block.preTokens,
    postTokens: block.postTokens,
    durationMs: block.durationMs,
    summary: block.summary,
    error: block.error,
  }),
  interview: (block) => ({
    kind: "interview",
    status: block.status,
    toolName: block.toolName,
    title: block.title,
    description: block.description,
    questions: block.questions,
    answers: block.answers,
    error: block.error,
  }),
  // Artifact-operation cards render top-level regardless of the authoring agent
  // (main or subagent) and are intentionally NOT folded into a subagent's
  // children. Subagent children are summary-only / non-rendered (SubagentSegment
  // does not render them; chat-activity-groups only counts isActivitySegment
  // kinds, which excludes artifact_operation), so nesting would make the card
  // vanish — and these cards are meant to be prominent + clickable semantic
  // outcomes. The block's `parentBlockId` is therefore intentionally not
  // propagated to the segment (it would be dead state).
  artifact_operation: (block) => ({
    kind: "artifact_operation",
    operation: block.operation,
    // `kind` is the segment discriminant, so the artifact's own kind rides as
    // `artifactKind`. Title / status / tombstone are resolved live in the card;
    // block.title is only a fallback for the brief delete tombstone gap.
    artifactKind: block.kind,
    artifactId: block.artifactId,
    title: block.title,
    // The merged change (first-before → last-after) rides on the block itself,
    // set at emit time from the turn's checkpoint builder - so the diff toggle
    // appears the moment the edit completes, not at turn end. Null when
    // uncaptured (bash delete / post-hoc edit).
    change:
      hasSnapshotHash(block.beforeHash) || hasSnapshotHash(block.afterHash)
        ? {
            beforeHash: block.beforeHash ?? null,
            afterHash: block.afterHash ?? null,
          }
        : null,
  }),
};

function planContentIdentity(
  block: Extract<ContentBlock, { type: "plan" }>,
): string {
  if (block.fullContentRef !== null) return block.fullContentRef.hash;
  const planRevision = block.metadata?.["planRevision"];
  if (typeof planRevision === "string" || typeof planRevision === "number") {
    return String(planRevision);
  }
  return String(block.timestamp);
}

function blockToSegment(block: ContentBlock): MessageSegment | null {
  const handler = BLOCK_HANDLERS[block.type] as
    | ((b: ContentBlock) => Omit<MessageSegment, "id"> | null)
    | undefined;
  if (handler === undefined) {
    // Forward-compat: a newer host may emit a block.type the current GUI
    // bundle does not know about. Drop it instead of crashing the chat.
    return null;
  }
  const partial = handler(block);
  if (partial === null) return null;
  return { ...partial, id: block.blockId } as MessageSegment;
}
