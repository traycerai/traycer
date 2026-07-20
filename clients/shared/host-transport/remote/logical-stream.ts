import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "../i-stream-session";
import type { QosClassValue } from "@traycer/protocol/host-transport/mux";

/**
 * A single logical subscribe stream multiplexed over the shared session — the
 * mux-backed counterpart to a local `WsStreamClient` `StreamSession`, exposing
 * the identical `IStreamSession` surface so the typed wrappers
 * (`TerminalStreamClient`, …) run byte-for-byte unchanged (transport-seam spike).
 *
 * Unlike the local session it owns NO socket, timers, or reconnect loop — those
 * live once at the `RemoteSession` and fan out to every stream (shared fate: one
 * drop reconnects ALL streams). This object is only the per-stream frame surface
 * plus its status projection.
 *
 * Fire-and-forget parity: `sendClientFrame` while the session is not ready drops
 * the frame on the floor (Y.js CRDT / the terminal action protocol reconcile
 * above the transport), exactly like the local `IStreamSession` contract.
 */

/** The session-side operations a logical stream needs (implemented by `RemoteSession`). */
export interface LogicalStreamPort {
  /** Enqueues a stream frame (envelope + optional binary) for this stream. */
  sendStreamFrame(
    streamId: number,
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void;
  /** Sends a logical close intent for this stream, then forgets it. */
  closeStream(streamId: number, reason: string): void;
}

export interface LogicalStreamInit {
  readonly streamId: number;
  readonly method: string;
  readonly params: unknown;
  /** On-wire negotiated subscribe version (recomputed at open against the host). */
  readonly schemaVersion: SchemaVersion;
  readonly qos: QosClassValue;
  readonly port: LogicalStreamPort;
}

export class LogicalStream implements IStreamSession {
  readonly streamId: number;
  readonly method: string;
  readonly params: unknown;
  readonly qos: QosClassValue;
  private schemaVersion: SchemaVersion;
  private readonly port: LogicalStreamPort;

  private serverFrameHandler: ServerFrameHandler | null = null;
  private statusHandler: StatusChangeHandler | null = null;
  private status: StreamConnectionStatus = "connecting";
  private disposed = false;

  constructor(init: LogicalStreamInit) {
    this.streamId = init.streamId;
    this.method = init.method;
    this.params = init.params;
    this.schemaVersion = init.schemaVersion;
    this.qos = init.qos;
    this.port = init.port;
  }

  // ---- IStreamSession ---------------------------------------------------- //

  sendClientFrame(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void {
    if (this.disposed || this.status !== "open") {
      return;
    }
    this.port.sendStreamFrame(this.streamId, envelope, binaryPayload);
  }

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverFrameHandler = handler;
  }

  onStatusChange(handler: StatusChangeHandler): void {
    this.statusHandler = handler;
  }

  close(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.port.closeStream(this.streamId, "closed-by-caller");
    this.transition("closed", { kind: "caller" });
  }

  // ---- Session-driven hooks --------------------------------------------- //

  /** The negotiated on-wire subscribe version for the current connection. */
  currentSchemaVersion(): SchemaVersion {
    return this.schemaVersion;
  }

  /** Updated by the session when a resume renegotiates the version. */
  updateSchemaVersion(version: SchemaVersion): void {
    this.schemaVersion = version;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  /** Delivers an inbound application stream frame to the consumer. */
  deliverServerFrame(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): boolean {
    if (this.disposed) {
      return false;
    }
    const handler = this.serverFrameHandler;
    if (handler === null) {
      return false;
    }
    handler(envelope, binaryPayload);
    this.transition("open", null);
    return true;
  }

  /** Projects the session-wide connection status onto this stream. */
  notifyStatus(
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ): void {
    if (this.disposed) {
      return;
    }
    if (status === "closed") {
      this.disposed = true;
    }
    this.transition(status, reason);
  }

  /** Terminal close driven by a host/stream fatal error. */
  goFatal(details: FatalErrorDetails): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.transition("closed", { kind: "fatalError", details });
  }

  private transition(
    next: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ): void {
    if (this.status === next && next !== "reconnecting") {
      return;
    }
    this.status = next;
    const handler = this.statusHandler;
    if (handler !== null) {
      handler(next, reason);
    }
  }
}
