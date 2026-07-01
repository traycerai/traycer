import {
  chatSubscribeServerFrameSchema,
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
import type { WsStreamClient } from "./ws-stream-client";

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
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface ChatStreamClientOptions {
  readonly wsStreamClient: WsStreamClient<HostStreamRpcRegistry>;
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

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.session.close();
  }

  private handleServerFrame(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void {
    if (binaryPayload !== null) return;
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
      case "pong": {
        return;
      }
    }
  }
}
