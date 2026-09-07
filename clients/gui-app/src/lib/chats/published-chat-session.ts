import { createStore, useStore } from "zustand";
import type { UseBoundStore, StoreApi } from "zustand";
import {
  chatEventSchema,
  type ChatEvent,
} from "@traycer/protocol/persistence/epic/chat-events";
import {
  messageSchema,
  type Message,
} from "@traycer/protocol/persistence/epic/messages";
import { contentBlockSchema } from "@traycer/protocol/persistence/epic/content-blocks";
import type { JsonObject } from "@traycer/protocol/persistence/chat-sync/json";
import type { PresentedChat } from "@traycer/protocol/persistence/chat-sync/presentation";
import { emptyTranscriptWindow } from "@/stores/chats/transcript-window";
import type {
  ChatSessionState,
  ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";

/**
 * Adapt a published chat into `ChatSessionStoreHandle` by re-parsing preserved `raw` through live schemas.
 * Rebuild messages block-by-block (unknown blocks become placeholders); live fields stay empty/`closed`.
 */

export interface PublishedChatConversion {
  readonly messages: readonly Message[];
  readonly events: readonly ChatEvent[];
  /**
   * Messages and events this build could parse as chat-sync but not as its own epic records.
   * Surfaced beside the transcript's own fidelity line rather than dropped silently.
   */
  readonly unreadableCount: number;
}

/** Re-parse a presented chat's preserved records through the live schemas. */
export function convertPublishedChat(
  presented: PresentedChat,
): PublishedChatConversion {
  const messages: Message[] = [];
  const events: ChatEvent[] = [];
  let unreadableCount = 0;
  for (const message of presented.messages) {
    const rebuilt = rebuildMessage(message.raw, message.blocks);
    if (rebuilt === null) {
      unreadableCount += 1;
      continue;
    }
    messages.push(rebuilt.message);
    unreadableCount += rebuilt.replacedBlockCount;
  }
  for (const event of presented.events) {
    const parsed = chatEventSchema.safeParse(event.raw);
    if (parsed.success) events.push(parsed.data);
    else unreadableCount += 1;
  }
  return { messages, events, unreadableCount };
}

/** One message, with every block this build understands preserved. */
function rebuildMessage(
  raw: JsonObject,
  presentedBlocks: PresentedChat["messages"][number]["blocks"],
): { readonly message: Message; readonly replacedBlockCount: number } | null {
  if (presentedBlocks.length === 0) {
    const parsed = messageSchema.safeParse(raw);
    return parsed.success
      ? { message: parsed.data, replacedBlockCount: 0 }
      : null;
  }
  let replacedBlockCount = 0;
  const blocks = presentedBlocks.map((block, index) => {
    const parsed = contentBlockSchema.safeParse(block.raw);
    if (parsed.success) return block.raw;
    replacedBlockCount += 1;
    return placeholderBlockRaw(block.blockId ?? `unreadable-${index}`, index);
  });
  const parsed = messageSchema.safeParse({ ...raw, blocks });
  if (!parsed.success) return null;
  return { message: parsed.data, replacedBlockCount };
}

/** A block this build cannot interpret, as one it can. */
function placeholderBlockRaw(blockId: string, index: number): JsonObject {
  return {
    blockId: `${blockId}:unreadable-${index}`,
    status: "completed",
    timestamp: 0,
    parentBlockId: null,
    type: "text",
    text: "This part of the message needs a newer version of Traycer to display.",
    providerNotice: null,
  };
}

/** Re-parse a doc-replica read's raw rows through the live schemas. */
export function convertReplicaChat(
  rawMessages: readonly Record<string, unknown>[],
  rawEvents: readonly Record<string, unknown>[],
): PublishedChatConversion {
  const messages: Message[] = [];
  let unreadableCount = 0;
  for (const raw of rawMessages) {
    const rebuilt = rebuildReplicaMessage(raw);
    if (rebuilt === null) {
      unreadableCount += 1;
      continue;
    }
    messages.push(rebuilt.message);
    unreadableCount += rebuilt.replacedBlockCount;
  }
  const events: ChatEvent[] = [];
  for (const raw of rawEvents) {
    const parsed = chatEventSchema.safeParse(raw);
    if (parsed.success) events.push(parsed.data);
    else unreadableCount += 1;
  }
  return { messages, events, unreadableCount };
}

/**
 * One doc-replica message row, with every block this build understands preserved.
 * Returns `null` only when the ENVELOPE itself is unrepresentable (an unknown role, or no `blocks` array to screen), which the caller counts
 */
function rebuildReplicaMessage(
  raw: Record<string, unknown>,
): { readonly message: Message; readonly replacedBlockCount: number } | null {
  const parsed = messageSchema.safeParse(raw);
  if (parsed.success) {
    return { message: parsed.data, replacedBlockCount: 0 };
  }
  const rawBlocks = raw["blocks"];
  if (!Array.isArray(rawBlocks)) return null;
  let replacedBlockCount = 0;
  const blocks = rawBlocks.map((block: unknown, index: number) => {
    const blockParsed = contentBlockSchema.safeParse(block);
    if (blockParsed.success) return block;
    replacedBlockCount += 1;
    const blockId =
      typeof block === "object" &&
      block !== null &&
      typeof (block as Record<string, unknown>)["blockId"] === "string"
        ? ((block as Record<string, unknown>)["blockId"] as string)
        : `unreadable-${index}`;
    return placeholderBlockRaw(blockId, index);
  });
  const reparsed = messageSchema.safeParse({ ...raw, blocks });
  return reparsed.success
    ? { message: reparsed.data, replacedBlockCount }
    : null;
}

export interface PublishedChatSessionInput {
  readonly epicId: string;
  readonly chatId: string;
  /** The chat's owner, from the cloud row. Drives `access.ownerUserId`. */
  readonly ownerUserId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly conversion: PublishedChatConversion;
}

/** The `ChatSessionState` a published copy presents. */
export function publishedChatSessionState(
  input: PublishedChatSessionInput,
): ChatSessionState {
  return {
    epicId: input.epicId,
    chatId: input.chatId,
    // Not "connecting": there is no stream to wait for, and a surface that showed a reconnecting spinner over a complete transcript would be promising something that is never going to arrive.
    connectionStatus: "closed",
    fatalClose: null,
    // The whole point - the transcript is here, so the surface renders it
    // rather than a loading gate.
    snapshotLoaded: true,
    // A published copy is complete and frozen: this stands in for the snapshot that established it, so the transcript is absorbed as baseline history and nothing in it is ever announced as live.
    transcriptBaselineEpoch: 0,
    // Frozen, so nothing hydrates and this never moves.
    transcriptHydrationSequence: 0,
    transcriptRowContext: {},
    chat: {
      parentId: null,
      id: input.chatId,
      userId: input.ownerUserId,
      // The OWNING host is deliberately not stamped here.
      // This field feeds live-host affordances, and every one of them is wrong for a copy; the owner is carried on the tile ref, where it is read as row metadata.
      hostId: "",
      title: input.title,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      isTitleEditedByUser: false,
      settings: null,
      pinnedUserProviderHandle: null,
      lastDeliveredRolesDigest: null,
      activeSessionChain: null,
      claudePendingWakes: [],
      // No `messages`/`events` here: the record is a `ChatSessionRecord`, and the transcript is carried once, on the state's own fields below.
      // A published copy is the case that made the duplicate most expensive - the whole transcript arrives materialized, so a second copy doubled the peak of an already-large read.
      archivedAt: null,
    },
    access: {
      role: "viewer",
      ownerUserId: input.ownerUserId,
      canAct: false,
    },
    messages: input.conversion.messages,
    events: input.conversion.events,
    queue: { status: "idle", items: [] },
    // A copy has no live host stream, so no managed commands can ever arrive.
    managedCommands: [],
    // And no holds either - a hold is released by an RPC to the host that owns it, which a published copy has no route to.
    // Empty is the truth here, not a placeholder: rendering a Deliver affordance on a copy would offer an action that cannot be sent.
    heldUpdates: [],
    runStatus: "idle",
    activeTurn: null,
    steerProtocolSupported: false,
    interviewDeliveryRetryProtocolSupported: false,
    turnInProgress: false,
    pendingApprovals: [],
    pendingFileEditApprovals: [],
    pendingInterviews: [],
    accumulatedFileChanges: [],
    // A published copy is a FULL-materialized transcript, so it is on the legacy side of the window seam by construction: `messages`/`events` above hold everything, and there is no host to hydrate a range from.
    transcriptWindow: emptyTranscriptWindow(),
    transcriptDerived: null,
    accumulatedFileChangeCount: 0,
    // A published copy is static: nothing evicts, nothing jumps, and there is
    // no stream to request hydration from. All three are the inert values.
    coldRewrittenMessageIds: new Set(),
    jumpTargetOrdinal: null,
    requestTranscriptOrdinal: () => undefined,
    accumulatedFileChangeSummaries: [],
    // A published transcript is not on the windowed line and streams no
    // chunks, so there is no generation to be waiting on.
    accumulatedSummaryGenerationSeated: true,
    accumulatedSummaryAssemblyStarted: false,
    backgroundItems: undefined,
    pendingBackgroundStops: {},
    pendingBackgroundStopAll: null,
    pendingBackgroundSessionStop: null,
    restore: null,
    pendingActions: {},
    acceptedActions: {},
    pendingUserMessages: [],
    errorNotices: [],
    deliveredNoticeActionIds: new Set<string>(),
    // Nothing streams into a published copy, so no card is ever opened here - but the field is part of the state shape and a second construction site that forgets one is how these two drift.
    openedSubagentCardBlockIds: new Set<string>(),
    failedSendRestoration: null,
    currentComposerSettings: null,
    liveAssistantMessage: null,
    liveTurnUsage: null,
    worktreeBinding: null,
    missingWorktreePaths: [],

    // Every action a live session exposes, inert.
    refreshMissingWorktreePaths: () => undefined,
    retry: () => undefined,
    // A published copy is complete: every ordinal is hydrated by construction,
    // so a viewport report has nothing to request.
    reportVisibleTranscriptRange: () => undefined,
    sendMessage: () => null,
    sendSeededUserMessage: () => null,
    deleteMessageSuffix: () => null,
    editUserMessage: () => null,
    revertFileChanges: () => null,
    stopTurn: () => null,
    stopBackgroundItem: () => null,
    stopAllBackgroundItems: () => null,
    stopBackgroundSession: () => null,
    pauseQueue: () => null,
    resumeQueue: () => null,
    queueEdit: () => null,
    queueCancel: () => null,
    queueReorder: () => null,
    queueSteerNow: () => null,
    queueAbortSteer: () => null,
    queueSettingsUpdate: () => null,
    updateActivePermissionMode: () => null,
    updateActiveProfile: () => null,
    restampQueuedItemSettings: () => null,
    approvalDecision: () => null,
    fileEditApprovalDecision: () => null,
    restoreCheckpoint: () => null,
    interviewAnswer: () => null,
    interviewSkip: () => null,
    interviewDeliveryRetry: () => null,
    ackAcceptedAction: () => undefined,
    ackFailedSendRestoration: () => undefined,
    stateFailedSendRestoration: () => undefined,
    markNoticeDelivered: () => undefined,
    takeSetupFailedRestoration: () => null,
    setCurrentComposerSettings: () => undefined,
    dispose: () => undefined,
  };
}

/** A handle over a fixed state. */
export function createPublishedChatSessionHandle(
  input: PublishedChatSessionInput,
): ChatSessionStoreHandle {
  const state = publishedChatSessionState(input);
  const store = createStore<ChatSessionState>()(() => state);
  const boundStore = Object.assign(
    <T>(selector: (value: ChatSessionState) => T): T =>
      useStore(store, selector),
    store,
  ) as UseBoundStore<StoreApi<ChatSessionState>>;
  return {
    epicId: input.epicId,
    chatId: input.chatId,
    userId: input.ownerUserId,
    store: boundStore,
    deliveredNotices: {
      notices: new WeakSet(),
      retainedClientActionIds: new Set<string>(),
      clientActionIds: new Set(),
    },
    deliveredRestoreCompletionKeys: new Set(),
    setSurfaceVisibility: () => undefined,
    clearSurfaceVisibility: () => undefined,
    dispose: () => undefined,
  };
}
