import {
  terminalSubscribeServerFrameSchema,
  terminalSubscribeServerFrameSchemaV14,
  type TerminalSubscribeClientFrame,
  type TerminalSubscribeServerFrame,
  type TerminalSubscribeServerFrameV14,
} from "@traycer/protocol/host/terminal/subscribe";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { IHostStreamClient } from "./host-stream-client";

/**
 * Typed handlers for a `terminal.subscribe` session. The renderer's terminal
 * store binds these so raw stream envelopes do not leak into React.
 *
 * `onSnapshot`/`onData` take the content as a separate `string | Uint8Array`
 * parameter rather than reading it off the frame: a `@1.2`+ connection
 * receives `binarySnapshot`/`binaryData` instead of `snapshot`/`data`, whose
 * payload arrives out-of-band as the paired binary WS frame rather than a
 * JSON string field (see `subscribe.ts`'s file-level doc comment). This
 * lets the store handle either encoding uniformly without knowing which
 * minor negotiated.
 */
type TerminalSubscribeServerFrameOnWire =
  TerminalSubscribeServerFrame | TerminalSubscribeServerFrameV14;

export interface TerminalStreamCallbacks {
  readonly onSnapshot: (
    frame: Extract<
      TerminalSubscribeServerFrameOnWire,
      { readonly kind: "snapshot" | "binarySnapshot" }
    >,
    scrollback: string | Uint8Array,
  ) => void;
  readonly onData: (
    frame: Extract<
      TerminalSubscribeServerFrameOnWire,
      { readonly kind: "data" | "binaryData" }
    >,
    chunk: string | Uint8Array,
  ) => void;
  readonly onResized: (
    frame: Extract<
      TerminalSubscribeServerFrameOnWire,
      { readonly kind: "resized" }
    >,
  ) => void;
  readonly onExit: (
    frame: Extract<
      TerminalSubscribeServerFrameOnWire,
      { readonly kind: "exit" }
    >,
  ) => void;
  readonly onActionAck: (
    frame: Extract<
      TerminalSubscribeServerFrameOnWire,
      { readonly kind: "actionAck" }
    >,
  ) => void;
  readonly onSessionUpdated: (
    frame: Extract<
      TerminalSubscribeServerFrameOnWire,
      { readonly kind: "sessionUpdated" }
    >,
  ) => void;
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface TerminalStreamClientOptions {
  readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
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
  private readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
  private readonly callbacks: TerminalStreamCallbacks;
  private closed: boolean;

  constructor(options: TerminalStreamClientOptions) {
    this.wsStreamClient = options.wsStreamClient;
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
    const version =
      this.wsStreamClient.getMethodSchemaVersion("terminal.subscribe");
    const parsed =
      version !== null && version.major === 1 && version.minor >= 4
        ? terminalSubscribeServerFrameSchemaV14.safeParse(envelope)
        : terminalSubscribeServerFrameSchema.safeParse(envelope);
    if (!parsed.success) {
      // Schema mismatch: a version-skewed host/client or a genuine wire bug.
      // Log the envelope kind and issue paths only - never `parsed.error` or
      // the raw envelope, which may carry user terminal content
      // (scrollback/chunk) inside whichever field failed to validate.
      const issuePaths = parsed.error.issues
        .map((issue) =>
          issue.path.length > 0 ? issue.path.join(".") : "(root)",
        )
        .join(", ");
      console.warn(
        `[stream] terminal.subscribe frame failed schema validation (kind=${envelope.kind}, issues=[${issuePaths}]); dropping frame`,
      );
      return;
    }
    const frame: TerminalSubscribeServerFrameOnWire = parsed.data;
    switch (frame.kind) {
      case "snapshot": {
        this.callbacks.onSnapshot(frame, frame.scrollback);
        return;
      }
      case "binarySnapshot": {
        if (binaryPayload === null) {
          // Protocol violation: `hasBinaryPayload: true` promises a paired
          // binary WS frame right behind this envelope (see subscribe.ts's
          // file-level doc comment). Losing it here means the transport's
          // envelope/binary-frame pairing broke somewhere below this class -
          // surface it rather than silently dropping the snapshot.
          console.warn(
            `[stream] binarySnapshot for terminal.subscribe (sessionId=${frame.sessionId}) arrived without its paired binary payload; dropping frame`,
          );
          return;
        }
        this.callbacks.onSnapshot(frame, binaryPayload);
        return;
      }
      case "data": {
        this.callbacks.onData(frame, frame.chunk);
        return;
      }
      case "binaryData": {
        if (binaryPayload === null) {
          // Same protocol violation as `binarySnapshot` above, for the live
          // data frame.
          console.warn(
            `[stream] binaryData for terminal.subscribe (sessionId=${frame.sessionId}) arrived without its paired binary payload; dropping frame`,
          );
          return;
        }
        this.callbacks.onData(frame, binaryPayload);
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
      case "sessionUpdated": {
        this.callbacks.onSessionUpdated(frame);
        return;
      }
      case "pong": {
        return;
      }
    }
  }
}
