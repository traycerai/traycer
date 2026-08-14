import {
  chatSubscribeLiveSchemaVersion,
  chatSubscribeServerFrameSchema,
  chatSubscribeSnapshotServerFrameShallowSchema,
  type ChatSubscribeClientFrame,
  type ChatSubscribeServerFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
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
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface ChatStreamClientOptions {
  readonly wsStreamClient: IStreamClient<HostStreamRpcRegistry>;
  readonly epicId: string;
  readonly chatId: string;
  readonly callbacks: ChatStreamCallbacks;
}

/**
 * Typed wrapper over `WsStreamClient` for a single host-owned GUI chat.
 *
 * Chat frames are text-only, so outbound action methods always send a null
 * binary payload. Every action is still modeled as the protocol's concrete
 * client-frame type so callers cannot accidentally send a partial frame.
 */
export class ChatStreamClient {
  private readonly session: IStreamSession;
  private readonly callbacks: ChatStreamCallbacks;
  private closed: boolean;

  constructor(options: ChatStreamClientOptions) {
    this.callbacks = options.callbacks;
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

  sendAction(frame: ChatSubscribeClientFrame): void {
    if (this.closed) return;
    this.session.sendClientFrame(frame, null);
  }

  /**
   * Whether the negotiated `chat.subscribe` protocol version understands the
   * `after_safe_point` explicit-steer delivery policy (minor >= 5, added with
   * same-turn steering). A new renderer paired with a released <=1.4 host must
   * degrade `Mod-Enter` to a plain queued send: that host predates steering and
   * would inject the message under whatever ordering/settings it does
   * understand. Read lazily from the handshake, mirroring
   * `TerminalStreamClient`'s per-frame version read.
   */
  sameTurnSteeringProtocolSupported(): boolean {
    // THIS session's negotiated version, not the client-wide one. Every open
    // chat tab is its own `chat.subscribe` session, and the client-wide
    // accessor reports whichever of them reconciliation reached first - so a
    // tab talking to a <=1.4 host could be told steering is supported because a
    // sibling tab negotiated 1.5. That gates a SEND, not a parse: the message
    // would be injected into a host that predates the ordering policy, which is
    // the exact failure this guard exists to prevent.
    const version = this.session.getNegotiatedSchemaVersion();
    return version !== null && version.major === 1 && version.minor >= 5;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.session.close();
  }

  /**
   * Whether THIS session negotiated exactly the live `chat.subscribe` line.
   * Gates the shallow snapshot path: on any other (older) line the host sends
   * pre-image shapes that only the deep parse's compatibility defaults
   * up-convert to the current `Message`/`ChatEvent` types.
   */
  private isOnLiveSchemaLine(): boolean {
    const version = this.session.getNegotiatedSchemaVersion();
    return (
      version !== null &&
      version.major === chatSubscribeLiveSchemaVersion.major &&
      version.minor === chatSubscribeLiveSchemaVersion.minor
    );
  }

  private handleServerFrame(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void {
    if (binaryPayload !== null) return;
    if (envelope.kind === "snapshot" && this.isOnLiveSchemaLine()) {
      // Snapshots are the one frame whose size scales with chat history
      // (10s-100s of MB under full-chat-on-subscribe); a deep zod parse over
      // the message/event histories is seconds of render-thread CPU per
      // snapshot. Envelope + every bounded field stay deep-validated; the two
      // history arrays are checked structurally - same trust domain as the
      // blockDelta frames that stream the identical content.
      //
      // LIVE-LINE ONLY: the deep schemas' compatibility defaults
      // (`imageResolutions: []`, `serviceTier: null`, ...) are what
      // up-convert a down-negotiated host's pre-image messages; the
      // structural check skips them, so a 1.6 snapshot taken shallow would
      // hand the GUI assistant messages missing fields it types as present
      // (`imageResolutions.map` throws). Down-negotiated hosts predate
      // full-chat-on-subscribe, so their snapshots are the small ones the
      // deep parse below always handled.
      const shallow =
        chatSubscribeSnapshotServerFrameShallowSchema.safeParse(envelope);
      if (shallow.success) {
        this.callbacks.onSnapshot(shallow.data);
      }
      return;
    }
    const parsed = chatSubscribeServerFrameSchema.safeParse(envelope);
    if (!parsed.success) {
      return;
    }

    const frame: ChatSubscribeServerFrame = parsed.data;
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
      case "pong": {
        return;
      }
    }
  }
}
