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
import type { PresentedChat } from "@traycer/protocol/persistence/chat-sync/presentation";
import type {
  ChatSessionState,
  ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";

/**
 * A published chat, adapted into the shape the ordinary chat surface reads.
 *
 * ## Why this is an adapter and not a second chat view
 *
 * The chat surface's own seam is `ChatSessionStoreHandle` - a zustand store of
 * `ChatSessionState` plus a little lifecycle. Everything above it (the
 * timeline, every block card, thinking, tools, scroll, the dock) reads that
 * store and nothing else. So a chat whose owning host is unreachable does not
 * need a lesser renderer: it needs the same store, filled from the last copy
 * that host published instead of from a live `chat.subscribe` stream. This
 * module is that fill.
 *
 * ## The conversion is a re-parse, not a re-model
 *
 * A published chat's messages are not a parallel encoding of the live ones -
 * `chatSyncMessageSchema` is derived from the very `userMessageSchema` /
 * `assistantMessageSchema` the renderer already reads, widened at exactly one
 * kind of leaf (harness ids are reopened to plain strings so a chat from a
 * harness this build never heard of stays readable). So the conversion is to
 * hand each message's preserved `raw` back to the live schema.
 *
 * That widening is also why the re-parse can REFUSE: a message from an
 * unknown harness parses as chat-sync and not as an epic message. Refusals are
 * counted rather than swallowed, because a dropped message is indistinguishable
 * from a chat that never had one - the same rule the presentation layer already
 * enforces for unknown blocks.
 *
 * ## Everything live is empty, and empty is the honest value
 *
 * A published copy has no turn in flight, no queue, no pending approval and no
 * worktree - not "we don't know", but "there is no live authority here at all".
 * The surface reads those as absent and renders exactly what a settled chat
 * renders. `connectionStatus: "closed"` is the same statement to anything that
 * asks whether this session can act.
 */

export interface PublishedChatConversion {
  readonly messages: readonly Message[];
  readonly events: readonly ChatEvent[];
  /**
   * Messages and events this build could parse as chat-sync but not as its own
   * epic records. Surfaced beside the transcript's own fidelity line rather
   * than dropped silently.
   */
  readonly unreadableCount: number;
}

/**
 * Re-parse a presented chat's preserved records through the live schemas.
 *
 * Order is preserved exactly as published: the head names its shards in order
 * and the presentation layer assembles them, so re-sorting here would be this
 * client inventing an ordering the publisher did not commit.
 */
export function convertPublishedChat(
  presented: PresentedChat,
): PublishedChatConversion {
  const messages: Message[] = [];
  const events: ChatEvent[] = [];
  let unreadableCount = 0;
  for (const message of presented.messages) {
    const parsed = messageSchema.safeParse(message.raw);
    if (parsed.success) messages.push(parsed.data);
    else unreadableCount += 1;
  }
  for (const event of presented.events) {
    const parsed = chatEventSchema.safeParse(event.raw);
    if (parsed.success) events.push(parsed.data);
    else unreadableCount += 1;
  }
  return { messages, events, unreadableCount };
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

/**
 * The `ChatSessionState` a published copy presents.
 *
 * `access.canAct` is false and `role` is `viewer`, which is true in the only
 * sense that matters here - nothing sent from this surface could reach an
 * authority - and it makes every act-gated affordance in the dock fall away
 * without a second gate to keep in step with the first. The composer's REASON
 * does not come from this; a viewer-by-permission and an owner-whose-host-is-
 * asleep are different facts and the surface says which one it is.
 */
export function publishedChatSessionState(
  input: PublishedChatSessionInput,
): ChatSessionState {
  return {
    epicId: input.epicId,
    chatId: input.chatId,
    // Not "connecting": there is no stream to wait for, and a surface that
    // showed a reconnecting spinner over a complete transcript would be
    // promising something that is never going to arrive.
    connectionStatus: "closed",
    fatalClose: null,
    // The whole point - the transcript is here, so the surface renders it
    // rather than a loading gate.
    snapshotLoaded: true,
    chat: {
      parentId: null,
      id: input.chatId,
      userId: input.ownerUserId,
      // The OWNING host is deliberately not stamped here. This field feeds
      // live-host affordances, and every one of them is wrong for a copy; the
      // owner is carried on the tile ref, where it is read as row metadata.
      hostId: "",
      title: input.title,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      isTitleEditedByUser: false,
      settings: null,
      activeSessionChain: null,
      claudePendingWakes: [],
      // Copied into mutable arrays: `Chat` is the persisted record shape and
      // its arrays are not readonly, while the conversion's are. Nothing
      // mutates them here - the copy is the type boundary, not a defence.
      messages: [...input.conversion.messages],
      events: [...input.conversion.events],
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
    runStatus: "idle",
    activeTurn: null,
    steerProtocolSupported: false,
    turnInProgress: false,
    pendingApprovals: [],
    pendingFileEditApprovals: [],
    pendingInterviews: [],
    accumulatedFileChanges: [],
    backgroundItems: undefined,
    pendingBackgroundStops: {},
    pendingBackgroundStopAll: null,
    restore: null,
    pendingActions: {},
    acceptedActions: {},
    pendingUserMessages: [],
    errorNotices: [],
    failedSendRestoration: null,
    currentComposerSettings: null,
    liveAssistantMessage: null,
    liveTurnUsage: null,
    worktreeBinding: null,
    missingWorktreePaths: [],

    // Every action a live session exposes, inert.
    //
    // `null` is not a placeholder here - it is the return each of these already
    // uses for "no frame was dispatched", which is exactly true: there is no
    // stream to dispatch on. The surface's own act-gating (`access.canAct`
    // false, `runStatus: "idle"`, no queue and no approvals) means it never
    // offers these in the first place, so this is the floor beneath that, not
    // the mechanism enforcing it. Throwing instead would turn a stray call from
    // a keyboard shortcut into a crash over a transcript the reader can
    // perfectly well go on reading.
    refreshMissingWorktreePaths: () => undefined,
    retry: () => undefined,
    sendMessage: () => null,
    sendSeededUserMessage: () => null,
    deleteMessageSuffix: () => null,
    editUserMessage: () => null,
    revertFileChanges: () => null,
    stopTurn: () => null,
    stopBackgroundItem: () => null,
    stopAllBackgroundItems: () => null,
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
    interviewError: () => null,
    ackAcceptedAction: () => undefined,
    ackFailedSendRestoration: () => undefined,
    takeSetupFailedRestoration: () => null,
    setCurrentComposerSettings: () => undefined,
    dispose: () => undefined,
  };
}

/**
 * A handle over a fixed state.
 *
 * The lifecycle members are real no-ops rather than throwing stubs: the surface
 * calls `setSurfaceVisibility` on mount and `dispose` on unmount as a matter of
 * course, and those calls exist to pace a stream's flush rate. There is no
 * stream, so there is nothing to pace and nothing to tear down - answering
 * quietly is honest, where throwing would only mean this surface had to know it
 * was special.
 */
export function createPublishedChatSessionHandle(
  input: PublishedChatSessionInput,
): ChatSessionStoreHandle {
  const state = publishedChatSessionState(input);
  const store = createStore<ChatSessionState>()(() => state);
  const boundStore = Object.assign(
    <T,>(selector: (value: ChatSessionState) => T): T =>
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
      clientActionIds: new Set(),
    },
    deliveredRestoreCompletionKeys: new Set(),
    setSurfaceVisibility: () => undefined,
    clearSurfaceVisibility: () => undefined,
    dispose: () => undefined,
  };
}
