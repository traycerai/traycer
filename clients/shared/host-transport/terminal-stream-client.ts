import {
  terminalSubscribeServerFrameSchema,
  terminalSubscribeServerFrameSchemaV14,
  terminalSubscribeServerFrameSchemaV15,
  type TerminalSubscribeClientFrameV17,
  type TerminalSubscribeServerFrame,
  type TerminalSubscribeServerFrameV14,
  type TerminalSubscribeServerFrameV15,
  type TerminalSubscribeViewer,
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
  | TerminalSubscribeServerFrame
  | TerminalSubscribeServerFrameV14
  | TerminalSubscribeServerFrameV15;

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
  /**
   * `terminal.subscribe@1.6` attachment intent this client opens with. Absent
   * ⇒ `presentation` (today's behavior). `cache` is an attachment with no
   * attention claim and no say in the grid's size. A `viewer` frame through
   * {@link TerminalStreamClient.sendAction} changes it afterwards.
   */
  readonly viewer?: TerminalSubscribeViewer;
  readonly callbacks: TerminalStreamCallbacks;
}

type TerminalViewerFrame = Extract<
  TerminalSubscribeClientFrameV17,
  { readonly kind: "viewer" }
>;

/**
 * Typed wrapper over `WsStreamClient` for a single host-owned terminal
 * session. The renderer attaches with its current cols/rows so the host's
 * effective-size recompute (`min` across attached presentation viewers) lands
 * before the `snapshot` frame is sent.
 */
export class TerminalStreamClient {
  private readonly session: IStreamSession;
  private readonly callbacks: TerminalStreamCallbacks;
  private closed: boolean;
  /**
   * The intent this attachment stands for now. Every wire subscribe reads it,
   * so a reconnect declares the current intent and never the one the client
   * was built with: re-declaring a stale `presentation` would let a view that
   * has since gone off screen size the grid until the next frame corrected it.
   */
  private viewer: TerminalSubscribeViewer;
  private status: StreamConnectionStatus;
  /**
   * A change of intent made while the stream was not open. The subscribe
   * already on the wire may predate it, so it is restated once the stream
   * opens.
   */
  private pendingViewerFrame: TerminalViewerFrame | null;

  constructor(options: TerminalStreamClientOptions) {
    this.callbacks = options.callbacks;
    this.closed = false;
    this.viewer = options.viewer ?? "presentation";
    this.status = "connecting";
    this.pendingViewerFrame = null;
    this.session = options.wsStreamClient.subscribeWithParamsProvider(
      "terminal.subscribe",
      () => ({
        sessionId: options.sessionId,
        cols: options.cols,
        rows: options.rows,
        viewer: this.viewer,
      }),
    );
    this.session.onServerFrame((envelope, binaryPayload) => {
      this.handleServerFrame(envelope, binaryPayload);
    });
    this.session.onStatusChange((status, reason) => {
      this.status = status;
      this.callbacks.onConnectionStatus(status, reason);
      // After the consumer's own open handling, which re-reports its size: a
      // view coming on screen must have its real grid on the host before it
      // starts counting toward the shared one.
      if (status === "open") this.flushPendingViewerFrame();
    });
  }

  /**
   * Sends one client frame. A `viewer` frame is also this client's standing
   * intent, so it is recorded whether or not it can be sent: it reaches the
   * wire only on an open stream whose host negotiated `@1.7`, and an older
   * host simply keeps the intent its open request carried.
   */
  sendAction(frame: TerminalSubscribeClientFrameV17): void {
    if (this.closed) return;
    if (frame.kind === "viewer") {
      this.viewer = frame.viewer;
      if (this.status !== "open") {
        this.pendingViewerFrame = frame;
        return;
      }
      this.pendingViewerFrame = null;
      this.sendViewerFrame(frame);
      return;
    }
    this.session.sendClientFrame(frame, null);
  }

  private flushPendingViewerFrame(): void {
    const frame = this.pendingViewerFrame;
    if (frame === null || this.closed) return;
    this.pendingViewerFrame = null;
    this.sendViewerFrame(frame);
  }

  private sendViewerFrame(frame: TerminalViewerFrame): void {
    const version = this.session.getNegotiatedSchemaVersion();
    if (version === null || version.major !== 1 || version.minor < 7) return;
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
    // THIS session's negotiated version: each terminal tab is its own
    // `terminal.subscribe` session, and the client-wide accessor answers for
    // whichever one reconciliation reached first. Parsing a frame at a sibling
    // tab's minor either strips fields this host did send or demands fields it
    // cannot.
    const version = this.session.getNegotiatedSchemaVersion();
    const parsed =
      version !== null && version.major === 1 && version.minor >= 5
        ? terminalSubscribeServerFrameSchemaV15.safeParse(envelope)
        : version !== null && version.major === 1 && version.minor >= 4
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
