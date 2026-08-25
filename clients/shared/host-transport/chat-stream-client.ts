import {
  chatSubscribeFullSnapshotSchemaVersion,
  chatSubscribeServerFrameSchema,
  chatSubscribeSnapshotServerFrameShallowSchema,
  chatSubscribeWindowedServerFrameSchema,
  type ChatSubscribeClientFrame,
  type ChatSubscribeServerFrame,
  type ChatSubscribeWindowedServerFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatLoadRangeRequest } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
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

  // ─── The windowed line (`chat.subscribe@1.7`) ─────────────────────────────
  //
  // REQUIRED, not optional, and that is the point. These fire only on a
  // negotiated windowed line, which no released peer has yet - so a consumer
  // that omitted them would compile today and, the day `chatSubscribeV17` is
  // registered, silently drop every hydration response and render a chat that
  // never fills in. A required member turns that into a compile error at the
  // one moment it can still be cheap to fix.

  /**
   * The BOUNDED snapshot. A different shape from `onSnapshot`'s, not a variant
   * of it: it has no `chat.messages`/`chat.events` at all, and it carries the
   * `transcriptEpoch` / `rowCount` / `tail` / `derived` the legacy one does
   * not. Kept as its own callback so the legacy consumer's type stays exact
   * rather than becoming a union both sides have to narrow.
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

  /**
   * Ask for a span of bodies. No-op off the windowed line.
   *
   * A READ, so it deliberately does not go through `sendAction`: it carries no
   * `clientActionId`, is never acked, and must not be gated on ownership - a
   * viewer scrolling a chat they do not own still has to hydrate what they are
   * looking at.
   */
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
   *
   * The recovery path for the cases where the client's own index cannot be
   * trusted - an epoch it never saw the `indexChanged` for, a `reindexed`
   * change, a skeleton that finished short. Those are the states where a
   * `loadRange` is exactly the wrong move, because it would seat bodies
   * against a coordinate space the client has already left.
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

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.session.close();
  }

  /**
   * Whether THIS session negotiated the windowed transcript line.
   *
   * Unlike its siblings above this is not a field-level capability gate - it
   * selects which UNION the incoming envelope is parsed against, so it cannot
   * be "try both". The two lines share the `snapshot` kind and disagree about
   * its shape, so a legacy snapshot fails the windowed parse and a windowed
   * one fails the legacy parse. Guessing wrong silently drops every snapshot.
   *
   * `>= 7` mirrors the host's `chatSubscribeSupportsWindowedTranscript` rather
   * than pinning `1.7` exactly, so the two sides state one rule. Note it can
   * only ever be true AT `1.7` in this build - negotiation picks the highest
   * minor both peers know, and this client knows no higher - so a future `1.8`
   * with its own union must revisit the parse below, not just this predicate.
   */
  private isOnWindowedLine(): boolean {
    const version = this.session.getNegotiatedSchemaVersion();
    return version !== null && version.major === 1 && version.minor >= 7;
  }

  /**
   * Dispatch one frame off the windowed line.
   *
   * The shared frames (`blockDelta`, `turnStateChanged`, the approval and
   * restore families, …) reach the SAME callbacks the legacy line uses,
   * because they are the same schemas - `chatSubscribeSharedServerFrameSchemas`
   * builds both unions' members. Only the five transcript frames are new, and
   * only the `snapshot` differs in shape between the lines.
   */
  private handleWindowedFrame(envelope: StreamFrameEnvelope): void {
    const parsed = chatSubscribeWindowedServerFrameSchema.safeParse(envelope);
    if (!parsed.success) return;
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
        // Same exhaustiveness contract the legacy switch below carries, and it
        // has to be its own: the two unions are siblings, so a kind added to
        // the windowed one is invisible to that check.
        const _exhaustive: never = frame;
        void _exhaustive;
        return;
      }
    }
  }

  /**
   * Whether THIS session negotiated exactly the newest FULL-SNAPSHOT
   * `chat.subscribe` line. Gates the shallow snapshot path: on any older line
   * the host sends pre-image shapes that only the deep parse's compatibility
   * defaults up-convert to the current `Message`/`ChatEvent` types, and on the
   * windowed line there is no embedded transcript to skip in the first place.
   */
  private isOnFullSnapshotSchemaLine(): boolean {
    const version = this.session.getNegotiatedSchemaVersion();
    return (
      version !== null &&
      version.major === chatSubscribeFullSnapshotSchemaVersion.major &&
      version.minor === chatSubscribeFullSnapshotSchemaVersion.minor
    );
  }

  private handleServerFrame(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void {
    if (binaryPayload !== null) return;
    // The line fork comes FIRST, before either legacy path. A windowed peer's
    // frames are a different union, and two of the kinds it can send
    // (`snapshot`, and the four transcript frames) either fail the legacy parse
    // or - worse - would take the shallow branch below, which exists to skip a
    // deep walk over transcript arrays a windowed snapshot does not have.
    if (this.isOnWindowedLine()) {
      this.handleWindowedFrame(envelope);
      return;
    }
    if (envelope.kind === "snapshot" && this.isOnFullSnapshotSchemaLine()) {
      // Snapshots are the one frame whose size scales with chat history
      // (10s-100s of MB under full-chat-on-subscribe); a deep zod parse over
      // the message/event histories is seconds of render-thread CPU per
      // snapshot. Envelope + every bounded field stay deep-validated; the two
      // history arrays are checked structurally - same trust domain as the
      // blockDelta frames that stream the identical content.
      //
      // FULL-SNAPSHOT-LINE ONLY: the deep schemas' compatibility defaults
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
