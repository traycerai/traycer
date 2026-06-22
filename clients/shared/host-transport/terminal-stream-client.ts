import {
  terminalSubscribeServerFrameSchema,
  type TerminalSubscribeClientFrame,
  type TerminalSubscribeServerFrame,
} from "@traycer/protocol/host/terminal/subscribe";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { WsStreamClient } from "./ws-stream-client";

/**
 * Typed handlers for a `terminal.subscribe@1.0` session. The renderer's
 * terminal store binds these so raw stream envelopes do not leak into React.
 */
export interface TerminalStreamCallbacks {
  readonly onSnapshot: (
    frame: Extract<TerminalSubscribeServerFrame, { readonly kind: "snapshot" }>,
  ) => void;
  readonly onData: (
    frame: Extract<TerminalSubscribeServerFrame, { readonly kind: "data" }>,
  ) => void;
  readonly onResized: (
    frame: Extract<TerminalSubscribeServerFrame, { readonly kind: "resized" }>,
  ) => void;
  readonly onExit: (
    frame: Extract<TerminalSubscribeServerFrame, { readonly kind: "exit" }>,
  ) => void;
  readonly onActionAck: (
    frame: Extract<
      TerminalSubscribeServerFrame,
      { readonly kind: "actionAck" }
    >,
  ) => void;
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface TerminalStreamClientOptions {
  readonly wsStreamClient: WsStreamClient<HostStreamRpcRegistry>;
  readonly sessionId: string;
  readonly cols: number;
  readonly rows: number;
  readonly callbacks: TerminalStreamCallbacks;
}

/**
 * Typed wrapper over `WsStreamClient` for a single host-owned terminal
 * session. The renderer attaches with its current cols/rows so the host's
 * effective-size recompute (`min` across attached clients) lands before the
 * `snapshot` frame is sent.
 */
export class TerminalStreamClient {
  private readonly session: IStreamSession;
  private readonly callbacks: TerminalStreamCallbacks;
  private closed: boolean;

  constructor(options: TerminalStreamClientOptions) {
    this.callbacks = options.callbacks;
    this.closed = false;
    this.session = options.wsStreamClient.subscribe("terminal.subscribe", {
      sessionId: options.sessionId,
      cols: options.cols,
      rows: options.rows,
    });
    this.session.onServerFrame((envelope, binaryPayload) => {
      this.handleServerFrame(envelope, binaryPayload);
    });
    this.session.onStatusChange((status, reason) => {
      this.callbacks.onConnectionStatus(status, reason);
    });
  }

  sendAction(frame: TerminalSubscribeClientFrame): void {
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
    const parsed = terminalSubscribeServerFrameSchema.safeParse(envelope);
    if (!parsed.success) {
      return;
    }
    const frame: TerminalSubscribeServerFrame = parsed.data;
    switch (frame.kind) {
      case "snapshot": {
        this.callbacks.onSnapshot(frame);
        return;
      }
      case "data": {
        this.callbacks.onData(frame);
        return;
      }
      case "resized": {
        this.callbacks.onResized(frame);
        return;
      }
      case "exit": {
        this.callbacks.onExit(frame);
        return;
      }
      case "actionAck": {
        this.callbacks.onActionAck(frame);
        return;
      }
      case "pong": {
        return;
      }
    }
  }
}
