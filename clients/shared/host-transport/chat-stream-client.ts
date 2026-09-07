import {
  chatSubscribeFullSnapshotSchemaVersion,
  chatSubscribeServerFrameSchema,
  chatSubscribeSnapshotServerFrameShallowSchema,
  chatSubscribeSnapshotServerFrameShallowSchemaV16,
  chatSubscribeWindowedServerFrameSchema,
  type ChatSubscribeClientFrame,
  type ChatSubscribeServerFrame,
  type ChatSubscribeWindowedServerFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatLoadRangeRequest } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import {
  normalizeV16BrowserPayloadsInFrame,
  normalizeV16MessagesInShallowSnapshot,
  projectChatClientFrameForVersion,
  supportsInterviewSettlementActions,
  type ProjectedChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/chat-frame-compat";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { IStreamClient } from "./i-stream-client";

/**
 * Typed handlers for a `chat.subscribe@1.1` session. The GUI chat store binds
 * these directly into Zustand so raw stream envelopes do not leak into React.
 */
export interface ChatStreamCallbacks {
  readonly onSnapshot: (
    frame: Extract<ChatSubscribeServerFrame, { readonly kind: "snapshot" }>,
  ) => void;
  readonly onActionAck: (
    frame: Extract<ChatSubscribeServerFrame, { readonly kind: "actionAck" }>,
  ) => void;
  readonly onMessageAccepted: (
    frame: Extract<
      ChatSubscribeServerFrame,
      { readonly kind: "messageAccepted" }
    >,
  ) => void;
  readonly onQueueChanged: (
    frame: Extract<ChatSubscribeServerFrame, { readonly kind: "queueChanged" }>,
  ) => void;
  readonly onTurnStateChanged: (
    frame: Extract<
      ChatSubscribeServerFrame,
      { readonly kind: "turnStateChanged" }
    >,
  ) => void;
  readonly onBlockDelta: (
    frame: Extract<ChatSubscribeServerFrame, { readonly kind: "blockDelta" }>,
  ) => void;
  readonly onApprovalRequested: (
    frame: Extract<
      ChatSubscribeServerFrame,
      { readonly kind: "approvalRequested" }
    >,
  ) => void;
  readonly onApprovalResolved: (
    frame: Extract<
      ChatSubscribeServerFrame,
      { readonly kind: "approvalResolved" }
    >,
  ) => void;
  readonly onFileEditApprovalRequested: (
    frame: Extract<
      ChatSubscribeServerFrame,
      { readonly kind: "fileEditApprovalRequested" }
    >,
  ) => void;
  readonly onFileEditApprovalResolved: (
    frame: Extract<
      ChatSubscribeServerFrame,
      { readonly kind: "fileEditApprovalResolved" }
    >,
  ) => void;
  readonly onInterviewRequested: (
    frame: Extract<
      ChatSubscribeServerFrame,
      { readonly kind: "interviewRequested" }
    >,
  ) => void;
  readonly onInterviewAnswered: (
    frame: Extract<
      ChatSubscribeServerFrame,
      { readonly kind: "interviewAnswered" }
    >,
  ) => void;
  readonly onInterviewErrored: (
    frame: Extract<
      ChatSubscribeServerFrame,
      { readonly kind: "interviewErrored" }
    >,
  ) => void;
  readonly onEventAppended: (
    frame: Extract<
      ChatSubscribeServerFrame,
      { readonly kind: "eventAppended" }
    >,
  ) => void;
  readonly onRestoreStarted: (
    frame: Extract<
      ChatSubscribeServerFrame,
      { readonly kind: "restoreStarted" }
    >,
  ) => void;
  readonly onRestoreProgress: (
    frame: Extract<
      ChatSubscribeServerFrame,
      { readonly kind: "restoreProgress" }
    >,
  ) => void;
  readonly onRestoreCompleted: (
    frame: Extract<
      ChatSubscribeServerFrame,
      { readonly kind: "restoreCompleted" }
    >,
  ) => void;
  readonly onErrorNotice: (
    frame: Extract<ChatSubscribeServerFrame, { readonly kind: "errorNotice" }>,
  ) => void;
  readonly onWorktreeStateChanged: (
    frame: Extract<
      ChatSubscribeServerFrame,
      { readonly kind: "worktreeStateChanged" }
    >,
  ) => void;
  readonly onManagedCommandsChanged: (
    frame: Extract<
      ChatSubscribeServerFrame,
      { readonly kind: "managedCommandsChanged" }
    >,
  ) => void;
  readonly onHeldUpdatesChanged: (
    frame: Extract<
      ChatSubscribeServerFrame,
      { readonly kind: "heldUpdatesChanged" }
    >,
  ) => void;
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;

  // ─── The windowed line (`chat.subscribe@1.8`) ───────────────────────────── required, not optional, and that is the point.

  /**
   * The bounded snapshot.
   * A different shape from `onSnapshot`'s, not a variant of it: it has no `chat.messages`/`chat.events` at all, and it carries the `transcriptEpoch` / `rowCount` / `tail` / `derived` the legacy one does not.
   */
  readonly onWindowedSnapshot: (
    frame: Extract<
      ChatSubscribeWindowedServerFrame,
      { readonly kind: "snapshot" }
    >,
  ) => void;
  readonly onSkeletonChunk: (
    frame: Extract<
      ChatSubscribeWindowedServerFrame,
      { readonly kind: "skeletonChunk" }
    >,
  ) => void;
  readonly onIndexChanged: (
    frame: Extract<
      ChatSubscribeWindowedServerFrame,
      { readonly kind: "indexChanged" }
    >,
  ) => void;
  readonly onRange: (
    frame: Extract<
      ChatSubscribeWindowedServerFrame,
      { readonly kind: "range" }
    >,
  ) => void;
  readonly onAccumulatedChanges: (
    frame: Extract<
      ChatSubscribeWindowedServerFrame,
      { readonly kind: "accumulatedChanges" }
    >,
  ) => void;
}

/**
 * The `chat.subscribe` minor that introduced browser context attachments and
 * annotations on user messages. Anything below it cannot author them.
 */
const CHAT_SUBSCRIBE_BROWSER_PAYLOAD_MINOR = 7;

export interface ChatStreamClientOptions {
  readonly wsStreamClient: IStreamClient<HostStreamRpcRegistry>;
  readonly epicId: string;
  readonly chatId: string;
  readonly callbacks: ChatStreamCallbacks;
}

/**
 * Typed wrapper over `WsStreamClient` for a single host-owned gui chat.
 * Every action is still modeled as the protocol's concrete client-frame type so callers cannot accidentally send a partial frame.
 */
export class ChatStreamClient {
  private readonly session: IStreamSession;
  private readonly callbacks: ChatStreamCallbacks;
  private readonly epicId: string;
  private readonly chatId: string;
  private closed: boolean;

  constructor(options: ChatStreamClientOptions) {
    this.callbacks = options.callbacks;
    this.epicId = options.epicId;
    this.chatId = options.chatId;
    this.closed = false;
    this.session = options.wsStreamClient.subscribe("chat.subscribe", {
      epicId: options.epicId,
      chatId: options.chatId,
    });
    this.session.onServerFrame((envelope, binaryPayload) => {
      this.handleServerFrame(envelope, binaryPayload);
    });
    this.session.onStatusChange((status, reason) => {
      this.callbacks.onConnectionStatus(status, reason);
    });
  }

  /** Send an action, encoded for the line this session negotiated. */
  sendAction(frame: ChatSubscribeClientFrame): void {
    if (this.closed) return;
    let projected: ProjectedChatSubscribeClientFrame;
    try {
      projected = projectChatClientFrameForVersion(
        frame,
        this.session.getNegotiatedSchemaVersion(),
      );
    } catch {
      return;
    }
    this.session.sendClientFrame(projected, null);
  }

  /**
   * Whether the negotiated `chat.subscribe` protocol version understands the `after_safe_point` explicit-steer delivery policy (minor >= 5, added with same-turn steering).
   * A new renderer paired with a released <=1.4 host must degrade `Mod-Enter` to a plain queued send: that host predates steering and would inject the message under whatever ordering/settings it does understand.
   */
  sameTurnSteeringProtocolSupported(): boolean {
    // This session's negotiated version, not the client-wide one.
    // That gates a send, not a parse: the message would be injected into a host that predates the ordering policy, which is the exact failure this guard exists to prevent.
    const version = this.session.getNegotiatedSchemaVersion();
    return version !== null && version.major === 1 && version.minor >= 5;
  }

  /** Ask for a span of bodies. */
  requestTranscriptRange(request: ChatLoadRangeRequest): void {
    if (this.closed || !this.isOnWindowedLine()) return;
    this.session.sendClientFrame(
      {
        kind: "loadRange",
        hasBinaryPayload: false,
        epicId: this.epicId,
        chatId: this.chatId,
        request,
      },
      null,
    );
  }

  /**
   * Re-base from scratch: a fresh bounded snapshot and a fresh skeleton.
   * The recovery path for the cases where the client's own index cannot be trusted - an epoch it never saw the `indexChanged` for, a `reindexed` change, a skeleton that finished short.
   */
  requestResnapshot(): void {
    if (this.closed || !this.isOnWindowedLine()) return;
    this.session.sendClientFrame(
      {
        kind: "resnapshot",
        hasBinaryPayload: false,
        epicId: this.epicId,
        chatId: this.chatId,
      },
      null,
    );
  }

  /**
   * Whether this chat session can send the settled-interview owner actions
   * introduced on `chat.subscribe@1.7`.
   */
  interviewSettlementActionsProtocolSupported(): boolean {
    return supportsInterviewSettlementActions(
      this.session.getNegotiatedSchemaVersion(),
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.session.close();
  }

  /**
   * Whether this session negotiated the windowed transcript line.
   * Unlike its siblings above this is not a field-level capability gate - it selects which union the incoming envelope is parsed against, so it cannot be "try both".
   */
  private isOnWindowedLine(): boolean {
    const version = this.session.getNegotiatedSchemaVersion();
    return version !== null && version.major === 1 && version.minor >= 8;
  }

  /**
   * Dispatch one frame off the windowed line.
   * Only the five transcript frames are new, and only the `snapshot` differs in shape between the lines.
   */
  private handleWindowedFrame(envelope: StreamFrameEnvelope): void {
    const parsed = chatSubscribeWindowedServerFrameSchema.safeParse(envelope);
    if (!parsed.success) {
      // A fixed label, like every sibling call.
      // `envelope.kind` would name the frame, but it is unvalidated wire data and this reporter's whole rule is that nothing off the envelope reaches the log - the issue paths identify the frame shape without taking that trade.
      warnDroppedFrame("windowed frame", parsed.error.issues);
      return;
    }
    const frame: ChatSubscribeWindowedServerFrame = parsed.data;
    switch (frame.kind) {
      case "snapshot": {
        this.callbacks.onWindowedSnapshot(frame);
        return;
      }
      case "skeletonChunk": {
        this.callbacks.onSkeletonChunk(frame);
        return;
      }
      case "indexChanged": {
        this.callbacks.onIndexChanged(frame);
        return;
      }
      case "range": {
        this.callbacks.onRange(frame);
        return;
      }
      case "accumulatedChanges": {
        this.callbacks.onAccumulatedChanges(frame);
        return;
      }
      case "actionAck": {
        this.callbacks.onActionAck(frame);
        return;
      }
      case "messageAccepted": {
        this.callbacks.onMessageAccepted(frame);
        return;
      }
      case "queueChanged": {
        this.callbacks.onQueueChanged(frame);
        return;
      }
      case "turnStateChanged": {
        this.callbacks.onTurnStateChanged(frame);
        return;
      }
      case "blockDelta": {
        this.callbacks.onBlockDelta(frame);
        return;
      }
      case "approvalRequested": {
        this.callbacks.onApprovalRequested(frame);
        return;
      }
      case "approvalResolved": {
        this.callbacks.onApprovalResolved(frame);
        return;
      }
      case "fileEditApprovalRequested": {
        this.callbacks.onFileEditApprovalRequested(frame);
        return;
      }
      case "fileEditApprovalResolved": {
        this.callbacks.onFileEditApprovalResolved(frame);
        return;
      }
      case "interviewRequested": {
        this.callbacks.onInterviewRequested(frame);
        return;
      }
      case "interviewAnswered": {
        this.callbacks.onInterviewAnswered(frame);
        return;
      }
      case "interviewErrored": {
        this.callbacks.onInterviewErrored(frame);
        return;
      }
      case "eventAppended": {
        this.callbacks.onEventAppended(frame);
        return;
      }
      case "restoreStarted": {
        this.callbacks.onRestoreStarted(frame);
        return;
      }
      case "restoreProgress": {
        this.callbacks.onRestoreProgress(frame);
        return;
      }
      case "restoreCompleted": {
        this.callbacks.onRestoreCompleted(frame);
        return;
      }
      case "errorNotice": {
        this.callbacks.onErrorNotice(frame);
        return;
      }
      case "worktreeStateChanged": {
        this.callbacks.onWorktreeStateChanged(frame);
        return;
      }
      case "managedCommandsChanged": {
        this.callbacks.onManagedCommandsChanged(frame);
        return;
      }
      case "heldUpdatesChanged": {
        this.callbacks.onHeldUpdatesChanged(frame);
        return;
      }
      case "pong": {
        return;
      }
      default: {
        // Same exhaustiveness contract the legacy switch below carries, and it has to be its own: the two unions are siblings, so a kind added to the windowed one is invisible to that check.
        const _exhaustive: never = frame;
        void _exhaustive;
        return;
      }
    }
  }

  /** Whether this session negotiated exactly the newest full-snapshot `chat.subscribe` line. */
  private isOnFullSnapshotSchemaLine(): boolean {
    const version = this.session.getNegotiatedSchemaVersion();
    return (
      version !== null &&
      version.major === chatSubscribeFullSnapshotSchemaVersion.major &&
      version.minor === chatSubscribeFullSnapshotSchemaVersion.minor
    );
  }

  /**
   * Whether this session negotiated `chat.subscribe@1.6` - the one down-negotiated line that keeps a shallow snapshot path.
   */
  private isOnV16SchemaLine(): boolean {
    const version = this.session.getNegotiatedSchemaVersion();
    return version !== null && version.major === 1 && version.minor === 6;
  }

  /**
   * Whether this session negotiated any line below `1.7` - the minor that put browser context attachments and annotations on the wire.
   */
  private isOnPreAnnotationSchemaLine(): boolean {
    const version = this.session.getNegotiatedSchemaVersion();
    return (
      version !== null &&
      version.major === 1 &&
      version.minor < CHAT_SUBSCRIBE_BROWSER_PAYLOAD_MINOR
    );
  }

  private handleServerFrame(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void {
    if (binaryPayload !== null) return;
    // The line fork comes first, before either legacy path.
    if (this.isOnWindowedLine()) {
      this.handleWindowedFrame(envelope);
      return;
    }
    if (envelope.kind === "snapshot" && this.isOnFullSnapshotSchemaLine()) {
      // Snapshots are the one frame whose size scales with chat history (10s-100s of MB under full-chat-on-subscribe); a deep zod parse over the message/event histories is seconds of render-thread CPU per snapshot.
      const shallow =
        chatSubscribeSnapshotServerFrameShallowSchema.safeParse(envelope);
      if (shallow.success) {
        this.callbacks.onSnapshot(shallow.data);
      }
      return;
    }
    if (envelope.kind === "snapshot" && this.isOnV16SchemaLine()) {
      // Same trade for the shipped `1.6` line - see `isOnV16SchemaLine`.
      // The envelope is validated deeply against the frozen `1.6` shapes, so this is exact rather than permissive; the histories stay structural.
      const shallowV16 =
        chatSubscribeSnapshotServerFrameShallowSchemaV16.safeParse(envelope);
      if (shallowV16.success) {
        normalizeV16MessagesInShallowSnapshot(
          shallowV16.data.snapshot.chat.messages,
        );
        const upgraded =
          chatSubscribeSnapshotServerFrameShallowSchema.safeParse(
            shallowV16.data,
          );
        if (upgraded.success) {
          this.callbacks.onSnapshot(upgraded.data);
        } else {
          warnDroppedFrame("1.6 snapshot re-parse", upgraded.error.issues);
        }
      } else {
        warnDroppedFrame("1.6 snapshot", shallowV16.error.issues);
      }
      return;
    }
    const parsed = chatSubscribeServerFrameSchema.safeParse(envelope);
    if (!parsed.success) {
      warnDroppedFrame("live frame", parsed.error.issues);
      return;
    }

    const frame: ChatSubscribeServerFrame = parsed.data;
    if (this.isOnPreAnnotationSchemaLine()) {
      // Snapshots return above and are neutralized by their frozen parse; every other kind is untouched.
      normalizeV16BrowserPayloadsInFrame(frame);
    }
    switch (frame.kind) {
      case "snapshot": {
        this.callbacks.onSnapshot(frame);
        return;
      }
      case "actionAck": {
        this.callbacks.onActionAck(frame);
        return;
      }
      case "messageAccepted": {
        this.callbacks.onMessageAccepted(frame);
        return;
      }
      case "queueChanged": {
        this.callbacks.onQueueChanged(frame);
        return;
      }
      case "turnStateChanged": {
        this.callbacks.onTurnStateChanged(frame);
        return;
      }
      case "blockDelta": {
        this.callbacks.onBlockDelta(frame);
        return;
      }
      case "approvalRequested": {
        this.callbacks.onApprovalRequested(frame);
        return;
      }
      case "approvalResolved": {
        this.callbacks.onApprovalResolved(frame);
        return;
      }
      case "fileEditApprovalRequested": {
        this.callbacks.onFileEditApprovalRequested(frame);
        return;
      }
      case "fileEditApprovalResolved": {
        this.callbacks.onFileEditApprovalResolved(frame);
        return;
      }
      case "interviewRequested": {
        this.callbacks.onInterviewRequested(frame);
        return;
      }
      case "interviewAnswered": {
        this.callbacks.onInterviewAnswered(frame);
        return;
      }
      case "interviewErrored": {
        this.callbacks.onInterviewErrored(frame);
        return;
      }
      case "eventAppended": {
        this.callbacks.onEventAppended(frame);
        return;
      }
      case "restoreStarted": {
        this.callbacks.onRestoreStarted(frame);
        return;
      }
      case "restoreProgress": {
        this.callbacks.onRestoreProgress(frame);
        return;
      }
      case "restoreCompleted": {
        this.callbacks.onRestoreCompleted(frame);
        return;
      }
      case "errorNotice": {
        this.callbacks.onErrorNotice(frame);
        return;
      }
      case "worktreeStateChanged": {
        this.callbacks.onWorktreeStateChanged(frame);
        return;
      }
      case "managedCommandsChanged": {
        this.callbacks.onManagedCommandsChanged(frame);
        return;
      }
      case "heldUpdatesChanged": {
        this.callbacks.onHeldUpdatesChanged(frame);
        return;
      }
      case "pong": {
        return;
      }
      default: {
        // `heldUpdatesChanged` was added without this arm present, so nothing would have caught the omission.
        const _exhaustive: never = frame;
        void _exhaustive;
        return;
      }
    }
  }
}

/**
 * Warn-and-drop, matching the sibling stream clients: issue paths only, never
 * the raw error or envelope - chat frames carry prompt text and attachments.
 */
function warnDroppedFrame(
  what: string,
  issues: ReadonlyArray<{ readonly path: ReadonlyArray<PropertyKey> }>,
): void {
  const issuePaths = issues
    .map((issue) =>
      issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)",
    )
    .join(", ");
  console.warn(
    `[stream] chat.subscribe ${what} failed schema validation (issues=[${issuePaths}]); dropping frame`,
  );
}
