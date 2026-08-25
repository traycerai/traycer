import {
  chatSubscribeLiveSchemaVersion,
  chatSubscribeServerFrameSchema,
  chatSubscribeSnapshotServerFrameShallowSchema,
  chatSubscribeSnapshotServerFrameShallowSchemaV16,
  type ChatSubscribeClientFrame,
  type ChatSubscribeServerFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  normalizeInterviewBlocksInShallowSnapshot,
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
}

export interface ChatStreamClientOptions {
  readonly wsStreamClient: IStreamClient<HostStreamRpcRegistry>;
  readonly epicId: string;
  readonly chatId: string;
  readonly callbacks: ChatStreamCallbacks;
}

/**
 * The oldest `chat.subscribe@1.x` minor whose server frames carry the LIVE
 * message/event SHAPE - i.e. every field the current types promise is present
 * on the wire, with no compatibility default needed to synthesize it.
 *
 * `1.6` is that floor: it shipped image support (`imageResolutions`, the
 * image-bearing `tool_call`) and the turn-tail anchor, and the only difference
 * between its serverFrame and the live `1.7` one is the harness enum, which
 * changes no field's presence. Raise this ONLY when a minor adds or removes a
 * FIELD, not when one merely widens an enum.
 */
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

  /**
   * Send an action, ENCODED for the line this session negotiated.
   *
   * Callers build the live frame and nothing else; the downgrade is applied
   * here, once, from the session's own negotiated version. Sending the live
   * frame verbatim and letting an older host's zod strip the fields it does
   * not know is not a downgrade mechanism - it is unknown-field parsing
   * standing in for negotiation, and it fails silently the first time a new
   * field is not merely ignorable. See `projectChatClientFrameForVersion` for
   * exactly what a pre-`1.7` peer receives.
   */
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

  /** Whether this session negotiated the current live schema line. */
  private isOnLiveShapedSchemaLine(): boolean {
    const version = this.session.getNegotiatedSchemaVersion();
    return (
      version !== null &&
      version.major === chatSubscribeLiveSchemaVersion.major &&
      version.minor === chatSubscribeLiveSchemaVersion.minor
    );
  }

  /**
   * Whether THIS session negotiated `chat.subscribe@1.6` - the one
   * down-negotiated line that keeps a shallow snapshot path.
   *
   * `1.6` is a SHIPPED line (`host-v1.2.0-rc.1`) and the first one with
   * full-chat-on-subscribe, so its snapshots are the multi-hundred-megabyte
   * ones. Opening `1.7` above it moved "the live line" but changed nothing
   * about what a `1.6` host sends, and dropping it to the generic deep parser
   * would impose seconds of render-thread CPU per snapshot on that whole
   * cohort for a change they cannot observe.
   */
  private isOnV16SchemaLine(): boolean {
    const version = this.session.getNegotiatedSchemaVersion();
    return version !== null && version.major === 1 && version.minor === 6;
  }

  private handleServerFrame(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void {
    if (binaryPayload !== null) return;
    if (envelope.kind === "snapshot" && this.isOnLiveShapedSchemaLine()) {
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
      // structural check skips them, so a 1.5 snapshot taken shallow would
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
    if (envelope.kind === "snapshot" && this.isOnV16SchemaLine()) {
      // Same trade for the shipped `1.6` line - see `isOnV16SchemaLine`. The
      // envelope is validated deeply against the FROZEN `1.6` shapes, so this
      // is exact rather than permissive; the histories stay structural.
      //
      // The one thing `1.6` genuinely lacks is interview settlement, and it
      // lives inside the arrays the shallow parse does not walk. The narrow
      // normalizer below supplies exactly those defaults - the deep schema's
      // job on this path - so consumers never read `undefined` through a type
      // that promises a value.
      const shallowV16 =
        chatSubscribeSnapshotServerFrameShallowSchemaV16.safeParse(envelope);
      if (shallowV16.success) {
        normalizeInterviewBlocksInShallowSnapshot(
          shallowV16.data.snapshot.chat.messages,
        );
        this.callbacks.onSnapshot(shallowV16.data);
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
      case "heldUpdatesChanged": {
        this.callbacks.onHeldUpdatesChanged(frame);
        return;
      }
      case "pong": {
        return;
      }
      default: {
        // Exhaustiveness check, matching `epic-stream-client`: adding a new
        // ChatSubscribeServerFrame kind to the Zod schema without wiring it
        // here is a compile-time error rather than a silent no-op that leaves
        // the renderer stale with no diagnostic. `heldUpdatesChanged` was added
        // without this arm present, so nothing would have caught the omission.
        const _exhaustive: never = frame;
        void _exhaustive;
        return;
      }
    }
  }
}
