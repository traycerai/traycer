import {
  composerTurnStatus,
  resolvedHostTurnStatus,
} from "@/stores/chats/chat-run-activity";
import type {
  ChatActiveTurn,
  ChatRunSettings,
  OpenChatQueuedPromptItem,
  OpenChatQueueState,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  AcceptedChatAction,
  PendingChatAction,
  PendingUserMessage,
  ChatSessionState,
} from "@/stores/chats/chat-session-store";
import {
  appendOptimisticQueuedItem,
  isOptimisticQueuedItem,
  optimisticQueuedItemId,
} from "@/stores/chats/optimistic-queue";
import { drainingQueuePrompt } from "@/lib/chat/draining-queue-item";

type PresentationSettings = Pick<
  ChatRunSettings,
  "harnessId" | "model" | "profileId" | "reasoningEffort" | "serviceTier"
>;

export interface PendingTurn {
  readonly messageId: string;
  readonly sentAt: number;
  /** Set at drain for a prompt that waited in the dock. */
  readonly timerOrigin?: number;
  readonly settings: ChatRunSettings;
}

/** Placement is about the next turn, never the chat's background activity. */
export function sendPlacement(
  state: Pick<
    ChatSessionState,
    "activeTurn" | "turnInProgress" | "queue" | "sendWouldQueue" | "pendingTurn"
  >,
): "transcript" | "queue" {
  // Local sends can be newer than the host's admission frame. Their custody
  // must take precedence until the host has placed or settled them.
  if (state.pendingTurn || state.queue.items.some(isOptimisticQueuedItem))
    return "queue";
  if (state.sendWouldQueue !== undefined) {
    return state.sendWouldQueue ? "queue" : "transcript";
  }
  return state.activeTurn !== null ||
    state.turnInProgress === true ||
    state.queue.items.length > 0
    ? "queue"
    : "transcript";
}

export interface TurnPresentation {
  readonly settings: PresentationSettings | null;
  readonly elapsedStartedAt: number;
  readonly verbSeed: string;
  readonly rowAnchorAt: number;
}

/** Shared by the placeholder, live row and active persisted turn. */
export function resolveTurnPresentation(input: {
  readonly chatId: string;
  readonly pendingTurn: PendingTurn | null;
  readonly activeTurn: ChatActiveTurn | null;
  readonly observedAt: number;
  readonly localMessageCreatedAt: number | null;
  readonly hostAnchorAt: number | null;
}): TurnPresentation {
  const { activeTurn, pendingTurn } = input;
  const ownsTurn =
    pendingTurn !== null &&
    (activeTurn === null || activeTurn.userMessageId === pendingTurn.messageId);
  const elapsedStartedAt = ownsTurn
    ? (pendingTurn.timerOrigin ?? pendingTurn.sentAt)
    : hostTurnOrigin(activeTurn, input.observedAt);
  return {
    settings: activeTurn ?? pendingTurn?.settings ?? null,
    elapsedStartedAt,
    verbSeed: `${input.chatId}:${presentationMessageId(activeTurn, pendingTurn)}`,
    rowAnchorAt: Math.max(
      input.hostAnchorAt ?? activeTurn?.startedAt ?? elapsedStartedAt,
      input.localMessageCreatedAt === null
        ? 0
        : input.localMessageCreatedAt + 1,
    ),
  };
}

function hostTurnOrigin(
  activeTurn: ChatActiveTurn | null,
  observedAt: number,
): number {
  return activeTurn?.startedAt ?? observedAt;
}

function presentationMessageId(
  active: ChatActiveTurn | null,
  pending: PendingTurn | null,
): string {
  return active?.userMessageId ?? pending?.messageId ?? active?.turnId ?? "";
}

const dockQueueCache = new WeakMap<
  OpenChatQueueState,
  WeakMap<ReadonlyArray<OpenChatQueuedPromptItem>, OpenChatQueueState>
>();

/** The display carry also stays charged to the queue's memory budget. */
export function queueWithDrainingPrompts(
  state: Pick<ChatSessionState, "queue" | "drainingQueueItems">,
): OpenChatQueueState {
  const held = state.drainingQueueItems;
  if (held === undefined || held.length === 0) return state.queue;
  let byHeld = dockQueueCache.get(state.queue);
  if (byHeld === undefined) {
    byHeld = new WeakMap();
    dockQueueCache.set(state.queue, byHeld);
  }
  const cached = byHeld.get(held);
  if (cached !== undefined) return cached;
  const queue = {
    ...state.queue,
    items: [...state.queue.items, ...held.map(drainingQueuePrompt)],
  };
  byHeld.set(held, queue);
  return queue;
}

type SendAction = PendingChatAction | AcceptedChatAction;
type TurnEvidence = NonNullable<ChatSessionState["pendingTurnEvidence"]>;
const SEND_STATE_KEYS: ReadonlyArray<keyof ChatSessionState> = [
  "pendingUserMessages",
  "pendingActions",
  "acceptedActions",
  "queue",
  "messages",
  "messageDelivery",
  "activeTurn",
  "turnInProgress",
  "pendingTurn",
  "heldStop",
  "hashOnlyRecoveries",
  "sendHostFrameRevision",
  "unplacedSendIds",
  "events",
  "sendWouldQueue",
  "runStatus",
  "backgroundItems",
  "fatalClose",
];

/** Fold local send identity alongside the existing custody reducers. */
export function reconcileSendState(
  previous: ChatSessionState,
  next: ChatSessionState,
): Partial<ChatSessionState> {
  if (SEND_STATE_KEYS.every((key) => previous[key] === next[key])) return {};
  // A terminal stream cannot finish an optimistic turn. Keep send custody for
  // recovery, but release its presentation and any Stop that cannot be sent.
  if (next.fatalClose !== null) {
    return {
      pendingTurn: null,
      pendingTurnEvidence: null,
      heldStop: null,
      queueTurnContinuity: false,
    };
  }
  return new SendStateReconciler(previous, next).reconcile();
}

class SendStateReconciler {
  private readonly previous: ChatSessionState;
  private readonly next: ChatSessionState;
  private readonly patch: Partial<ChatSessionState> = {};
  private readonly revision: number;
  private readonly hostFrame: boolean;
  private readonly actions: ReadonlyArray<SendAction>;
  private queue: ChatSessionState["queue"];
  private pendingUsers: ReadonlyArray<PendingUserMessage>;
  private savedMessageIds: ReadonlySet<string> | null = null;

  constructor(previous: ChatSessionState, next: ChatSessionState) {
    this.previous = previous;
    this.next = next;
    this.revision = next.sendHostFrameRevision ?? 0;
    this.hostFrame = this.revision !== (previous.sendHostFrameRevision ?? 0);
    this.queue = next.queue;
    this.pendingUsers = next.pendingUserMessages;
    this.actions = [
      ...Object.values(next.pendingActions),
      ...Object.values(next.acceptedActions),
    ];
  }

  reconcile(): Partial<ChatSessionState> {
    this.observeTurn();
    this.placeBufferedSends();
    this.retainDrainingPrompts();
    this.keepComposerAcrossDrain();
    this.reconcilePendingTurn();
    return this.patch;
  }

  private observeTurn(): void {
    const wasActive = hostTurnInProgress(this.previous);
    const active = hostTurnInProgress(this.next);
    // Older hosts can move straight from a named turn into the next turn's
    // activation gap without lowering turnInProgress between them.
    const previousTurnId = this.previous.activeTurn?.turnId;
    const changedTurn =
      previousTurnId !== undefined &&
      previousTurnId !== this.next.activeTurn?.turnId;
    if (active && (!wasActive || changedTurn))
      Object.assign(this.patch, { turnObservedAt: Date.now() });
  }

  private keepComposerAcrossDrain(): void {
    const wasActive = hostTurnInProgress(this.previous);
    const active = hostTurnInProgress(this.next);
    const carry =
      this.patch.drainingQueueItems ?? this.next.drainingQueueItems ?? [];
    const runnable =
      this.queue.status !== "paused" &&
      (this.queue.items.length > 0 || carry.length > 0);
    const justEnded = this.hostFrame && wasActive && !active;
    const continuity =
      !active &&
      runnable &&
      (justEnded || this.previous.queueTurnContinuity === true);
    if (continuity !== this.next.queueTurnContinuity)
      Object.assign(this.patch, { queueTurnContinuity: continuity });
  }

  private placeBufferedSends(): void {
    const ids = this.next.unplacedSendIds;
    if (!this.hostFrame || ids === undefined || ids.size === 0) return;
    if (this.next.transcriptBaselineEpoch !== this.next.connectionEpoch) return;
    const pendingTurn = this.next.pendingTurn;
    let placement = sendPlacement({
      ...this.next,
      // Buffered sends have only tentative transcript ownership. The fresh
      // baseline places the first one; the remaining sends follow it in FIFO.
      pendingTurn:
        pendingTurn && ids.has(pendingTurn.messageId) ? null : pendingTurn,
    });
    const docked = new Set<string>();
    for (const message of this.pendingUsers) {
      if (!ids.has(message.messageId)) continue;
      if (
        this.next.activeTurn?.userMessageId === message.messageId ||
        this.hasSavedRow(message.messageId)
      )
        continue;
      if (placement === "queue") {
        this.queue = appendOptimisticQueuedItem(
          this.queue,
          this.optimisticItem(message),
        );
        docked.add(message.messageId);
      }
      placement = "queue";
    }
    this.pendingUsers = this.pendingUsers.filter(
      (message) => !docked.has(message.messageId),
    );
    Object.assign(this.patch, {
      unplacedSendIds: new Set<string>(),
      queue: this.queue,
      pendingUserMessages: this.pendingUsers,
    });
  }

  private optimisticItem(
    message: PendingUserMessage,
  ): OpenChatQueuedPromptItem {
    return {
      kind: "prompt",
      queueItemId: optimisticQueuedItemId(message.clientActionId),
      messageId: message.messageId,
      message: {
        kind: "user",
        content: message.content,
        browserAnnotations: [...message.restore.browserAnnotations],
      },
      sender: message.sender,
      settings: message.settings,
      accountContext: message.accountContext,
      sentFromHostId:
        this.next.pendingActions[message.clientActionId]?.sentFromHostId ??
        null,
      delivery:
        message.deliveryPolicy === "after_safe_point"
          ? "same_turn"
          : "next_turn",
      status: "pending",
      targetTurnId: null,
      steerRequest: null,
      fallbackReason: null,
      createdAt: message.timestamp,
      updatedAt: message.timestamp,
    };
  }

  private hasSavedRow(messageId: string): boolean {
    if (this.savedMessageIds === null) {
      this.savedMessageIds = new Set(
        this.next.messages
          .filter((message) => message.role === "user")
          .map((message) => message.messageId),
      );
    }
    return this.savedMessageIds.has(messageId);
  }

  private newlySaved(messageId: string): boolean {
    if (this.next.messages === this.previous.messages) return false;
    return (
      this.hasSavedRow(messageId) &&
      !this.previous.messages.some((message) => message.messageId === messageId)
    );
  }

  private queued(messageId: string): boolean {
    return this.queue.items.some(
      (item) => item.kind === "prompt" && item.messageId === messageId,
    );
  }

  private withdrawn(messageId: string): boolean {
    return (
      this.next.messageDelivery?.state.phase === "withdrawn" &&
      this.next.messageDelivery.messageId === messageId
    );
  }

  private cancelled(item: OpenChatQueuedPromptItem): boolean {
    const previous = [
      ...Object.values(this.previous.pendingActions),
      ...Object.values(this.previous.acceptedActions),
    ];
    if (
      this.next.events.some(
        (event) =>
          event.type === "queue.cancelled" &&
          event.queueItemId === item.queueItemId,
      )
    )
      return true;
    return [...previous, ...this.actions].some(
      (action) =>
        action.action === "queueCancel" &&
        action.queueItemId === item.queueItemId,
    );
  }

  private sendActionExists(messageId: string): boolean {
    return this.actions.some(
      (action) => action.action === "send" && action.messageId === messageId,
    );
  }

  private retainDrainingPrompts(): void {
    if (
      this.queue === this.previous.queue &&
      this.next.messages === this.previous.messages &&
      this.next.messageDelivery === this.previous.messageDelivery &&
      this.next.events === this.previous.events
    )
      return;
    const retained = new Map(
      (this.previous.drainingQueueItems ?? []).map((item) => [
        item.messageId,
        item,
      ]),
    );
    for (const item of this.previous.queue.items) {
      if (
        item.kind !== "prompt" ||
        this.cancelled(item) ||
        this.queued(item.messageId)
      )
        continue;
      if (
        isOptimisticQueuedItem(item) &&
        !this.sendActionExists(item.messageId)
      )
        continue;
      retained.set(item.messageId, item);
    }
    const drainingQueueItems = [...retained.values()].filter(
      (item) =>
        !this.queued(item.messageId) &&
        !this.hasSavedRow(item.messageId) &&
        !this.withdrawn(item.messageId) &&
        !this.cancelled(item),
    );
    const current = this.next.drainingQueueItems ?? [];
    if (
      drainingQueueItems.length === current.length &&
      drainingQueueItems.every((item, index) => item === current[index])
    )
      return;
    Object.assign(this.patch, { drainingQueueItems });
  }

  private createPendingTurn(): PendingTurn | null {
    const local = this.pendingUsers.find(
      (message) =>
        !this.queued(message.messageId) &&
        !this.previous.pendingUserMessages.some(
          (old) => old.messageId === message.messageId,
        ),
    );
    if (local !== undefined)
      return {
        messageId: local.messageId,
        sentAt: local.timestamp,
        settings: local.settings,
      };
    const action = this.actions.find((candidate) =>
      this.actionWasPromoted(candidate),
    );
    if (
      action !== undefined &&
      action.messageId !== null &&
      action.settings !== null
    ) {
      return {
        messageId: action.messageId,
        sentAt:
          "createdAt" in action
            ? action.createdAt
            : (action.sentAt ?? action.acceptedAt),
        settings: action.settings,
        ...this.drainTimerOrigin(action.messageId),
      };
    }
    return this.pendingTurnFromQueue();
  }

  private actionWasPromoted(action: SendAction): boolean {
    if (
      action.action !== "send" ||
      action.messageId === null ||
      action.settings === null
    )
      return false;
    return (
      this.next.activeTurn?.userMessageId === action.messageId ||
      this.newlySaved(action.messageId)
    );
  }

  private pendingTurnFromQueue(): PendingTurn | null {
    const items = [
      ...this.previous.queue.items,
      ...(this.previous.drainingQueueItems ?? []),
    ];
    const item = items.find(
      (candidate) =>
        candidate.kind === "prompt" &&
        (this.next.activeTurn?.userMessageId === candidate.messageId ||
          this.newlySaved(candidate.messageId)),
    );
    if (item?.kind !== "prompt") return null;
    return {
      messageId: item.messageId,
      sentAt: item.createdAt,
      timerOrigin: Date.now(),
      settings: item.settings,
    };
  }

  private drainTimerOrigin(messageId: string): {
    readonly timerOrigin?: number;
  } {
    const items = [
      ...this.previous.queue.items,
      ...(this.previous.drainingQueueItems ?? []),
    ];
    return items.some(
      (item) => item.kind === "prompt" && item.messageId === messageId,
    )
      ? { timerOrigin: Date.now() }
      : {};
  }

  private reconcilePendingTurn(): void {
    let turn = this.next.pendingTurn ?? null;
    let evidence = this.next.pendingTurnEvidence ?? null;
    if (turn === null) {
      turn = this.createPendingTurn();
      if (turn !== null)
        evidence = {
          messageId: turn.messageId,
          turnSeen: false,
          savedRevision: null,
        };
    }
    if (turn !== null) {
      const seen = evidence?.messageId === turn.messageId ? evidence : null;
      if (this.pendingTurnEnded(turn, seen)) {
        turn = null;
        evidence = null;
      } else {
        evidence = this.observePendingTurn(turn, seen);
      }
    }
    if (turn !== this.next.pendingTurn)
      Object.assign(this.patch, { pendingTurn: turn });
    if (!sameEvidence(evidence, this.next.pendingTurnEvidence))
      Object.assign(this.patch, { pendingTurnEvidence: evidence });
    const held = this.next.heldStop;
    if (
      held &&
      turn?.messageId !== held.messageId &&
      !this.queued(held.messageId)
    ) {
      Object.assign(this.patch, { heldStop: null });
    }
  }

  private pendingTurnEnded(
    turn: PendingTurn,
    seen: TurnEvidence | null,
  ): boolean {
    const id = turn.messageId;
    if (this.withdrawn(id)) return true;
    const named = this.next.activeTurn?.userMessageId === id;
    if (named && isTerminalTurn(this.next.activeTurn)) return true;
    if (this.queued(id) && !named && !this.hasSavedRow(id)) return true;
    if (this.hostFrame && seen?.turnSeen === true && !named) return true;
    if (this.settledUnseen(id, seen, named)) return true;
    if (this.hasSavedRow(id) || this.sendActionExists(id)) return false;
    if (this.pendingUsers.some((message) => message.messageId === id))
      return false;
    return !Object.values(this.next.hashOnlyRecoveries).some(
      (recovery) => recovery.messageId === id,
    );
  }

  private settledUnseen(
    id: string,
    seen: TurnEvidence | null,
    named: boolean,
  ): boolean {
    if (!this.hostFrame || !this.hasSavedRow(id) || named || this.queued(id))
      return false;
    const snapshot = this.next.lastSendSnapshotRevision === this.revision;
    const savedPreviously =
      seen?.savedRevision !== undefined &&
      seen.savedRevision !== null &&
      this.revision > seen.savedRevision;
    if (!snapshot && !savedPreviously) return false;
    if (this.next.sendWouldQueue !== undefined) return true;
    if (this.next.activeTurn !== null) return false;
    if (this.next.turnInProgress !== undefined)
      return !this.next.turnInProgress;
    return !hostTurnInProgress(this.next);
  }

  private observePendingTurn(
    turn: PendingTurn,
    seen: TurnEvidence | null,
  ): TurnEvidence {
    return {
      messageId: turn.messageId,
      turnSeen:
        (seen?.turnSeen ?? false) ||
        this.next.activeTurn?.userMessageId === turn.messageId,
      savedRevision: this.hasSavedRow(turn.messageId)
        ? (seen?.savedRevision ?? this.revision)
        : null,
    };
  }
}

function isTerminalTurn(turn: ChatActiveTurn | null): boolean {
  if (turn === null) return false;
  return (
    turn.status === "completed" ||
    turn.status === "stopped" ||
    turn.status === "interrupted" ||
    turn.status === "errored"
  );
}

function sameEvidence(
  a: TurnEvidence | null,
  b: TurnEvidence | null | undefined,
): boolean {
  return (
    a?.messageId === b?.messageId &&
    a?.turnSeen === b?.turnSeen &&
    a?.savedRevision === b?.savedRevision
  );
}

function hostTurnInProgress(state: ChatSessionState): boolean {
  return (
    resolvedHostTurnStatus(state, composerTurnStatus(state.runStatus)) !== null
  );
}
