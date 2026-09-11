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
 * That widening is also why the re-parse can REFUSE, and refusal has to be
 * handled at the RIGHT GRANULARITY. Reparsing a whole assistant record and
 * dropping it on any failure inverts the guarantee the presentation layer
 * exists to provide: one future block type inside an otherwise ordinary message
 * deleted its known text, file changes and plan along with it. A message is
 * therefore rebuilt block by block - every block this build understands is
 * kept, and a block it does not is replaced by a visible placeholder rather
 * than taking its siblings down with it.
 *
 * What still refuses at record granularity is a message whose ENVELOPE this
 * build cannot represent - an unknown role, or a sender naming a harness
 * outside the closed live enum. Those are counted, not silently swallowed,
 * because a dropped message is indistinguishable from a chat that never had
 * one. See the note on `UNREPRESENTABLE_ENVELOPE` below.
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

/**
 * One message, with every block this build understands preserved.
 *
 * Blocks are screened individually against the live schema and an unreadable
 * one is swapped for a placeholder, so the record as a whole can still parse.
 * Returns `null` only when the ENVELOPE itself is unrepresentable, which the
 * caller counts.
 */
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

/**
 * A block this build cannot interpret, as one it can.
 *
 * A `text` block carrying a plain statement, rather than a dropped entry: the
 * gap has to be VISIBLE where it happened. An omitted block is
 * indistinguishable from a message that never had one, which is the exact
 * confusion the presentation layer's preservation rules exist to prevent, and
 * the composer's summary line cannot say WHERE the missing content sat.
 *
 * `timestamp: 0` and a derived `blockId` keep it inert and stably keyed; it
 * carries no payload refs, so nothing downstream tries to fetch it.
 */
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

/**
 * Re-parse a doc-replica read's raw rows through the live schemas.
 *
 * Mirrors `convertPublishedChat`'s per-block tolerance and returns the same
 * `PublishedChatConversion` shape, so `createPublishedChatSessionHandle`
 * cannot tell the two sources apart. The rows differ from the published
 * path's, though: there is no separate `blocks` array tracked alongside each
 * message (a published chat's presenter splits head from shards; a doc row
 * is already the reconstructed, inline-blocks `Message`), so the screening
 * step reads `blocks` off the raw record itself rather than a parallel list.
 */
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
 * One doc-replica message row, with every block this build understands
 * preserved. Returns `null` only when the ENVELOPE itself is unrepresentable
 * (an unknown role, or no `blocks` array to screen), which the caller counts
 * - see `rebuildMessage` above for the published-copy sibling this mirrors.
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
    // No stream, so no attempt ever failed. Same statement as
    // `connectionStatus: "closed"` above, in the vocabulary of the bounded
    // loading gate: there is nothing here that is still trying.
    preSnapshotRetries: null,
    // A published copy is complete and frozen: this stands in for the
    // snapshot that established it, so the transcript is absorbed as
    // baseline history and nothing in it is ever announced as live.
    transcriptBaselineEpoch: 0,
    // Frozen, so nothing hydrates and this never moves.
    transcriptHydrationSequence: 0,
    transcriptRowContext: {},
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
      pinnedUserProviderHandle: null,
      lastDeliveredRolesDigest: null,
      activeSessionChain: null,
      claudePendingWakes: [],
      // No `messages`/`events` here: the record is a `ChatSessionRecord`, and
      // the transcript is carried once, on the state's own fields below. A
      // published copy is the case that made the duplicate most expensive -
      // the whole transcript arrives materialized, so a second copy doubled
      // the peak of an already-large read.
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
    // And no holds either - a hold is released by an RPC to the host that owns
    // it, which a published copy has no route to. Empty is the truth here, not
    // a placeholder: rendering a Deliver affordance on a copy would offer an
    // action that cannot be sent.
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
    // A published copy is a FULL-materialized transcript, so it is on the
    // legacy side of the window seam by construction: `messages`/`events`
    // above hold everything, and there is no host to hydrate a range from.
    // The windowed index for a `1.2` head is its own path (`publish-path §4`).
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
    // No frames reach a published copy, so no completion is ever owed here.
    settledRestoreCompletions: [],
    pendingActions: {},
    acceptedActions: {},
    pendingUserMessages: [],
    errorNotices: [],
    deliveredNoticeActionIds: new Set<string>(),
    deliveredLastCopyActionIds: new Set<string>(),
    // Nothing streams into a published copy, so no card is ever opened here -
    // but the field is part of the state shape and a second construction site
    // that forgets one is how these two drift.
    openedSubagentCardBlockIds: new Set<string>(),
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
    retryFromUser: () => undefined,
    wake: () => undefined,
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

/**
 * What a LATER publication of the same chat brings: the fields
 * `applyConversion` may move. Identity (`epicId`, `chatId`, `ownerUserId`)
 * and `createdAt` are fixed for the handle's life - a read that disagrees
 * about those is a different chat, refused upstream as `ambiguous-identity`.
 */
export interface PublishedChatConversionUpdate {
  readonly title: string;
  readonly updatedAt: number;
  readonly conversion: PublishedChatConversion;
}

/**
 * The published copy's handle: the ordinary `ChatSessionStoreHandle` plus
 * the one way its transcript can change - a newer publication applied IN
 * PLACE. The surface takes the base type and never sees the extra member;
 * the tile that owns the handle is the only caller.
 */
export interface PublishedChatSessionHandle extends ChatSessionStoreHandle {
  /**
   * Replaces `messages`, `events`, `title` and `updatedAt` with a newer
   * publication's, keeping this store - and therefore every subscription the
   * rendered surface holds on it - exactly where it is.
   *
   * ## Row identity is preserved where the row did not change
   *
   * A message or event whose id AND content match the one already held is
   * carried over as the SAME object, so a memoized row does not re-render for
   * a turn that merely appended after it. A row whose content changed (the
   * publisher completed a message it had captured mid-turn) takes the new
   * object; a row that is new is new. When nothing at all changed - the same
   * head re-read after a payload-list heal, say - the store is not written.
   *
   * ## The baseline epoch answers "is this history or news?"
   *
   * `transcriptBaselineEpoch` is what the transcript consumers (announcements,
   * scroll pinning) read to tell a live arrival from a re-established
   * baseline. An APPENDED publication - every previously held message id is
   * still present, in the same position - keeps the epoch, so the new rows
   * present as live arrivals exactly as they would on a live tile. A
   * publication that is NOT an extension of what was shown (a message id
   * present before is absent now, or the first difference is not at the
   * tail: a fork, a truncation, a suffix delete) bumps it, so the whole
   * transcript is absorbed as a new baseline rather than announced.
   */
  readonly applyConversion: (update: PublishedChatConversionUpdate) => void;
}

/**
 * A handle over a state that changes only through `applyConversion`.
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
): PublishedChatSessionHandle {
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
    applyConversion: (update) => {
      const current = store.getState();
      const messages = reconcileRows(
        current.messages,
        update.conversion.messages,
        (message) => message.messageId,
      );
      const events = reconcileRows(
        current.events,
        update.conversion.events,
        (event) => event.eventId,
      );
      const chat = current.chat;
      const metadataUnchanged =
        chat !== null &&
        chat.title === update.title &&
        chat.updatedAt === update.updatedAt;
      if (
        metadataUnchanged &&
        messages.rows === current.messages &&
        events.rows === current.events
      ) {
        return;
      }
      store.setState({
        messages: messages.rows,
        events: events.rows,
        transcriptBaselineEpoch: messages.extends
          ? current.transcriptBaselineEpoch
          : current.transcriptBaselineEpoch + 1,
        chat:
          chat === null
            ? null
            : { ...chat, title: update.title, updatedAt: update.updatedAt },
      });
    },
  };
}

/**
 * The next row list, with unchanged rows carried over by reference, and
 * whether it EXTENDS the previous one (same ids in the same positions as a
 * prefix). Returns the previous array itself when nothing changed at all,
 * which is what lets the caller skip the write.
 */
function reconcileRows<Row>(
  previous: readonly Row[],
  next: readonly Row[],
  idOf: (row: Row) => string,
): { readonly rows: readonly Row[]; readonly extends: boolean } {
  const previousById = new Map<string, Row>();
  for (const row of previous) previousById.set(idOf(row), row);
  let changed = next.length !== previous.length;
  let extendsPrevious = next.length >= previous.length;
  const rows = next.map((row, index) => {
    const id = idOf(row);
    if (index < previous.length && idOf(previous[index]) !== id) {
      extendsPrevious = false;
    }
    const held = previousById.get(id);
    if (held === undefined) {
      changed = true;
      return row;
    }
    if (held === row || jsonDeepEqual(held, row)) {
      if (held !== previous[index]) changed = true;
      return held;
    }
    changed = true;
    return row;
  });
  return { rows: changed ? rows : previous, extends: extendsPrevious };
}

/**
 * Structural equality over the JSON-shaped records the schemas produce.
 * Plain objects and arrays only - the parsed rows carry nothing else - and
 * the walk bails at the first difference rather than serializing both sides.
 */
function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => jsonDeepEqual(item, b[index]));
  }
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return false;
  }
  const left: Record<string, unknown> = { ...a };
  const right: Record<string, unknown> = { ...b };
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every(
    (key) => Object.hasOwn(right, key) && jsonDeepEqual(left[key], right[key]),
  );
}
