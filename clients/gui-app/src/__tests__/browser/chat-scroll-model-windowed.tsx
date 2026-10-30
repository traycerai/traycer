import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useStore } from "zustand";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type {
  ChatActiveTurn,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatLoadRangeRequest } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import { accumulateEvent } from "@traycer/protocol/host/agent/gui/agent-runtime-accumulator";
import {
  buildRowSkeleton,
  transcriptPreviewProjection,
} from "@traycer/protocol/persistence/chat-transcript/build-skeleton";
import {
  buildTranscriptRecordLookup,
  sliceTranscriptRange,
  sliceTranscriptTail,
} from "@traycer/protocol/persistence/chat-transcript/read-range";
import {
  projectTranscriptRows,
  type TranscriptRowDescriptor,
} from "@traycer/protocol/persistence/chat-transcript/row-projection";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import { ChatMessages } from "@/components/chat/chat-messages";
import { buildPinnedTodoRenderState } from "@/components/chat/chat-pinned-todos";
import { queuedPromptMessageIds } from "@/components/chat/chat-queue-utils";
import { withholdUnpaintedRows } from "@/components/chat/chat-special-segment";
import { useSubagentDrillIn } from "@/components/chat/segments/subagent-open-as-chat";
import { TileMinimapScope } from "@/components/epic-canvas/tile-minimap/tile-minimap-scope";
import { foldBackgroundEventRows } from "@/stores/chats/background-event-fold";
import {
  composerTurnStatus,
  resolvedTurnStatus,
} from "@/stores/chats/chat-run-activity";
import {
  createChatSessionStore,
  isWindowedTranscript,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { pendingHydrationRestore } from "@/stores/chats/chat-tab-pending-hydration-restore";
import {
  peekSavedChatTabState,
  saveChatTabState,
  type SavedChatTabScrollState,
} from "@/stores/chats/chat-tab-state-cache";
import { flushChatTabViewportHandoff } from "@/stores/chats/chat-tab-viewport-handoff";
import { useRenderedMessages } from "@/stores/chats/rendered-messages";
import type { OrdinalRange } from "@/stores/chats/transcript-window";
import {
  BROWSER_STREAM_FLUSH_TIMERS,
  createStreamFlushCoordinator,
} from "@/stores/chats/stream-flush-coordinator";
import { createRendererRuntimeEnvironment } from "@/stores/epics/open-epic/runtime/runtime-environment";
import { getProcessMemoryRuntime } from "@/stores/replica-memory/process-memory-accountant";
import { useTileMinimapStore } from "@/stores/tile-minimap";
import {
  EPIC_ID,
  readGeometry,
  readPillShown,
  scrollNode,
  setInstanceLive,
  TASK_ID,
  type HideKind,
} from "./chat-scroll-model-support";

/**
 * THE WINDOWED LINE of `chat-scroll-model.tsx` (`?line=windowed`): the line
 * production renders. The REAL chat session store - production's runtime
 * environment, stream-flush coordinator and memory accountant - is fed by a
 * host double, and its state is projected to `ChatMessages` the way
 * `ChatTileSessionViewBody` does it (`useRenderedMessages` →
 * `withholdUnpaintedRows` → `foldBackgroundEventRows` →
 * `buildPinnedTodoRenderState`), with the props `ChatSessionMessagesSurface`
 * passes: the window, the viewport and find reports wired to the store, its
 * baseline epoch, hydration sequence and cold-rewritten ids.
 *
 * The host double serves what the host serves from the protocol's own
 * functions: the row projection, `buildRowSkeleton`, `sliceTranscriptTail`
 * for the bounded snapshot, `sliceTranscriptRange` for a `loadRange` (sliced
 * when it answers, after `latencyMs`), and `accumulateEvent` for a streaming
 * record. It broadcasts an append in the order the host's append republish
 * does (`windowed-append-republish.test.ts`): the shared frame, the bounded
 * snapshot at the new `rowCount` and the HELD index revision, then the
 * `indexChanged` delta.
 */

const OWNER_ID = "owner-scroll";
const HOST_ID = "host-scroll";
/** One skeleton chunk per this many rows, as the host streams the index. */
const SKELETON_CHUNK_ROWS = 64;

const params = new URLSearchParams(window.location.search);
/**
 * `?shape=longTail`: a long chat whose replies are several parts each, mostly
 * one-liners with a tail of tall ones, so a row's height says little about its
 * byte size and the list's running averages see hydrated and cold rows of
 * very different heights. `?turns=` sets the length (300 for this shape).
 */
const LONG_TAIL = params.get("shape") === "longTail";
const TURNS = Number(params.get("turns") ?? (LONG_TAIL ? 300 : 160));
/**
 * The bounded snapshot's tail budget. Production's is 256 KiB, which over
 * these text-only records would hydrate most of the chat; 16 KiB leaves the
 * last few turns hot and everything above cold, which is what a tool-heavy
 * chat of this length looks like at production's budget.
 */
const TAIL_BYTES = Number(params.get("tailBytes") ?? 16 * 1024);
/** The gap between two skeleton chunks; `?skeletonChunkMs=` slows the index
 *  stream down the way a slow link does. */
const SKELETON_CHUNK_MS = Number(params.get("skeletonChunkMs") ?? 0);

/**
 * The composer dock the transcript scrolls under (`composerOverlayHeight`,
 * which the tile measures off the lower surfaces). It grows with the draft,
 * 130px for one line to 173px at eight, as the real dock does, and returns to
 * one line once the composer clears on send.
 */
const DOCK_ONE_LINE_PX = 130;
const DOCK_EIGHT_LINES_PX = 173;

function dockHeightFor(lines: number): number {
  const extra = Math.min(Math.max(lines, 1), 8) - 1;
  return (
    DOCK_ONE_LINE_PX +
    Math.round((extra * (DOCK_EIGHT_LINES_PX - DOCK_ONE_LINE_PX)) / 7)
  );
}

const SETTINGS: ChatRunSettings = {
  ultracode: false,
  harnessId: "claude",
  model: "claude-sonnet-4-5",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

type UserRecord = Extract<Message, { role: "user" }>;
type AssistantRecord = Extract<Message, { role: "assistant" }>;
type AcceptedMessage = Parameters<
  ChatStreamCallbacks["onMessageAccepted"]
>[0]["message"];

function promptContent(text: string): JsonContent {
  const paragraphs = text.split("\n\n").map((paragraph) => ({
    type: "paragraph",
    content: [{ type: "text", text: paragraph }],
  }));
  return { type: "doc", content: paragraphs };
}

function userRecord(
  messageId: string,
  content: JsonContent,
  timestamp: number,
): UserRecord {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: OWNER_ID },
    message: { kind: "user", content, browserAnnotations: [] },
    timestamp,
    sessionAnchor: null,
  };
}

function acceptedCopy(record: UserRecord): AcceptedMessage {
  return {
    role: "user",
    messageId: record.messageId,
    sender: { type: "user", userId: OWNER_ID },
    message: {
      kind: "user",
      content: record.message.content,
      browserAnnotations: [],
    },
    timestamp: record.timestamp,
    sessionAnchor: null,
  };
}

function textDelta(blockId: string, delta: string, timestamp: number) {
  return { type: "text.delta" as const, blockId, timestamp, delta };
}

function reasoningDelta(blockId: string, delta: string, timestamp: number) {
  return { type: "reasoning.delta" as const, blockId, timestamp, delta };
}

function textCompleted(blockId: string, timestamp: number) {
  return { type: "text.completed" as const, blockId, timestamp };
}

function assistantRecord(
  messageId: string,
  turnId: string,
  timestamp: number,
): AssistantRecord {
  return {
    role: "assistant",
    messageId,
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "claude",
      displayName: "Claude",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: [],
    startedAt: timestamp,
    timestamp,
    turnId,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

function replyText(index: number, paragraphs: number): string {
  return Array.from(
    { length: paragraphs },
    (_unused, paragraph) =>
      `Reply ${String(index)}, paragraph ${String(paragraph + 1)}. ` +
      "The quick brown fox jumps over the lazy dog. ".repeat(6),
  ).join("\n\n");
}

/** A finished reply, written the way the host's accumulator writes one. */
function completedReply(
  messageId: string,
  turnId: string,
  text: string,
  timestamp: number,
): AssistantRecord {
  const blockId = `${messageId}:text`;
  const blocks = accumulateEvent(
    accumulateEvent([], textDelta(blockId, text, timestamp)),
    textCompleted(blockId, timestamp),
  );
  return { ...assistantRecord(messageId, turnId, timestamp), blocks };
}

/**
 * `?splitTurn=` names a turn whose reply is four text blocks, which the list
 * draws as four parts (`assistant:<turn>#<segment>`): a reading position saved
 * inside it names a part, which a cold mount cannot resolve until the turn
 * hydrates. `?inflate=` gives the turn before it that many one-word
 * paragraphs: a row far taller than the byte estimate its placeholder takes.
 */
const SPLIT_TURN = params.has("splitTurn")
  ? Number(params.get("splitTurn"))
  : null;
const INFLATE_PARAGRAPHS = Number(params.get("inflate") ?? 0);
/** `?shortAfterSplit=1`: every turn after the split one is a one-line
 *  question and a one-line reply, so the split turn sits in the last
 *  screenful even while it is a placeholder. */
const SHORT_AFTER_SPLIT = params.get("shortAfterSplit") === "1";

function isShortTurn(turn: number): boolean {
  return SHORT_AFTER_SPLIT && SPLIT_TURN !== null && turn > SPLIT_TURN;
}
/** `?mountLater=1`: the store subscribes at load but the tab opens only when
 *  the probe says so (`mountNow`), the way a tab reopened in a new renderer
 *  session mounts over a window that holds only the bootstrap tail. */
const MOUNT_LATER = params.get("mountLater") === "1";

function splitReply(
  messageId: string,
  turnId: string,
  timestamp: number,
): AssistantRecord {
  let blocks: AssistantRecord["blocks"] = [];
  for (let part = 1; part <= 4; part += 1) {
    const blockId = `${messageId}:text-${String(part)}`;
    const text = Array.from(
      { length: 4 },
      (_unused, paragraph) =>
        `Part ${String(part)}, paragraph ${String(paragraph + 1)}. ` +
        "The quick brown fox jumps over the lazy dog. ".repeat(6),
    ).join("\n\n");
    blocks = accumulateEvent(
      accumulateEvent(blocks, textDelta(blockId, text, timestamp)),
      textCompleted(blockId, timestamp),
    );
  }
  return { ...assistantRecord(messageId, turnId, timestamp), blocks };
}

function replyFor(turn: number, timestamp: number): AssistantRecord {
  const messageId = `message-${String(turn * 2 + 1)}`;
  const turnId = `turn-${String(turn)}`;
  if (turn === SPLIT_TURN) return splitReply(messageId, turnId, timestamp);
  if (
    SPLIT_TURN !== null &&
    turn === SPLIT_TURN - 1 &&
    INFLATE_PARAGRAPHS > 0
  ) {
    const text = Array.from(
      { length: INFLATE_PARAGRAPHS },
      (_unused, line) => `w${String(line)}`,
    ).join("\n\n");
    return completedReply(messageId, turnId, text, timestamp);
  }
  if (isShortTurn(turn)) {
    return completedReply(messageId, turnId, "Short reply.", timestamp);
  }
  const paragraphs = turn % 9 === 4 ? 14 : 1 + ((turn * 7) % 6);
  return completedReply(
    messageId,
    turnId,
    replyText(turn * 2 + 1, paragraphs),
    timestamp,
  );
}

function seeded(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

function longTailSegment(
  rand: () => number,
  turn: number,
  segment: number,
): string {
  const r = rand();
  if (r < 0.6) return `Step ${String(turn)}.${String(segment)}: checked it.`;
  if (r < 0.85) {
    return Array.from(
      { length: 2 + Math.floor(rand() * 3) },
      (_unused, paragraph) =>
        `Turn ${String(turn)} part ${String(segment)} paragraph ${String(paragraph + 1)}. ` +
        "The quick brown fox jumps over the lazy dog. ".repeat(
          3 + Math.floor(rand() * 5),
        ),
    ).join("\n\n");
  }
  if (r < 0.95) {
    return Array.from(
      { length: 8 + Math.floor(rand() * 7) },
      (_unused, paragraph) =>
        `Long ${String(turn)}.${String(segment)} paragraph ${String(paragraph + 1)}. ` +
        "The quick brown fox jumps over the lazy dog. ".repeat(6),
    ).join("\n\n");
  }
  return Array.from(
    { length: 30 },
    (_unused, item) => `- item ${String(item)}`,
  ).join("\n");
}

/** A `?shape=longTail` reply: up to eight text parts, each after a short
 *  reasoning block, drawn from a fixed per-turn seed. */
function longTailReply(turn: number, timestamp: number): AssistantRecord {
  const messageId = `message-${String(turn * 2 + 1)}`;
  const turnId = `turn-${String(turn)}`;
  const rand = seeded(turn * 7919 + 17);
  const segments = 1 + Math.floor(Math.pow(rand(), 2) * 8);
  let blocks: AssistantRecord["blocks"] = [];
  for (let segment = 0; segment < segments; segment += 1) {
    const reasoningId = `${messageId}:reasoning-${String(segment)}`;
    blocks = accumulateEvent(
      accumulateEvent(
        blocks,
        reasoningDelta(
          reasoningId,
          `Thinking about step ${String(segment)}.`,
          timestamp,
        ),
      ),
      { type: "reasoning.completed" as const, blockId: reasoningId, timestamp },
    );
    const textId = `${messageId}:text-${String(segment)}`;
    blocks = accumulateEvent(
      accumulateEvent(
        blocks,
        textDelta(textId, longTailSegment(rand, turn, segment), timestamp),
      ),
      textCompleted(textId, timestamp),
    );
  }
  return { ...assistantRecord(messageId, turnId, timestamp), blocks };
}

/** Varied heights: one to six paragraphs, and every ninth reply a long one. */
function initialRecords(): Message[] {
  return Array.from({ length: TURNS }, (_unused, turn) => {
    const timestamp = 1_000 + turn * 10;
    return [
      userRecord(
        `message-${String(turn * 2)}`,
        promptContent(
          isShortTurn(turn)
            ? `Question ${String(turn)}`
            : `Question ${String(turn)}: ${"what about this? ".repeat(1 + (turn % (LONG_TAIL ? 3 : 5)))}`,
        ),
        timestamp,
      ),
      LONG_TAIL
        ? longTailReply(turn, timestamp + 1)
        : replyFor(turn, timestamp + 1),
    ];
  }).flat();
}

function sameEntry(a: RowSkeletonEntry, b: RowSkeletonEntry): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface PendingSend {
  readonly messageId: string;
  readonly clientActionId: string;
  readonly content: JsonContent;
}

/**
 * The host's side of one chat on the windowed line. Its records are the
 * transcript; every frame it sends is derived from them at send time.
 */
class WindowedHostDouble {
  private records: Message[] = initialRecords();
  private callbacks: ChatStreamCallbacks | null = null;
  private readonly epoch = 1;
  /** This subscriber's index revision: `null` until the bootstrap stream. */
  private indexRevision: number | null = null;
  private skeleton: readonly RowSkeletonEntry[] = [];
  private activeTurnId: string | null = null;
  private activeUserMessageId: string | null = null;
  /** The running turn's reply while only its deltas have been sent. */
  private unwritten: AssistantRecord | null = null;
  private latencyMs = 120;
  private clock = 2_000_000;
  private readonly unaccepted: PendingSend[] = [];
  private readonly startedAt = performance.now();
  readonly log: string[] = [];

  attach(callbacks: ChatStreamCallbacks): void {
    this.callbacks = callbacks;
  }

  setLatency(ms: number): void {
    this.latencyMs = ms;
  }

  private cb(): ChatStreamCallbacks {
    if (this.callbacks === null) throw new Error("the store has no stream");
    return this.callbacks;
  }

  private note(line: string): void {
    this.log.push(
      `${(performance.now() - this.startedAt).toFixed(0)}ms ${line}`,
    );
  }

  private now(): number {
    this.clock += 1;
    return this.clock;
  }

  private rows(): readonly TranscriptRowDescriptor[] {
    return projectTranscriptRows({
      messages: this.records,
      events: [],
      activeTurnId: this.activeTurnId,
      chatId: TASK_ID,
    });
  }

  private buildSkeleton(): readonly RowSkeletonEntry[] {
    return buildRowSkeleton(
      {
        messages: this.records,
        events: [],
        activeTurnId: this.activeTurnId,
        chatId: TASK_ID,
      },
      transcriptPreviewProjection,
      null,
    );
  }

  private activeTurn(): ChatActiveTurn | null {
    if (this.activeTurnId === null || this.activeUserMessageId === null) {
      return null;
    }
    return {
      agentMode: "regular",
      sameTurnSteeringSupported: false,
      turnId: this.activeTurnId,
      status: "running",
      harnessId: "claude",
      model: "claude-sonnet-4-5",
      profileId: null,
      userMessageId: this.activeUserMessageId,
      startedAt: this.clock,
      updatedAt: this.clock,
      reasoningEffort: null,
      serviceTier: null,
    };
  }

  /** The bounded snapshot, at the subscriber's CURRENT revision. */
  private sendSnapshot(): void {
    const rows = this.rows();
    const lookup = buildTranscriptRecordLookup(this.records, []);
    const tail = sliceTranscriptTail(rows, lookup, TAIL_BYTES, null);
    const activeTurn = this.activeTurn();
    this.note(
      `snapshot rowCount=${String(rows.length)} rev=${String(this.indexRevision)} tail=[${String(tail.fromOrdinal)},${String(rows.length)})`,
    );
    this.cb().onWindowedSnapshot({
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: TASK_ID,
      snapshot: {
        chat: {
          id: TASK_ID,
          parentId: null,
          userId: OWNER_ID,
          hostId: HOST_ID,
          title: "Chat scroll model",
          createdAt: 1,
          updatedAt: 1,
          isTitleEditedByUser: false,
          settings: null,
          archivedAt: null,
          lastDeliveredRolesDigest: null,
          activeSessionChain: null,
          claudePendingWakes: [],
          pinnedUserProviderHandle: null,
        },
        access: { role: "owner", ownerUserId: OWNER_ID, canAct: true },
        queue: { status: "idle", items: [] },
        runStatus: activeTurn === null ? "idle" : "running",
        activeTurn,
        pendingApprovals: [],
        pendingInterviews: [],
        worktreeBinding: null,
        missingWorktreePaths: [],
        pendingFileEditApprovals: [],
        accumulatedFileChangeCount: 0,
        managedCommands: [],
        heldUpdates: [],
        portForwards: [],
        transcriptEpoch: this.epoch,
        rowCount: rows.length,
        indexRevision: this.indexRevision,
        tail: {
          fromOrdinal: tail.fromOrdinal,
          rowIds: [...tail.rowIds],
          incompleteRowIds: [...tail.incompleteRowIds],
          messages: [...tail.messages],
          events: [...tail.events],
          rowContext: tail.rowContext,
        },
        derived: {
          latestAssistantUsage: null,
          pinnedTodo: null,
          pinnedTaskTodoItems: [],
          latestForkableAssistantMessageId: null,
          restorableSetupInterruption: null,
          interviewAnswerability: [],
          latestAssistantAuthFailureTurnKey: null,
          setupCardWindows: [],
        },
      },
    });
  }

  /** Subscribe: the bounded snapshot, then the skeleton in chunks. */
  bootstrap(): void {
    this.cb().onConnectionStatus("open", null, null);
    this.indexRevision = null;
    this.sendSnapshot();
    this.skeleton = this.buildSkeleton();
    const skeleton = this.skeleton;
    const chunk = (fromOrdinal: number): void => {
      const toOrdinal = Math.min(
        skeleton.length,
        fromOrdinal + SKELETON_CHUNK_ROWS,
      );
      const isFinal = toOrdinal >= skeleton.length;
      this.note(
        `skeletonChunk [${String(fromOrdinal)},${String(toOrdinal)}) final=${String(isFinal)}`,
      );
      this.cb().onSkeletonChunk({
        kind: "skeletonChunk",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: TASK_ID,
        chunk: {
          epoch: this.epoch,
          fromOrdinal,
          entries: skeleton.slice(fromOrdinal, toOrdinal),
          isFinal,
        },
      });
      if (isFinal) {
        this.indexRevision = 0;
        return;
      }
      window.setTimeout(() => chunk(toOrdinal), SKELETON_CHUNK_MS);
    };
    chunk(0);
  }

  /** A `loadRange`, answered `latencyMs` later from the records as they are
   *  THEN - the host slices at answer time. */
  loadRange(request: ChatLoadRangeRequest): void {
    this.note(
      `loadRange ${request.requestId} [${String(request.fromOrdinal)},${String(request.toOrdinal)}]`,
    );
    const answer = (): void => this.answerRange(request);
    if (this.heldRanges !== null) {
      this.heldRanges.push(answer);
      return;
    }
    window.setTimeout(answer, this.latencyMs);
  }

  /** Ranges requested from now on wait for `releaseRanges`. */
  holdRanges(): void {
    this.heldRanges ??= [];
  }

  /** Answers every held range at once, and stops holding. */
  releaseRanges(): void {
    const held = this.heldRanges ?? [];
    this.heldRanges = null;
    this.note(`release ${String(held.length)} held ranges`);
    for (const answer of held) answer();
  }

  private heldRanges: Array<() => void> | null = null;

  private answerRange(request: ChatLoadRangeRequest): void {
    const slice = sliceTranscriptRange(
      this.rows(),
      buildTranscriptRecordLookup(this.records, []),
      {
        fromOrdinal: request.fromOrdinal,
        toOrdinal: request.toOrdinal,
        maxBytes: request.maxBytes,
      },
      null,
    );
    this.note(
      `range ${request.requestId} [${String(slice.fromOrdinal)},${String(slice.fromOrdinal + slice.rowIds.length)})`,
    );
    this.cb().onRange({
      kind: "range",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: TASK_ID,
      range: {
        requestId: request.requestId,
        epoch: this.epoch,
        fromOrdinal: slice.fromOrdinal,
        rowIds: [...slice.rowIds],
        incompleteRowIds: [...slice.incompleteRowIds],
        messages: [...slice.messages],
        events: [...slice.events],
        rowContext: slice.rowContext,
        reachedStart: slice.reachedStart,
        reachedEnd: slice.reachedEnd,
        ...(slice.truncatedAtOrdinal === undefined
          ? {}
          : { truncatedAtOrdinal: slice.truncatedAtOrdinal }),
      },
    });
  }

  resnapshot(): void {
    this.note("resnapshot requested");
    window.setTimeout(() => this.bootstrap(), this.latencyMs);
  }

  /**
   * The index delta for what changed since the last one: rows past the old
   * length are `appended`, rewritten rows below it `updated`.
   */
  private sendIndexDelta(): void {
    const next = this.buildSkeleton();
    const previous = this.skeleton;
    const updated = next.slice(0, previous.length).flatMap((entry, ordinal) => {
      const before = previous[ordinal];
      if (before.rowId !== entry.rowId) {
        throw new Error(
          `row ${String(ordinal)} moved (${before.rowId} → ${entry.rowId}); this double sends no reindex`,
        );
      }
      return sameEntry(before, entry) ? [] : [{ ordinal, entry }];
    });
    const appended = next.slice(previous.length);
    this.skeleton = next;
    if (updated.length === 0 && appended.length === 0) return;
    const revision = (this.indexRevision ?? 0) + 1;
    this.indexRevision = revision;
    this.note(
      `indexChanged rowCount=${String(next.length)} rev=${String(revision)} appended=[${appended.map((entry) => entry.rowId).join(",")}] updated=[${updated.map((change) => String(change.ordinal)).join(",")}]`,
    );
    this.cb().onIndexChanged({
      kind: "indexChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: TASK_ID,
      epoch: this.epoch,
      rowCount: next.length,
      indexRevision: revision,
      changes: [
        ...(appended.length === 0
          ? []
          : [{ type: "appended" as const, entries: [...appended] }]),
        ...(updated.length === 0
          ? []
          : [{ type: "updated" as const, entries: updated }]),
      ],
    });
  }

  /** The append republish: snapshot at the held revision, then the delta. */
  private broadcastAppend(): void {
    this.sendSnapshot();
    this.sendIndexDelta();
  }

  private sendTurnState(): void {
    const activeTurn = this.activeTurn();
    this.note(`turnStateChanged active=${String(activeTurn?.turnId ?? null)}`);
    this.cb().onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: TASK_ID,
      runStatus: activeTurn === null ? "idle" : "running",
      activeTurn,
      turnInProgress: activeTurn !== null,
      sendWouldQueue: false,
    });
  }

  /** The client's own send, as `sendAction` hands it over. */
  recordSend(send: PendingSend): void {
    this.note(`client send ${send.messageId}`);
    this.unaccepted.push(send);
  }

  /** Ack, accept and append the oldest send, then start its turn. */
  accept(): void {
    const send = this.unaccepted.shift();
    if (send === undefined) throw new Error("no send to accept");
    this.note(`actionAck ${send.clientActionId}`);
    this.cb().onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: TASK_ID,
      clientActionId: send.clientActionId,
      action: "send",
      status: "accepted",
      reason: null,
      code: null,
      backgroundStopTaskIds: [],
      token: null,
    });
    const record = userRecord(send.messageId, send.content, this.now());
    this.records.push(record);
    this.note(`messageAccepted ${record.messageId}`);
    this.cb().onMessageAccepted({
      kind: "messageAccepted",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: TASK_ID,
      message: acceptedCopy(record),
    });
    this.broadcastAppend();
    this.activeTurnId = `turn-send-${send.messageId}`;
    this.activeUserMessageId = send.messageId;
    this.sendTurnState();
  }

  private activeRecord(): AssistantRecord | null {
    const last = this.records.at(-1);
    if (last?.role !== "assistant" || last.turnId !== this.activeTurnId) {
      return null;
    }
    return last;
  }

  /**
   * The running turn's assistant record is written to the transcript, with
   * whatever has streamed into it so far, as an append.
   */
  assistantStarts(): void {
    if (this.activeTurnId === null) throw new Error("no running turn");
    if (this.activeRecord() !== null) return;
    this.records.push(
      this.unwritten ??
        assistantRecord(
          `assistant-${this.activeTurnId}`,
          this.activeTurnId,
          this.now(),
        ),
    );
    this.unwritten = null;
    this.broadcastAppend();
  }

  /**
   * One delta into the running turn's reply. Before `assistantStarts` writes
   * the record, the deltas reach only the live reply. With no turn running,
   * the last reply's turn is reopened first (`turnStateChanged`), so a stream
   * on an idle chat grows the last reply, as the legacy line's does.
   */
  stream(delta: string): void {
    if (this.activeTurnId === null) {
      const last = this.records.at(-1);
      if (last?.role !== "assistant" || last.turnId === null) {
        throw new Error("the last record is not a reply");
      }
      const user = this.records.findLast((record) => record.role === "user");
      this.activeTurnId = last.turnId;
      this.activeUserMessageId = user?.messageId ?? null;
      this.sendTurnState();
    }
    const written = this.activeRecord();
    const record =
      written ??
      this.unwritten ??
      assistantRecord(
        `assistant-${this.activeTurnId}`,
        this.activeTurnId,
        this.now(),
      );
    const textBlock = record.blocks.findLast((block) => block.type === "text");
    const blockId = textBlock?.blockId ?? `${record.messageId}:text`;
    const event = textDelta(blockId, delta, this.now());
    const grown = { ...record, blocks: accumulateEvent(record.blocks, event) };
    if (written === null) {
      this.unwritten = grown;
    } else {
      this.records[this.records.length - 1] = grown;
    }
    this.cb().onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: TASK_ID,
      event,
    });
  }

  /** The turn completes: its blocks close, it goes idle, and its row's final
   *  size reaches the index with the completion snapshot. */
  finishTurn(): void {
    const turnId = this.activeTurnId;
    if (turnId === null) return;
    if (this.unwritten !== null) this.assistantStarts();
    const record = this.activeRecord();
    const timestamp = this.now();
    if (record !== null) {
      const textBlock = record.blocks.findLast(
        (block) => block.type === "text",
      );
      if (textBlock !== undefined) {
        const event = textCompleted(textBlock.blockId, timestamp);
        this.records[this.records.length - 1] = {
          ...record,
          blocks: accumulateEvent(record.blocks, event),
        };
        this.cb().onBlockDelta({
          kind: "blockDelta",
          hasBinaryPayload: false,
          epicId: EPIC_ID,
          chatId: TASK_ID,
          event,
        });
      }
    }
    this.note(`turn.completed ${turnId}`);
    this.cb().onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: TASK_ID,
      event: { type: "turn.completed", blockId: turnId, timestamp, turnId },
    });
    this.activeTurnId = null;
    this.activeUserMessageId = null;
    this.sendTurnState();
    this.broadcastAppend();
  }

  /** A whole turn the host writes with no send from this client; with
   *  `card`, its reply opens with a reasoning card. */
  appendTurn(card: boolean, tall: boolean): void {
    const turn = this.records.length / 2;
    const user = userRecord(
      `message-${String(this.records.length)}`,
      promptContent(`Question ${String(turn)}`),
      this.now(),
    );
    this.records.push(user);
    this.note(`messageAccepted ${user.messageId}`);
    this.cb().onMessageAccepted({
      kind: "messageAccepted",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: TASK_ID,
      message: acceptedCopy(user),
    });
    this.broadcastAppend();
    const messageId = `message-${String(this.records.length)}`;
    const timestamp = this.now();
    const reply = card
      ? completedReply(
          messageId,
          `turn-appended-${String(turn)}`,
          "The answer after the thinking.",
          timestamp,
        )
      : completedReply(
          messageId,
          `turn-appended-${String(turn)}`,
          replyText(this.records.length, 1),
          timestamp,
        );
    const reasoningId = `${messageId}:reasoning`;
    const reasoning = accumulateEvent(
      accumulateEvent(
        [],
        reasoningDelta(
          reasoningId,
          Array.from(
            { length: 8 },
            (_unused, line) =>
              `Thinking step ${String(line + 1)}. ${"Weighing the options one more time. ".repeat(6)}`,
          ).join("\n\n"),
          timestamp,
        ),
      ),
      { type: "reasoning.completed" as const, blockId: reasoningId, timestamp },
    );
    // `tall`: five paragraphs of lead text above the card, as the legacy
    // line's `appendTallCardTurn`.
    const lead = tall
      ? completedReply(
          `${messageId}-lead`,
          `turn-appended-${String(turn)}`,
          Array.from(
            { length: 5 },
            (_unused, paragraph) =>
              `Lead paragraph ${String(paragraph + 1)}. ${"The quick brown fox jumps over the lazy dog. ".repeat(6)}`,
          ).join("\n\n"),
          timestamp,
        ).blocks
      : [];
    this.records.push(
      card
        ? { ...reply, blocks: [...lead, ...reasoning, ...reply.blocks] }
        : reply,
    );
    this.broadcastAppend();
  }
}

const host = new WindowedHostDouble();
const handle: ChatSessionStoreHandle = createChatSessionStore({
  environment: createRendererRuntimeEnvironment(),
  hostId: HOST_ID,
  epicId: EPIC_ID,
  chatId: TASK_ID,
  userId: OWNER_ID,
  onAuthError: null,
  onProviderAuthError: null,
  wakeTransport: null,
  streamFlushCoordinator: createStreamFlushCoordinator(
    BROWSER_STREAM_FLUSH_TIMERS,
  ),
  streamClientFactory: (_epicId, _chatId, callbacks) => {
    host.attach(callbacks);
    return {
      sendAction: (frame) => {
        if (frame.kind !== "send") return;
        host.recordSend({
          messageId: frame.messageId,
          clientActionId: frame.clientActionId,
          content: frame.content,
        });
      },
      sameTurnSteeringProtocolSupported: () => true,
      draftBlobBridgeSupported: () => false,
      requestTranscriptRange: (request) => host.loadRange(request),
      requestResnapshot: () => host.resnapshot(),
      close: () => undefined,
    };
  },
});
host.bootstrap();

/** What the tile's `dispatchUserSend` does with a composer submit. */
function sendFromComposer(text: string): string {
  const sent = handle.store.getState().sendMessage({
    content: promptContent(text),
    sender: { type: "user", userId: OWNER_ID },
    settings: SETTINGS,
    attachments: [],
    deliveryPolicy: "auto",
    restore: { content: promptContent(text), browserAnnotations: [] },
  });
  if (sent === null) throw new Error("the send was refused");
  return sent.messageId;
}

/** The tile's viewport and find bridges (`ChatTileSessionViewBody`). */
function reportVisibleRange(range: OrdinalRange | null): void {
  handle.store.getState().reportVisibleTranscriptRange(range);
}

function reportFindReadOrdinal(ordinal: number | null): void {
  handle.store.getState().requestFindReadOrdinal(ordinal);
}

function noMessageActions(): null {
  return null;
}

const DISPLAY_CONTEXT = {
  resolveUserSenderLabel: () => "You",
  resolveUserSenderAvatarUrl: () => null,
  resolveAgentSenderDisplay: () => ({
    senderLabel: "Claude",
    providerLabel: "Claude Code",
    modelLabel: "Sonnet",
  }),
  resolveAgentReasoningLabel: () => null,
  resolveAgentServiceTierLabel: () => null,
  contentBlocksPreview: () => "",
};

/** Skeleton ordinal of a row id, or `null`. */
function ordinalOf(rowId: string): number | null {
  const ordinal = handle.store
    .getState()
    .transcriptWindow.skeleton.findIndex((entry) => entry?.rowId === rowId);
  return ordinal === -1 ? null : ordinal;
}

function rowIdAt(ordinal: number): string | null {
  return (
    handle.store.getState().transcriptWindow.skeleton[ordinal]?.rowId ?? null
  );
}

const PLACEHOLDER = '[data-testid="chat-transcript-placeholder-row"]';

/** A row's element: its hydrated item, else its placeholder. */
function rowElement(
  node: HTMLElement,
  rowId: string,
): { element: HTMLElement; placeholder: boolean } | null {
  const hydrated = node.querySelector<HTMLElement>(
    `[data-message-id="${CSS.escape(rowId)}"]`,
  );
  if (hydrated !== null) return { element: hydrated, placeholder: false };
  const ordinal = ordinalOf(rowId);
  if (ordinal === null) return null;
  const placeholder = node.querySelector<HTMLElement>(
    `${PLACEHOLDER}[data-ordinal="${String(ordinal)}"]`,
  );
  return placeholder === null
    ? null
    : { element: placeholder, placeholder: true };
}

const STREAM_TOKEN = " More streamed text arrives here.";
const STREAM_PARAGRAPH = `\n\n${"A whole new streamed paragraph arrives here. ".repeat(8)}`;

export function WindowedFixture(): ReactElement {
  const state = useStore(handle.store);
  const [hideKind, setHideKind] = useState<HideKind>("none");
  const [instance, setInstance] = useState({ id: "tile-1", mount: 1 });
  const [blank, setBlank] = useState(MOUNT_LATER);
  const [draftLines, setDraftLines] = useState(1);
  const streamTimer = useRef<number | null>(null);
  const subagentDrillIn = useSubagentDrillIn(state.snapshotLoaded);
  const turnStatus = composerTurnStatus(state.runStatus);
  const workingRowStatus = resolvedTurnStatus(
    { ...state, queueTurnContinuity: false },
    turnStatus,
  );
  const rendered = useRenderedMessages(
    {
      messages: state.messages,
      events: state.events,
      rowContext: state.transcriptRowContext,
      setupCardWindows: state.transcriptDerived?.setupCardWindows ?? [],
      pendingUserMessages: state.pendingUserMessages,
      pendingTurn: state.pendingTurn,
      turnObservedAt: state.turnObservedAt,
      queuedPromptMessageIds: queuedPromptMessageIds(state.queue.items),
      withdrawnMessageId: null,
      liveAssistantMessage: state.liveAssistantMessage,
      activeTurn: state.activeTurn,
      pendingApprovals: state.pendingApprovals,
      pendingFileEditApprovals: state.pendingFileEditApprovals,
      pendingInterviews: state.pendingInterviews,
      runStatus: workingRowStatus ?? "idle",
      chatWorking: state.runStatus !== "idle",
      epicId: EPIC_ID,
      ownerId: TASK_ID,
      ownerKind: "chat",
      viewTabId: "view-tab",
    },
    DISPLAY_CONTEXT,
  );
  const transcriptWindow = isWindowedTranscript(state)
    ? state.transcriptWindow
    : null;
  const unfolded = useMemo(() => withholdUnpaintedRows(rendered), [rendered]);
  const painted = useMemo(
    () => foldBackgroundEventRows(unfolded, transcriptWindow),
    [unfolded, transcriptWindow],
  );
  const activeTurnId = state.activeTurn?.turnId ?? null;
  const derived = state.transcriptDerived;
  const messages = useMemo(
    () =>
      buildPinnedTodoRenderState(
        painted,
        derived === null
          ? { kind: "derive" }
          : {
              kind: "host",
              todo: derived.pinnedTodo,
              taskItems: derived.pinnedTaskTodoItems,
              activeTurnId,
            },
      ).messages,
    [painted, derived, activeTurnId],
  );

  useLayoutEffect(() => {
    setInstanceLive(instance.id, true);
  }, [instance.id]);

  useLayoutEffect(() => {
    const stopStream = (): void => {
      if (streamTimer.current !== null) {
        window.clearInterval(streamTimer.current);
        streamTimer.current = null;
      }
    };
    const startEvery = (intervalMs: number, delta: string): void => {
      if (streamTimer.current !== null) return;
      streamTimer.current = window.setInterval(
        () => host.stream(delta),
        intervalMs,
      );
    };
    const windowSummary = () => {
      const current = handle.store.getState().transcriptWindow;
      const spanRange = (span: {
        readonly fromOrdinal: number;
        readonly rowIds: readonly string[];
      }) => ({
        fromOrdinal: span.fromOrdinal,
        toOrdinal: span.fromOrdinal + span.rowIds.length,
      });
      return {
        current,
        rowCount: current.rowCount,
        spans: current.spans.map(spanRange),
        staleSpans: current.staleSpans.map(spanRange),
        liveMessageIds: current.liveMessages.map(
          (message) => message.messageId,
        ),
      };
    };
    window.__chatScrollProbe = {
      line: () => "windowed",
      grow: () => host.stream(STREAM_TOKEN),
      startStream: (intervalMs) => startEvery(intervalMs, STREAM_TOKEN),
      startParagraphStream: (intervalMs) =>
        startEvery(intervalMs, STREAM_PARAGRAPH),
      stopStream,
      appendTurn: () => host.appendTurn(false, false),
      appendCardTurn: () => host.appendTurn(true, false),
      appendTallCardTurn: () => host.appendTurn(true, true),
      insertAboveInRow: () => {
        throw new Error("legacy line only");
      },
      hide: (kind) => setHideKind(kind),
      show: () => setHideKind("none"),
      remount: (sameInstance) => {
        setInstance((current) => {
          if (sameInstance) return { id: current.id, mount: current.mount + 1 };
          setInstanceLive(current.id, false);
          return { id: `tile-${current.mount + 1}`, mount: current.mount + 1 };
        });
      },
      pickItems: () => {
        const target =
          useTileMinimapStore.getState().targetsByTileInstanceId[instance.id];
        return (
          target?.adapter.getSnapshot().items.map((item) => item.key) ?? []
        );
      },
      pick: (index) => {
        const target =
          useTileMinimapStore.getState().targetsByTileInstanceId[instance.id];
        if (target === undefined) throw new Error("no minimap target");
        target.adapter.select(index);
      },
      geometry: readGeometry,
      mode: () => scrollNode()?.dataset.scrollMode ?? null,
      pillShown: readPillShown,
      rowTop: (messageId) => {
        const node = scrollNode();
        if (node === null) return null;
        const row = rowElement(node, messageId);
        if (row === null) return null;
        return (
          row.element.getBoundingClientRect().top -
          node.getBoundingClientRect().top
        );
      },
      readingRow: () => {
        const node = scrollNode();
        if (node === null) return null;
        const top = node.getBoundingClientRect().top;
        const rows = Array.from(
          node.querySelectorAll<HTMLElement>(
            `[data-message-id], ${PLACEHOLDER}`,
          ),
        ).filter((row) => row.getBoundingClientRect().bottom > top + 1);
        rows.sort(
          (a, b) =>
            a.getBoundingClientRect().top - b.getBoundingClientRect().top,
        );
        const first = rows.at(0);
        if (first === undefined) return null;
        const placeholder = first.matches(PLACEHOLDER);
        return {
          messageId: placeholder
            ? rowIdAt(Number(first.dataset.ordinal))
            : (first.dataset.messageId ?? null),
          offset: first.getBoundingClientRect().top - top,
          placeholder,
        };
      },
      saved: () =>
        peekSavedChatTabState({
          tileInstanceId: instance.id,
          epicId: EPIC_ID,
          chatId: TASK_ID,
          hostId: null,
        }),
      instanceId: () => instance.id,
      isPlaceholder: (messageId) => {
        const node = scrollNode();
        if (node === null) return null;
        return rowElement(node, messageId)?.placeholder ?? null;
      },
      hydratedRange: () => {
        const { rowCount, spans, liveMessageIds } = windowSummary();
        return { rowCount, spans, liveMessageIds };
      },
      ordinalOf,
      setHydrationLatency: (ms) => host.setLatency(ms),
      evictCold: () => {
        getProcessMemoryRuntime().chatWindows.evict(Number.MAX_SAFE_INTEGER);
      },
      windowState: () => {
        const summary = windowSummary();
        const store = handle.store.getState();
        return {
          rowCount: summary.rowCount,
          spans: summary.spans,
          liveMessageIds: summary.liveMessageIds,
          staleSpans: summary.staleSpans,
          epoch: summary.current.epoch,
          indexRevision: summary.current.indexRevision,
          skeletonLength: summary.current.skeleton.length,
          skeletonComplete: summary.current.skeletonComplete,
          skeletonStreamCoveredThrough:
            summary.current.skeletonStreamCoveredThrough,
          invalidated: summary.current.invalidated,
          pendingUserMessageIds: store.pendingUserMessages.map(
            (message) => message.messageId,
          ),
          activeTurnId: store.activeTurn?.turnId ?? null,
          runStatus: store.runStatus,
        };
      },
      frameLog: () => [...host.log],
      typeDraft: (lines) => setDraftLines(lines),
      send: (text) => {
        const messageId = sendFromComposer(text);
        // The composer clears in the submit; its new height reaches the
        // transcript through the dock's measurement, a frame later.
        requestAnimationFrame(() => setDraftLines(1));
        return messageId;
      },
      hostAccept: () => host.accept(),
      assistantStarts: () => host.assistantStarts(),
      finishTurn: () => {
        stopStream();
        host.finishTurn();
      },
    };
    // Production's other remount paths, as the legacy line has them: the tile
    // unmounts in one commit and mounts in a later one (eviction, close and
    // reopen), or a structural move flushes the live capture first.
    Object.assign(window.__chatScrollProbe, {
      remountLater: (sameInstance: boolean): void => {
        setBlank(true);
        if (!sameInstance) setInstanceLive(instance.id, false);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            setInstance((current) =>
              sameInstance
                ? { id: current.id, mount: current.mount + 1 }
                : { id: `tile-${current.mount + 1}`, mount: current.mount + 1 },
            );
            setBlank(false);
          }),
        );
      },
      remountMoved: (): void => {
        flushChatTabViewportHandoff([instance.id]);
        setInstance((current) => ({
          id: current.id,
          mount: current.mount + 1,
        }));
      },
      // The same tab instance unmounts, memory pressure evicts everything
      // but `[keepFromOrdinal, rowCount)` while it is gone, and it mounts
      // again over the cold rows: a saved reading position above that edge
      // then names a row that is not hydrated.
      remountEvicted: (keepFromOrdinal: number): void => {
        setBlank(true);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const { rowCount } = handle.store.getState().transcriptWindow;
            reportVisibleRange({
              fromOrdinal: keepFromOrdinal,
              toOrdinal: rowCount,
            });
            getProcessMemoryRuntime().chatWindows.evict(
              Number.MAX_SAFE_INTEGER,
            );
            setInstance((current) => ({
              id: current.id,
              mount: current.mount + 1,
            }));
            setBlank(false);
          }),
        );
      },
      // The module registry the hydration retry keeps its unresolved saved
      // anchor in; `null` once that restore validated or a reader superseded
      // it.
      pendingRestore: () =>
        pendingHydrationRestore({
          tileInstanceId: instance.id,
          epicId: EPIC_ID,
          chatId: TASK_ID,
          hostId: null,
        }),
      // A reading position this tab saved in an earlier renderer session,
      // as durable storage hands it back (the fixture has no signed-in
      // account, so nothing reaches localStorage itself).
      seedSaved: (saved: SavedChatTabScrollState): void => {
        saveChatTabState({
          identity: {
            tileInstanceId: instance.id,
            epicId: EPIC_ID,
            chatId: TASK_ID,
            hostId: null,
          },
          ...saved,
        });
      },
      mountNow: (): void => setBlank(false),
      // Ranges requested from now on wait; `releaseRangesIn` answers them all
      // on the page's own clock, so a caller outside the page can time input
      // against the commit they cause.
      holdRanges: (): void => host.holdRanges(),
      releaseRangesIn: (ms: number): void => {
        window.setTimeout(() => host.releaseRanges(), ms);
      },
      // A row's drawn height, and whether a placeholder drew it.
      rowHeight: (rowId: string) => {
        const node = scrollNode();
        if (node === null) return null;
        const row = rowElement(node, rowId);
        if (row === null) return null;
        return {
          height: row.element.getBoundingClientRect().height,
          placeholder: row.placeholder,
        };
      },
    });
  }, [instance.id]);

  const hidden = hideKind !== "none";
  return (
    <div className="flex h-full w-full flex-col">
      <div
        className="flex min-h-0 flex-1 flex-col"
        data-chat-keyboard-scroll-scope=""
        data-active="true"
        style={{
          visibility: hideKind === "intact" ? "hidden" : undefined,
          display: hideKind === "collapse" ? "none" : undefined,
        }}
      >
        {blank ? null : (
          <TileMinimapScope tileInstanceId={instance.id}>
            <ChatMessages
              key={`${instance.id}:${String(instance.mount)}`}
              taskTitle="Chat scroll model"
              taskId={TASK_ID}
              epicId={EPIC_ID}
              hostId={null}
              messages={messages}
              transcriptWindow={transcriptWindow}
              onVisibleOrdinalRangeChange={reportVisibleRange}
              onFindReadOrdinalChange={reportFindReadOrdinal}
              baselineEpoch={state.transcriptBaselineEpoch}
              hydrationSequence={state.transcriptHydrationSequence}
              coldRewrittenMessageIds={state.coldRewrittenMessageIds}
              backgroundItems={state.backgroundItems}
              getMessageActions={noMessageActions}
              nextStepActions={null}
              instanceId={instance.id}
              visible={!hidden}
              systemOverlayActive={false}
              scrollRequest={null}
              onScrollRequestSettled={null}
              composerOverlayHeight={dockHeightFor(draftLines)}
              subagentDrillIn={subagentDrillIn}
            />
          </TileMinimapScope>
        )}
      </div>
    </div>
  );
}
